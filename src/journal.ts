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

function journalSections(raw: string, month: string, editingDay?: string): JournalSection[] {
  const entries: JournalSection[] = [];
  let current: JournalSection | undefined;
  let level = 0;
  let fence = "";
  let frontmatter = /^\uFEFF?---\s*(?:\r?\n|$)/.test(raw);
  let commentEnd = "";
  // Keep visible heading text on both sides of a comment. Code spans may contain
  // literal comment markers and fenced examples may contain date headings.
  function visibleLine(line: string) {
    let visible = "", at = 0;
    const markers = /<!--|%%|\x60+/g;
    while (at < line.length) {
      if (commentEnd) {
        const close = line.indexOf(commentEnd, at);
        if (close < 0) break;
        at = close + commentEnd.length;
        commentEnd = "";
        continue;
      }
      markers.lastIndex = at;
      const match = markers.exec(line);
      if (!match) return visible + line.slice(at);
      visible += line.slice(at, match.index);
      const marker = match[0];
      at = markers.lastIndex;
      if (marker.startsWith("\x60")) {
        const end = line.slice(at).match(new RegExp("(?<!\\x60)\\x60{" + marker.length + "}(?!\\x60)"));
        const next = end ? at + end.index! + marker.length : at;
        visible += line.slice(match.index, next);
        at = next;
      } else {
        if (/(?:^|[^\\])(?:\\\\)*\\$/.test(line.slice(0, match.index))) visible += marker;
        else { commentEnd = marker === "%%" ? "%%" : "-->"; visible += " "; }
      }
    }
    return visible;
  }
  const finish = (end: number) => {
    if (!current) return;
    current.bodyEnd = end;
    entries.push(current);
    current = undefined;
  };

  let offset = 0;
  const lines = raw.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const start = offset;
    const end = start + rawLine.length;
    offset =
      end +
      (raw.startsWith("\r\n", end) ? 2 : raw.startsWith("\n", end) ? 1 : 0);
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) frontmatter = false;
      continue;
    }
    const fenceMarker = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMarker &&
        fenceMarker[1][0] === fence[0] &&
        fenceMarker[1].length >= fence.length && !fenceMarker[2].trim()
      )
        fence = "";
      else if (current && line.trim()) current.written = true;
      continue;
    }
    if (!commentEnd && fenceMarker) {
      fence = fenceMarker[1];
      continue;
    }
    const visible = visibleLine(line);
    const heading = visible.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
    const underline = visible.trim() && !commentEnd && lines[index + 1]?.match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (heading || underline) {
      const section = (heading ? heading[2] ?? "" : visible).replace(/[ \t]+#+[ \t]*$/, "").trim();
      const nextLevel = heading ? heading[1].length : underline && underline[1][0] === "=" ? 1 : 2;
      const dates = [...new Set(section.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? [])];
      // Accept a date in ordinary Obsidian heading decorations and links.
      const title = section.replace(/^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D*_~\x60[(【「『]+/u, "");
      const date = title.match(/^(?:[^\[\]()|#<>]*\/)?(\d{4}-\d{2}-\d{2})(?!\d)/)?.[1];
      if (dates.length && (!validDay(date) || dates.length !== 1)) {
        finish(start);
        if (editingDay && dates.includes(editingDay)) throw Error("Open the original note to edit this ambiguous date heading");
        continue;
      }
      if (validDay(date)) {
        finish(start);
        if (date.slice(0, 7) !== month) continue;
        let bodyStart = offset;
        if (!heading) {
          bodyStart += lines[index + 1].length;
          bodyStart += raw.startsWith("\r\n", bodyStart) ? 2 : raw.startsWith("\n", bodyStart) ? 1 : 0;
        }
        current = { date, section, written: false, headingStart: start, bodyStart, bodyEnd: bodyStart };
        level = nextLevel;
      } else if (nextLevel <= level) finish(start);
      continue;
    }
    const content = visible.trim();
    if (
      current &&
      content &&
      !/^([-*_])\1{2,}$/.test(content) &&
      !/^(?:[-+*]\s*(?:\[[ xX]\])?|\d+[.)])$/.test(content)
    )
      current.written = true;
  }
  if (editingDay && (frontmatter || fence || commentEnd)) throw Error("Close the open properties, code block or comment in the original journal");
  finish(raw.length);
  return entries;
}

function selectedSections(raw: string, month: string, editingDay?: string) {
  const chosen = new Map<string, JournalSection>();
  for (const entry of journalSections(raw, month, editingDay)) {
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

// Textarea values use LF. Keep the source line endings on both sides of an edit.
function replaceBodyText(raw: string, value: string, fallback: string) {
  const previous = raw.split(/\r?\n/), next = value.replace(/\r\n/g, "\n").split("\n");
  const endings = raw.match(/\r?\n/g) ?? [];
  let left = 0, tail = 0;
  while (left < previous.length && left < next.length && previous[left] === next[left]) left++;
  while (tail < previous.length - left && tail < next.length - left &&
    previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return next.map((line, index) => {
    if (index === next.length - 1) return line;
    const previousIndex = index >= next.length - tail ? previous.length - (next.length - index) : index;
    return line + (endings[previousIndex] ?? endings[Math.max(0, left - 1)] ?? fallback);
  }).join("");
}

export function writeDailyBody(raw: string, text: string) {
  const { prefix, text: previous } = dailyDraft(raw);
  if (text === previous) return raw;
  const eol = raw.match(/\r?\n/)?.[0] ?? "\n";
  const separator = prefix.endsWith("\n") || !prefix || prefix === "\uFEFF" || !text ? "" : eol;
  return prefix + separator + replaceBodyText(raw.slice(prefix.length), text, eol);
}

function editorText(body: string) {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

export function journalDraft(raw: string, date: string): JournalDraft {
  if (!validDay(date)) throw new Error("日期格式不正确。");
  const entry = selectedSections(raw, date.slice(0, 7), date).get(date);
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
  const previous = raw.slice(entry.bodyStart, entry.bodyEnd);
  const leading = previous.match(/^(?:[ \t]*\r?\n)+/)?.[0] ?? "";
  const rest = previous.slice(leading.length);
  const trailing = rest.match(/(?:\r?\n[ \t]*)+$/)?.[0] ?? "";
  const middle = rest.slice(0, rest.length - trailing.length);
  const body = middle
    ? leading + replaceBodyText(middle, text, eol) + trailing
    : (prefix.endsWith("\n") ? "" : eol) + (leading || eol) +
      (text ? replaceBodyText("", text, eol) + eol + eol : "");
  const result = prefix + body + raw.slice(entry.bodyEnd);
  const replaced = journalSections(result, month, date).find(
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
