import { parser as markdown } from "@lezer/markdown";
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
  const lines = raw.split(/\r?\n/);
  const offsets: number[] = [], positions: number[] = [], visible: string[] = [], syntax: string[] = [];
  let offset = 0, position = 0;
  let properties = /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(raw);
  let comment = "", fence = "";
  // Obsidian's %% comments are outside CommonMark. Mask them without moving a
  // character. Keep ordinary Markdown, including HTML blocks, for the parser.
  function scan(line: string) {
    const structure = line.split("");
    let text = "", from = 0;
    const markers = /<!--|%%|\x60+/g;
    while (from < line.length) {
      if (comment) {
        const close = line.indexOf(comment, from);
        const end = close < 0 ? line.length : close + comment.length;
        if (comment === "%%") structure.fill(" ", from, end);
        from = end;
        if (close >= 0) comment = "";
        continue;
      }
      markers.lastIndex = from;
      const found = markers.exec(line);
      if (!found) { text += line.slice(from); break; }
      text += line.slice(from, found.index);
      const marker = found[0];
      from = markers.lastIndex;
      if (marker.startsWith("\x60")) {
        const close = line.slice(from).match(new RegExp("(?<!\\x60)\\x60{" + marker.length + "}(?!\\x60)"));
        if (close) from += close.index! + marker.length;
        text += line.slice(found.index, from);
      } else if (/(?:^|[^\\])(?:\\\\)*\\$/.test(line.slice(0, found.index))) {
        text += marker;
      } else {
        comment = marker === "%%" ? "%%" : "-->";
        if (comment === "%%") structure.fill(" ", found.index, from);
        text += " ";
      }
    }
    return {source: structure.join(""), text};
  }
  for (const [index, rawLine] of lines.entries()) {
    const line = index === 0 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    offsets.push(offset);
    positions.push(position);
    offset += rawLine.length;
    offset += raw.startsWith("\r\n", offset) ? 2 : raw.startsWith("\n", offset) ? 1 : 0;
    let source = line, text = line;
    if (properties) {
      source = text = "";
      if (index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) properties = false;
    } else {
      const mark = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
      if (fence) {
        if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) {
          fence = ""; text = "";
        }
      } else if (!comment && mark) {
        fence = mark[1]; text = "";
      } else {
        ({source, text} = scan(line));
      }
    }
    syntax.push(source);
    visible.push(text);
    position += source.length + 1;
  }
  offsets.push(raw.length);
  positions.push(position);
  const tree = markdown.parse(syntax.join("\n"));
  const entries: JournalSection[] = [];
  let current: JournalSection | undefined;
  let level = 0, row = 0, firstBodyLine = 0;
  let openBlock = false;
  const finish = (line: number) => {
    if (!current) return;
    current.bodyEnd = offsets[line];
    current.written = visible.slice(firstBodyLine, line).some(value => {
      const text = value.trim();
      return !!text && !/^([-*_])\1{2,}$/.test(text) && !/^(?:[-+*]\s*(?:\[[ xX]\])?|\d+[.)])$/.test(text);
    });
    entries.push(current);
    current = undefined;
  };
  // Only document-level heading nodes bound entries. A heading-looking line
  // in a list, quotation, indented code or raw HTML is part of that block.
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "FencedCode" && (node.lastChild?.name !== "CodeMark" || node.firstChild?.from === node.lastChild?.from))
      openBlock = true;
    const heading = node.name.match(/^(ATX|Setext)Heading([1-6])$/);
    if (!heading) continue;
    while (row + 1 < lines.length && positions[row + 1] <= node.from) row++;
    const headingLine = row;
    while (row + 1 < lines.length && positions[row + 1] < node.to) row++;
    const section = (heading[1] === "ATX"
      ? visible[headingLine].replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, "").replace(/[ \t]+#+[ \t]*$/, "")
      : visible.slice(headingLine, row).join(" ")).trim();
    const nextLevel = Number(heading[2]);
    const dates = [...new Set(section.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? [])];
    const title = section.replace(/^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D*_~\x60[(【「『]+/u, "");
    const date = title.match(/^(?:[^\[\]()|#<>]*\/)?(\d{4}-\d{2}-\d{2})(?!\d)/)?.[1];
    if (dates.length && (!validDay(date) || dates.length !== 1)) {
      finish(headingLine);
      if (editingDay && dates.includes(editingDay)) throw Error("Open the original note to edit this ambiguous date heading");
    } else if (validDay(date)) {
      finish(headingLine);
      if (date.slice(0, 7) !== month) continue;
      firstBodyLine = row + 1;
      current = {date, section, written:false, headingStart:offsets[headingLine], bodyStart:offsets[firstBodyLine], bodyEnd:offsets[firstBodyLine]};
      level = nextLevel;
    } else if (nextLevel <= level) {
      finish(headingLine);
    }
  }
  if (editingDay && (properties || openBlock || comment)) throw Error("Close the open properties, code block or comment in the original journal");
  finish(lines.length);
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
