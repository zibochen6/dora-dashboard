import { TFile, TFolder, FileSystemAdapter } from "obsidian";
import { lstat } from "node:fs/promises";
import {
  visiblePath,
  dayKey,
  validDay,
  parseTasks,
  matchTask,
  changeCheckbox,
  renameTaskLine,
} from "./model.ts";
import {
  makeBlock,
  documentJson,
  readDocumentJson,
  replaceBlock,
} from "./documents.ts";
import { dailyDraft, writeDailyBody, journalDraft, writeJournalDraft, journalEntries } from "./journal.ts";

export function titleOf(path) {
  return path.split("/").at(-1).replace(/\.md$/i, "");
}
export const uniqueId = () => crypto.randomUUID();
export function join(root, name) {
  return root && root !== "/" ? root + "/" + name : name;
}
export function resolveSources(cfg) {
  return {
    ...cfg.sources,
    inbox: cfg.sources.inbox || join(cfg.root, "Inbox.md"),
    journal: cfg.sources.journal || join(cfg.root, "Journal"),
    finance: cfg.sources.finance || join(cfg.root, "Finance"),
    drafts: cfg.sources.drafts || join(cfg.root, "Drafts"),
    ideas: cfg.sources.ideas || join(cfg.root, "Ideas"),
  };
}
export class Notes {
  constructor(vault) {
    this.vault = vault;
    this.pending = Promise.resolve();
  }
  async guard(path) {
    if (!visiblePath(path)) throw Error("Choose a visible vault path");
    const adapter = this.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const parts = path.split("/");
    for (let n = 1; n <= parts.length; n++) {
      try {
        if (
          (
            await lstat(adapter.getFullPath(parts.slice(0, n).join("/")))
          ).isSymbolicLink()
        )
          throw Error("Choose a file inside this vault");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
    }
  }
  noteList(path) {
    if (!visiblePath(path) && path !== "/") return [];
    const first =
      path === "/"
        ? this.vault.getRoot()
        : this.vault.getAbstractFileByPath(path);
    const list = [];
    function scan(item) {
      if (!item || (!visiblePath(item.path) && item !== first)) return;
      if (item instanceof TFolder) {
        for (const child of item.children) scan(child);
      } else if (item instanceof TFile && item.extension.toLowerCase() === "md")
        list.push(item);
    }
    scan(first);
    return list.sort((a, b) => a.path.localeCompare(b.path));
  }
  async readOptional(path) {
    await this.guard(path);
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw Error("Expected a Markdown note");
    return this.vault.cachedRead(file);
  }
  updateDocument(path, edit) {
    const job = this.pending.then(async () => {
      await this.guard(path);
      if (!/\.md$/i.test(path)) throw Error("Choose a Markdown note");
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) return this.vault.process(existing, edit);
      if (existing) throw Error("A folder already uses this name");
      const next = edit(null);
      if (next == null) return null;
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !this.vault.getAbstractFileByPath(folder)) {
        try {
          await this.vault.createFolder(folder);
        } catch (e) {
          if (!(this.vault.getAbstractFileByPath(folder) instanceof TFolder))
            throw e;
        }
      }
      try {
        await this.vault.create(path, next);
        return next;
      } catch (e) {
        const raced = this.vault.getAbstractFileByPath(path);
        if (raced instanceof TFile) return this.vault.process(raced, edit);
        throw e;
      }
    });
    this.pending = job.catch(() => {});
    return job;
  }
  async tasks(path) {
    const raw = await this.readOptional(path);
    if (raw === null) return [];
    const parsed = parseTasks(raw, path),
      sourceFile = this.vault.getAbstractFileByPath(path);
    return parsed.ordered.map((row) => {
      const line = parsed.segments[row.segment];
      return {
        ...row,
        sourceFile,
        ...(row.count > 1 ? { snapshot: raw } : {}),
        label: row.label
          .replace(/\s*<!-- dora-(?:day:[\d-]+|milestone) -->/g, "")
          .trim(),
        day: line.match(/<!-- dora-day:(\d{4}-\d{2}-\d{2}) -->/)?.[1] ?? "",
        milestone:
          line.includes("<!-- dora-milestone -->") ||
          /^(?:milestones?|里程碑)$/i.test(row.section),
      };
    });
  }
  addTask(path, title, day = "", milestone = false) {
    const label = title
      .trim()
      .replace(/[\r\n]+/g, " ")
      .replace(/[<>]/g, (c) => (c === "<" ? "‹" : "›"));
    if (!label) throw Error("Enter a task");
    const id = "dora-" + uniqueId();
    let before, after, appended, file;
    return this.updateDocument(path, (raw) => {
      const text = raw ?? "",
        eol = text.includes("\r\n") ? "\r\n" : "\n";
      const next =
        text +
        (text && !text.endsWith("\n") ? eol : "") +
        "- [ ] " +
        label +
        (day ? " <!-- dora-day:" + day + " -->" : "") +
        (milestone ? " <!-- dora-milestone -->" : "") +
        " ^" +
        id +
        eol;
      if (!parseTasks(next, path).ordered.some((row) => row.block === id))
        throw Error("Close the code block or comment at the end of this note");
      before = text;
      after = next;
      appended = parseTasks(next, path).ordered.find(row => row.block === id);
      return next;
    }).then(() => {
      file = this.vault.getAbstractFileByPath(path);
      const line = parseTasks(after, path).segments[appended.segment];
      return () => this.updateDocument(file?.path ?? path, raw => {
        if (!file || this.vault.getAbstractFileByPath(file.path) !== file || raw === null)
          throw Error("Source note is missing");
        if (raw === after) return before;
        const parsed = parseTasks(raw, path);
        const current = matchTask(parsed, appended);
        if (!current || parsed.segments[current.segment] !== line) throw Error("Task changed. Reopen the source note");
        parsed.segments.splice(current.segment, 2);
        return parsed.segments.join("");
      });
    });
  }
  async changeTask(ref, kind, value) {
    const file = ref.sourceFile;
    const path = file?.path ?? ref.path;
    let updated, before, after, saved;
    await this.updateDocument(path, raw => {
      if (raw === null || (file && this.vault.getAbstractFileByPath(path) !== file)) throw Error("Source note is missing");
      const parsed = parseTasks(raw, ref.path);
      const task = matchTask(parsed, ref) ?? (ref.snapshot === raw ? parsed.byId.get(ref.id) : null);
      if (!task || task.done !== ref.done || task.titleMarkdown !== ref.titleMarkdown) throw Error("Task changed. Reopen the source note");
      before = parsed.segments[task.segment];
      const day = before.match(/<!-- dora-day:([\d-]+) -->/)?.[1] ?? "";
      if (kind === "done") saved = changeCheckbox(parsed, task, value);
      else if (kind === "title") saved = renameTaskLine(parsed, task, value, task.block || "dora-" + uniqueId()).text;
      else {
        if (day !== ref.day) throw Error("Task changed. Reopen the source note");
        const block = task.block || "dora-" + uniqueId();
        parsed.segments[task.segment] = before.replace(/\s*\^[\w-]+\s*$/, "")
          .replace(/\s*<!-- dora-day:[\d-]+ -->/g, "").trimEnd() +
          (value ? " <!-- dora-day:" + value + " -->" : "") + " ^" + block;
        saved = parsed.segments.join("");
      }
      const result = parseTasks(saved, ref.path);
      updated = result.ordered.find(row => row.segment === task.segment);
      after = result.segments[task.segment];
      return saved;
    });
    return () => this.updateDocument(file?.path ?? path, raw => {
      if (raw === null || (file && this.vault.getAbstractFileByPath(file.path) !== file)) throw Error("Source note is missing");
      const parsed = parseTasks(raw, ref.path);
      const current = matchTask(parsed, updated) ?? (raw === saved ? parsed.byId.get(updated.id) : null);
      if (!current || parsed.segments[current.segment] !== after) throw Error("Task changed. Reopen the source note");
      parsed.segments[current.segment] = before;
      return parsed.segments.join("");
    });
  }
  async habits(root) {
    const raw = await this.readOptional(join(root, "Habits.md"));
    return parseHabits(raw);
  }
  editHabits(root, change) {
    return this.updateDocument(join(root, "Habits.md"), (raw) => {
      const data = parseHabits(raw);
      change(data);
      const block = documentJson(data);
      return raw == null
        ? "# Habits\n\n" + makeBlock("habits", block) + "\n"
        : replaceBlock(raw, "habits", block);
    });
  }
  journalPath(cfg, day) {
    if (!validDay(day)) throw Error("Invalid date");
    return join(
      resolveSources(cfg).journal,
      cfg.journalMode === "monthly"
        ? day.slice(0, 4) + "/" + day.slice(0, 7) + ".md"
        : day + ".md",
    );
  }
  async diary(cfg, day) {
    const path = this.journalPath(cfg, day),
      original = await this.readOptional(path);
    const draft =
      cfg.journalMode === "monthly" ? journalDraft(original ?? "", day) : null;
    return {
      path,
      original,
      draft,
      text: draft ? draft.text : dailyDraft(original ?? "").text,
      file: this.vault.getAbstractFileByPath(path),
    };
  }
  saveDiary(opened, text, allowClear = false) {
    if (text === opened.text || (!text.trim() && opened.original === null)) return Promise.resolve();
    if (opened.text.trim() && !text.trim() && !allowClear) throw Error("Confirm clearing this entry");
    return this.updateDocument(opened.path, (raw) => {
      if (opened.file && this.vault.getAbstractFileByPath(opened.path) !== opened.file)
        throw Error("This journal changed elsewhere. Keep your draft and reopen it");
      if (opened.draft) {
        if (raw === null && opened.original !== null) throw Error("This journal changed elsewhere. Keep your draft and reopen it");
        return writeJournalDraft(raw ?? "", opened.draft, text);
      }
      if (raw !== opened.original) throw Error("This journal changed elsewhere. Keep your draft and reopen it");
      return writeDailyBody(raw ?? "", text);
    });
  }
  journalModes(folder) {
    const node = folder === "/" ? this.vault.getRoot() : this.vault.getAbstractFileByPath(folder);
    const modes = new Set();
    for (const item of node?.children ?? []) {
      if (item instanceof TFile && item.extension === "md" && validDay(item.basename)) modes.add("daily");
      if (item instanceof TFolder && /^\d{4}$/.test(item.name) &&
          item.children.some(file => file instanceof TFile && file.extension === "md" &&
            file.basename.startsWith(item.name + "-") && validDay(file.basename + "-01"))) modes.add("monthly");
    }
    return [...modes];
  }
  async journalDays(cfg, days, visible = () => true) {
    const result = new Set(),
      paths = new Map();
    for (const day of days) paths.set(this.journalPath(cfg, day), day);
    for (const [path, day] of paths) {
      if (!visible()) break;
      if (!this.vault.getAbstractFileByPath(path)) continue;
      const raw = await this.readOptional(path);
      if (cfg.journalMode === "monthly") {
        for (const e of journalEntries(raw ?? "", day.slice(0, 7)).values())
          if (e.written) result.add(e.date);
      } else if (raw) {
        try { if (dailyDraft(raw).text.trim()) result.add(day); }
        catch { result.add(day); } // Keep the date accessible for repairs in the original note.
      }
    }
    return result;
  }
}
function parseHabits(raw) {
  if (raw === null) return { version: 1, items: [] };
  const data = readDocumentJson(raw, "habits");
  if (
    data?.version !== 1 ||
    !Array.isArray(data.items) ||
    data.items.some(
      (h) =>
        !h?.id ||
        typeof h.name !== "string" ||
        !Array.isArray(h.days) ||
        !Array.isArray(h.checks),
    )
  )
    throw Error("Invalid habit note");
  return data;
}
export function recentDays(count, today = new Date()) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - count + 1 + i);
    return dayKey(d);
  });
}
