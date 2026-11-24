import { validDay } from "./model.ts";

export type ExcerptKind = "划线" | "微信读书评论" | "我的笔记";
export type ThoughtSource = "mix" | "note" | "review";
export type ExcerptKey = "read" | "idea";
export interface ReadingExcerpt {
  kind: ExcerptKind;
  text: string;
  title: string;
  stamp: string;
  bookId?: string;
  ref: { path: string; block?: string; section?: string };
}
export function bookTitle(value: string) {
  let title = value.trim();
  while (title.startsWith("《") && title.endsWith("》")) {
    let depth = 0,
      whole = true;
    for (let i = 0; i < title.length; i++) {
      if (title[i] === "《") depth++;
      if (title[i] === "》") depth--;
      if (depth <= 0 && i !== title.length - 1) {
        whole = false;
        break;
      }
    }
    if (!whole || depth !== 0) break;
    title = title.slice(1, -1).trim();
  }
  return title ? "《" + title + "》" : "";
}

const blockMark = /(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/;
const timestamp = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/;
function writtenAt(value: string) {
  const match = timestamp.exec(value);
  if (!match || !validDay(match[1])) return "";
  return (
    match[1] +
    (match[2] && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(match[2])
      ? " " + match[2]
      : "")
  );
}
export function readingText(value: string, omitIllustrations = false) {
  let text = value.replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]+\)/g, "");
  // WeRead puts a literal [插图] token inside the bookmark's link label.
  // Strip it before [[插图]] can be mistaken for an Obsidian wikilink.
  if (omitIllustrations) text = text.replace(/\[插图\](?!\()/g, "");
  return text
    .replace(
      /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g,
      (_m, path: string, alias?: string) => alias || path,
    )
    .replace(
      /\[([\s\S]*?)\]\(<[^>]+>\)|\[([^\]]*)\]\([^\s)]+\)/g,
      (_m, quoted?: string, simple?: string) => quoted || simple || "",
    )
    .replace(/(?:^|\s)\^[A-Za-z0-9-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The same personal comment can appear alongside its highlight and again in
// 读书笔记. Only the latter carries the comment's own timestamp and block ID.
export function parseReadingBook(
  raw: string,
  path: string,
  metadataTitle?: string,
): ReadingExcerpt[] {
  const rows: ReadingExcerpt[] = [];
  const frontmatter =
    /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)?.[1] ?? "";
  const savedTitle = /^title:\s*(.+?)\s*$/m
    .exec(frontmatter)?.[1]
    ?.replace(/^(["'])(.*)\1$/, "$2");
  const title = bookTitle(
    metadataTitle?.trim() ||
      savedTitle ||
      path.slice(path.lastIndexOf("/") + 1, -3),
  );
  let area = "",
    section = "",
    subtype = "",
    block = "",
    mode = "",
    lines: string[] = [];
  const reset = () => {
    block = "";
    mode = "";
    lines = [];
  };
  for (const source of raw.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(source);
    if (heading) {
      if (heading[1].length === 1) {
        area = heading[2];
        section = "";
        subtype = "";
      } else {
        section = heading[2];
        subtype = heading[1].length >= 3 ? section : "";
      }
      reset();
      continue;
    }
    if (!["高亮划线", "读书笔记", "本书评论"].includes(area)) continue;
    const line = source
      .trim()
      .replace(/^(?:>\s*)+/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    if (!line) continue;
    const id = blockMark.exec(line);
    if (id) block = id[1];
    const body = line.replace(blockMark, "").trim();
    if (body.startsWith("📌")) {
      block = id?.[1] ?? "";
      mode = area === "高亮划线" ? "highlight" : "";
      lines = mode ? [body.slice("📌".length).trim()] : [];
    } else if (body.startsWith("💭")) {
      if (area !== "高亮划线") {
        mode = "review";
        lines = [body.slice("💭".length).trim()];
      } else if (mode === "highlight") mode = "highlight-with-comment";
    } else if (body.startsWith("⏱")) {
      const stamp = writtenAt(body.replace(/^⏱\uFE0F?\s*/, ""));
      const text = readingText(lines.join(" "), area === "高亮划线");
      if (text)
        rows.push({
          kind: area === "高亮划线" ? "划线" : "微信读书评论",
          title,
          stamp,
          text,
          ref: { path, ...(block ? { block } : section ? { section } : {}) },
        });
      reset();
    } else if (mode === "highlight" || mode === "review") lines.push(body);
    else if (
      area === "本书评论" ||
      (area === "读书笔记" && subtype.startsWith("章节评论"))
    ) {
      mode = "review";
      lines.push(body);
    }
  }
  return rows;
}

export function parseThinking(raw: string, path: string): ReadingExcerpt[] {
  const noteTitle = path.split("/").at(-1)!.replace(/\.md$/i, "");
  const rows: ReadingExcerpt[] = [];
  const headings: { depth: number; title: string; stamp: string }[] = [];
  let buffer: string[] = [],
    fence = "",
    entryDate = "";
  const flush = () => {
    const paragraph = buffer;
    buffer = [];
    if (
      !paragraph.length ||
      (paragraph[0].trim().endsWith("：") &&
        paragraph.slice(1).some((line) => /^\s+/.test(line)))
    )
      return;
    const block = paragraph
      .map((line) => blockMark.exec(line)?.[1])
      .find(Boolean);
    const section = headings.at(-1)?.title;
    const first = paragraph[0].trim().replace(/^(?:[-*+]\s+|>\s*)/, "");
    const dated =
      /^(?:\[)?(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)(?:\])?(?=$|\s|[：:｜|])/.exec(
        first,
      );
    const stamp = dated ? writtenAt(dated[1]) : "";
    if (stamp) {
      paragraph[0] = first.slice(dated![0].length).replace(/^[\s：:｜|]+/, "");
      // A standalone date is a group label. A timestamp on a thought applies
      // only to that thought; it cannot date an unrelated paragraph.
      if (paragraph.every((line) => !line.trim())) entryDate = stamp;
    }
    const text = readingText(
      paragraph.map((line) => line.trim().replace(/^[-*>]\s+/, "")).join(" "),
    );
    if (text)
      rows.push({
        kind: "我的笔记",
        title: section ? noteTitle + " · " + section : noteTitle,
        text,
        stamp: stamp || entryDate || headings.at(-1)?.stamp || "",
        ref: { path, ...(block ? { block } : section ? { section } : {}) },
      });
  };
  const lines = raw
    .replace(/^\uFEFF?---[^\S\n]*\r?\n[\s\S]*?\r?\n---[^\S\n]*(?:\r?\n|$)/, "")
    .split(/\r?\n/);
  for (const line of lines) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence || delimiter.startsWith(fence)) {
        flush();
        fence = fence ? "" : delimiter;
      }
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      entryDate = "";
      while (headings.length && headings.at(-1)!.depth >= heading[1].length)
        headings.pop();
      headings.push({
        depth: heading[1].length,
        title: heading[2],
        stamp: writtenAt(heading[2]) || headings.at(-1)?.stamp || "",
      });
    } else if (!line.trim()) flush();
    else buffer.push(line);
  }
  flush();
  return rows;
}

export function selectExcerpts(
  rows: readonly ReadingExcerpt[],
  key: ExcerptKey,
  source: ThoughtSource = "mix",
) {
  return rows
    .filter((row) =>
      key === "read"
        ? row.kind === "划线"
        : row.kind !== "划线" &&
          (source === "mix" ||
            row.kind === (source === "note" ? "我的笔记" : "微信读书评论")),
    )
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}
