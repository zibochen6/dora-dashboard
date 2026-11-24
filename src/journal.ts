import { validDay } from "./model.ts";

export interface JournalEntry {
  date: string;
  section: string;
  written: boolean;
}

interface JournalSection extends JournalEntry {
  headingStart: number;
  bodyStart: number;
  bodyEnd: number;
}

export interface JournalDraft {
  date: string;
  section: string | null;
  original: string | null;
  text: string;
}

function journalSections(raw: string, month: string): JournalSection[] {
  const entries: JournalSection[] = [];
  let current: JournalSection | undefined;
  let level = 0;
  let fence = "";
  let frontmatter = /^\uFEFF?---\s*(?:\r?\n|$)/.test(raw);
  let comment = false;
  let htmlComment = false;
  const finish = (end: number) => {
    if (!current) return;
    current.bodyEnd = end;
    entries.push(current);
    current = undefined;
  };

  let offset = 0;
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const start = offset;
    const end = start + rawLine.length;
    offset =
      end +
      (raw.startsWith("\r\n", end) ? 2 : raw.startsWith("\n", end) ? 1 : 0);
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (frontmatter) {
      if (index > 0 && /^---\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const fenceMarker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMarker &&
        fenceMarker[1][0] === fence[0] &&
        fenceMarker[1].length >= fence.length
      )
        fence = "";
      else if (current && line.trim()) current.written = true;
      continue;
    }
    if (fenceMarker) {
      fence = fenceMarker[1];
      continue;
    }
    if (comment || htmlComment || /%%|<!--/.test(line)) {
      const prefix =
        !comment && !htmlComment ? line.split(/%%|<!--/, 1)[0] : "";
      if (current && prefix.trim()) current.written = true;
      for (const marker of line.match(/%%|<!--|-->/g) ?? []) {
        if (htmlComment) {
          if (marker === "-->") htmlComment = false;
        } else if (comment) {
          if (marker === "%%") comment = false;
        } else if (marker === "%%") comment = true;
        else if (marker === "<!--") htmlComment = true;
      }
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const section = heading[2].trim();
      const date = section.match(/^(\d{4}-\d{2}-\d{2})(?!\d)/)?.[1];
      if (
        heading[1].length <= 2 &&
        validDay(date) &&
        date.slice(0, 7) === month
      ) {
        finish(start);
        current = {
          date,
          section,
          written: false,
          headingStart: start,
          bodyStart: offset,
          bodyEnd: offset,
        };
        level = heading[1].length;
      } else if (heading[1].length <= level) finish(start);
      continue;
    }
    const content = line.trim();
    if (
      current &&
      content &&
      !/^([-*_])\1{2,}$/.test(content) &&
      !/^(?:[-+*]\s*(?:\[[ xX]\])?|\d+[.)])$/.test(content)
    )
      current.written = true;
  }
  finish(raw.length);
  return entries;
}

function selectedSections(raw: string, month: string) {
  const chosen = new Map<string, JournalSection>();
  for (const entry of journalSections(raw, month)) {
    const previous = chosen.get(entry.date);
    if (!previous || (!previous.written && entry.written))
      chosen.set(entry.date, entry);
  }
  return chosen;
}

export function journalEntries(
  raw: string,
  month: string,
): Map<string, JournalEntry> {
  return new Map(
    [...selectedSections(raw, month)].map(
      ([key, { date, section, written }]) => [key, { date, section, written }],
    ),
  );
}

/** Keep file properties and the byte-order mark outside the editable body. */
export function dailyDraft(raw: string) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = raw.slice(bom.length);
  let prefix = bom;
  if (/^---[ \t]*(?:\r?\n|$)/.test(content)) {
    const header = /^---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(content);
    if (!header || header.index !== 0) throw Error("Close the properties block in the source note first");
    prefix += header[0];
  }
  return { prefix, text: raw.slice(prefix.length).replace(/\r\n/g, "\n") };
}

export function writeDailyBody(raw: string, text: string) {
  const { prefix, text: previous } = dailyDraft(raw);
  if (text === previous) return raw;
  const eol = raw.match(/\r?\n/)?.[0] ?? "\n";
  const separator = prefix.endsWith("\n") || !prefix || prefix === "\uFEFF" || !text ? "" : eol;
  return prefix + separator + text.replace(/\r?\n/g, eol);
}

function editorText(body: string) {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

export function journalDraft(raw: string, date: string): JournalDraft {
  if (!validDay(date)) throw new Error("日期格式不正确。");
  const entry = selectedSections(raw, date.slice(0, 7)).get(date);
  const original = entry ? raw.slice(entry.bodyStart, entry.bodyEnd) : null;
  return {
    date,
    section: entry?.section ?? null,
    original,
    text: editorText(original ?? ""),
  };
}

// Compare the exact original section to avoid overwriting simultaneous edits.
export function writeJournalDraft(
  raw: string,
  draft: JournalDraft,
  value: string,
) {
  const { date } = draft;
  const current = journalDraft(raw, date);
  if (
    current.section !== draft.section ||
    current.original !== draft.original
  ) {
    throw new Error(
      "这一天的日记在别处被修改了。请复制未保存的文字，再从原日记查看最新内容。",
    );
  }
  const text = editorText(value);
  if (text === draft.text) return raw;
  if (
    journalSections(raw, date.slice(0, 7)).filter((row) => row.date === date)
      .length > 1
  ) {
    throw new Error("当天有多个日期段，请打开日记原文编辑。");
  }
  if (!current.section) raw = appendJournalDay(raw, date);
  const month = date.slice(0, 7);
  const entry = selectedSections(raw, month).get(date);
  if (!entry)
    throw new Error(
      "无法定位当天日记，请检查月记末尾是否有未闭合的代码块或注释。",
    );
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const prefix = raw.slice(0, entry.bodyStart);
  const body =
    (prefix.endsWith("\n") ? "" : eol) +
    eol +
    (text ? text.replace(/\n/g, eol) + eol + eol : "");
  const result = prefix + body + raw.slice(entry.bodyEnd);
  const replaced = journalSections(result, month).find(
    (row) => row.headingStart === entry.headingStart,
  );
  if (
    !replaced ||
    replaced.bodyEnd !== prefix.length + body.length ||
    editorText(result.slice(replaced.bodyStart, replaced.bodyEnd)) !== text
  ) {
    throw new Error(
      "请使用比当天日期更深的 Markdown 标题（例如 ###），以免覆盖其他日记段落。",
    );
  }
  return result;
}

export function appendJournalDay(raw: string, date: string) {
  if (!validDay(date)) throw new Error("日期格式不正确。");
  if (journalEntries(raw, date.slice(0, 7)).has(date)) return raw;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    raw.length === 0 || raw.endsWith(eol + eol)
      ? ""
      : raw.endsWith(eol)
        ? eol
        : eol + eol;
  return raw + separator + "## " + date + eol + eol;
}
