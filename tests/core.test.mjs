import test from "node:test";
import assert from "node:assert/strict";
import { configFrom, renamed } from "../src/config.js";
import { parseTasks, changeCheckbox, matchTask } from "../src/model.ts";
import {
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
  assert.equal(migrated.version, 1);
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
