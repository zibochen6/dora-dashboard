import test from "node:test";
import assert from "node:assert/strict";
import { configFrom, renamed } from "../src/config.js";
import { parseTasks, changeCheckbox, matchTask } from "../src/model.ts";
import {
  dailyDraft, writeDailyBody,
  journalDraft,
  writeJournalDraft,
  journalEntries,
} from "../src/journal.ts";

test("empty install, opt-in modules and incremental settings migrations", () => {
  const fresh = configFrom(null);
  assert.deepEqual(fresh.visible, ["tasks", "projects", "habits", "journal"]);
  assert.equal(fresh.accounts.length, 0);
  assert.equal(fresh.projects.length, 0);
  assert.ok(Object.values(fresh.modules).every((v) => !v));
  const old = {
    version: 0,
    cards: ["tasks", "thoughts"],
    nickname: "River",
    root: "My studio",
    order: ["journal", "tasks"],
  };
  const migrated = configFrom(old);
  assert.deepEqual(migrated.visible, old.cards);
  assert.equal(migrated.nickname, "River");
  assert.equal(migrated.version, 2);
  assert.equal(migrated.root, old.root);
  assert.deepEqual(configFrom(migrated), migrated);
  assert.throws(() => configFrom({ version: 7 }), /Unsupported/);
});
test("renames follow vault-root notes, nested project bindings and custom pages", () => {
  const cfg = configFrom({
    sources: { inbox: "Inbox.md" },
    projects: [{ id: "p", name: "Field guide", path: "Work/List.md" }],
    pages: [
      {
        id: "page",
        title: "Library",
        widgets: [{ kind: "note", path: "Work/Ideas.md" }],
      },
    ],
  });
  assert.equal(renamed(cfg, "Inbox.md", "Today.md"), true);
  assert.equal(renamed(cfg, "Today.md", "Next.md"), true);
  assert.equal(cfg.sources.inbox, "Next.md");
  assert.equal(renamed(cfg, "Work", "Studio"), true);
  assert.equal(cfg.pages[0].widgets[0].path, "Studio/Ideas.md");
  assert.equal(cfg.projects[0].path, "Studio/List.md");
  assert.equal(renamed(cfg, "Other", "Unrelated"), false);
});
test("task labels omit hidden annotations and check only the intended source checkbox", () => {
  const raw = [
    "# Project",
    "<!--",
    "- [ ] Hidden draft",
    "-->",
    "~~~md",
    "- [ ] Code example",
    "~~~",
    "- [ ] Read more <!-- withheld --> %% private %% ^book",
    "",
  ].join("\r\n");
  const parsed = parseTasks(raw, "Inbox.md");
  assert.equal(parsed.ordered.length, 1);
  assert.equal(parsed.ordered[0].label, "Read more");
  assert.equal(
    changeCheckbox(parsed, parsed.ordered[0], true),
    raw.replace("[ ] Read more", "[x] Read more"),
  );
  const renamed = parseTasks(
    raw.replace("Read more", "Read another page"),
    "Inbox.md",
  );
  assert.equal(matchTask(renamed, parsed.ordered[0])?.block, "book");
});
test("monthly journal replaces one section, retains neighbors and rejects stale editors", () => {
  const raw =
    "## 2026-03-01\r\n\r\nFirst.\r\n\r\n## 2026-03-02\r\n\r\nSecond.\r\n";
  const draft = journalDraft(raw, "2026-03-01");
  const next = writeJournalDraft(raw, draft, "Updated.");
  assert.ok(next.includes("## 2026-03-02\r\n\r\nSecond.\r\n"));
  assert.equal(journalEntries(next, "2026-03").size, 2);
  assert.throws(() => writeJournalDraft(next, draft, "Concurrent overwrite"));
});

test("daily editor preserves properties, BOM and line endings, including an untouched file", () => {
  const prefix = "\uFEFF---\r\ntitle: River\r\n---\r\n";
  const raw = prefix + "# Heading\r\nA sentence.\r\n";
  assert.equal(dailyDraft(raw).text, "# Heading\nA sentence.\n");
  assert.equal(writeDailyBody(raw, dailyDraft(raw).text), raw);
  assert.equal(writeDailyBody(raw, "Two\nlines.\n"), prefix + "Two\r\nlines.\r\n");
  assert.equal(writeDailyBody(raw, ""), prefix);
  assert.equal(writeDailyBody("---\ntags: []\n---", "Hello"), "---\ntags: []\n---\nHello");
  assert.throws(() => dailyDraft("---\nbroken: true\n"), /properties/);
});
test("migrate a legacy goal once and keep each currency independent", () => {
  const cfg = configFrom({version:1, currency:"USD", financeGoal:"1200.00"});
  assert.deepEqual(cfg.financeGoals, {USD:"1200.00"});
  cfg.currency="CNY"; cfg.financeGoals.CNY="90.00";
  assert.deepEqual(configFrom(cfg).financeGoals, {CNY:"90.00", USD:"1200.00"});
});

test("only real document headings can create or replace monthly entries", () => {
  const blocks = [
    "    2026-11-23\n---",
    "<pre>\n## 2026-11-23\nExample.\n</pre>",
    "<div>\n## 2026-11-23\nAn HTML example.\n</div>",
    "> ## 2026-11-23",
    "- An item\n  ## 2026-11-23",
    "~~~md\n## 2026-11-23\n~~~",
    "%%\n~~~\n## 2026-11-23\n%%",
    "<!--\n## 2026-11-23\n-->",
  ];
  for (const block of blocks) {
    const raw = "## 2026-11-22\n\nFirst.\n\n" + block + "\n\nThe rest of the 22nd.\n\n## 2026-11-24\nLast.\n";
    assert.deepEqual([...journalEntries(raw,"2026-11").keys()], ["2026-11-22","2026-11-24"],block);
    const day = journalDraft(raw,"2026-11-23");
    assert.equal(day.original,null,block);
    assert.equal(writeJournalDraft(raw,day,""),raw);
    const next = writeJournalDraft(raw,day,"A real 23rd.");
    assert.ok(next.startsWith(raw),block);
    assert.equal(journalDraft(next,"2026-11-23").text,"A real 23rd.");
  }
});

test("literal comment markers cannot hide a genuine next day", () => {
  const formats = [
    (s) => "    " + s,
    (s) => "<pre>" + s + "</pre>",
    (s) => "> ~~~\n> " + s + "\n> ~~~",
    (s) => "- An item\n  ~~~\n  " + s + "\n  ~~~",
    (s) => "Text \x60\x60line one\nliteral " + s + "\x60\x60 end.",
    (s) => "Text with <code>" + s + "</code> here.",
  ];
  for (const literal of formats) for (const [open,close] of [["%%","%%"],["<!--","-->"]]) {
    for (const heading of ["## 2026-11-23","### [[2026-11-23]]"]) {
      const suffix = heading + "\n\nSecond day.\n\n" + literal(close) + "\n\nLast line.\n## 2026-11-24\nThird.\n";
      const raw = "## 2026-11-22\n\nFirst day.\n\n" + literal(open) + "\n\n" + suffix;
      const draft = journalDraft(raw,"2026-11-22");
      assert.ok(!draft.text.includes("Second day."),raw);
      assert.ok(writeJournalDraft(raw,draft,"").endsWith(suffix),raw);
      assert.ok(journalDraft(raw,"2026-11-23").text.includes("Second day."),raw);
    }
  }
});

test("annotated, nested and Setext dates bound exactly one journal entry", () => {
  for (const heading of ["## 2026-11-23 <!-- Monday -->", "### 2026-11-23 %% Monday %%", "2026-11-23\r\n---", "### [[2026-11-23]]", "### **2026-11-23**", "### 📅 2026-11-23", "### [[Journal/2026-11-23|Monday]]"]) {
    const neighbor = heading + "\r\n\r\nKeep this entire day.\r\n## 2026-11-24\r\nThird.\r\n";
    const raw = "## 2026-11-22\r\n\r\nFirst.\r\n\r\n" + neighbor;
    const opened = journalDraft(raw, "2026-11-22");
    assert.equal(opened.text, "First.");
    for (const body of ["", "New first day."])
      assert.ok(writeJournalDraft(raw, opened, body).endsWith(neighbor));
    assert.equal(journalDraft(raw, "2026-11-23").text, "Keep this entire day.");
  }
  const mixedBody = "One\r\nTwo\nThree\r\nFour\n";
  assert.equal(writeDailyBody(mixedBody, "One\nEdited\nThree\nFour\n"), "One\r\nEdited\nThree\r\nFour\n");
  const mixedMonth = "## 2026-11-22\r\n\n" + mixedBody + "\r\n## 2026-11-23\nNext.\n";
  assert.equal(writeJournalDraft(mixedMonth, journalDraft(mixedMonth,"2026-11-22"), "One\nEdited\nThree\nFour"), mixedMonth.replace("Two", "Edited"));
  const ambiguous = "## 2026-11-22\nFirst\n### Notes for 2026-11-23 and 2026-11-24\nKeep\n";
  assert.ok(writeJournalDraft(ambiguous,journalDraft(ambiguous,"2026-11-22"),"").endsWith("### Notes for 2026-11-23 and 2026-11-24\nKeep\n"));
  assert.throws(() => journalDraft(ambiguous,"2026-11-23"),/ambiguous/);
  const fenced = "## 2026-11-22\n\n~~~\n## 2026-11-23\n~~~\n";
  assert.equal(journalEntries(fenced,"2026-11").size,1);
  assert.throws(() => journalDraft("## 2026-11-22\n%%\n## 2026-11-23","2026-11-22"), /Close the open/);
});
