export interface Ref {
  path: string;
  id: string;
  count: number;
  label: string;
  section: string;
  block: string;
}
export interface Task extends Ref {
  titleMarkdown: string;
  segment: number;
  identity: string;
  done: boolean;
  ordinal: number;
  prefix: string;
}
export interface Parsed {
  segments: string[];
  ordered: Task[];
  byId: Map<string, Task>;
}
const taskPattern = /^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\][ \t]+)(.*)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function dayKey(date = new Date()) {
  const pad = (number: number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-");
}

export function validDay(date: unknown): date is string {
  if (typeof date !== "string" || !datePattern.test(date)) return false;
  const timestamp = Date.parse(date + "T00:00:00Z");
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date
  );
}

export function visiblePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path
      .split("/")
      .some(
        (part) =>
          !part || part.startsWith(".") || /[\\:\u0000-\u001f]/.test(part),
      )
  );
}

function visibleText(text: string) {
  return text
    .replace(/\s+\^[\w-]+\s*$/, "")
    .replace(
      /\[\[([^\]]+)\]\]/g,
      (_, link: string) => link.split("|").at(-1) ?? link,
    )
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\([\\`*_~\[\]{}<>!#|%])/g, "$1")
    .trim();
}

function blockTaskId(path: string, block: string) {
  return JSON.stringify(["block", path, block]);
}

// Preserve scheduling data, comments, and the existing Markdown block anchor.
function taskTitleParts(content: string) {
  let title = content.trimEnd();
  const metadata = /[ \t]+(?:\^[\w-]+|<!--(?:(?!-->)[^\r\n])*-->|%%(?:(?!%%)[^\r\n])*%%|(?:📅|⏳|🛫|➕|✅|❌)\ufe0f? \d{4}-\d{2}-\d{2}|[⏫🔼🔽⏬🔺])$/u;
  for (let match; (match = title.match(metadata));)
    title = title.slice(0, match.index);
  return { title, suffix: content.slice(title.length) };
}

export function renameTaskLine(parsed: Parsed, task: Task, input: string, block: string) {
  const title = input.trim();
  if (!title || /[\r\n]/.test(title)) throw Error("Enter a single-line task title");
  const item = parsed.segments[task.segment].match(taskPattern)!;
  const { suffix } = taskTitleParts(item[4]);
  if (/<!--|-->|%%/.test(task.titleMarkdown) || /<!--|-->|%%/.test(title) || taskTitleParts(title).suffix)
    throw Error("Edit inline comments and task markers in the source note");
  const endSpace = suffix.match(/[ \t]*$/)![0];
  const preserved = task.block
    ? suffix
    : suffix.slice(0, suffix.length - endSpace.length) + " ^" + block + endSpace;
  const segments = [...parsed.segments];
  segments[task.segment] = item[1] + item[2] + item[3] + title + preserved;
  const text = segments.join("");
  const matches = parseTasks(text, task.path).ordered.filter(row => row.block === block);
  const updated = matches[0];
  if (matches.length !== 1 || updated.segment !== task.segment || updated.section !== task.section || updated.titleMarkdown !== title)
    throw Error("The task title could not be saved. Check the Markdown format");
  return { text, task: updated };
}

// Blockless tasks retain the original identity and ordinal.
export function parseTasks(text: string, path: string): Parsed {
  const segments = text.split(/(\r?\n)/);
  const headings: { level: number; text: string }[] = [];
  const groups = new Map<string, Task[]>();
  const ordered: Task[] = [];
  let frontmatter = /^\uFEFF?---\s*$/.test(segments[0]);
  let commentEnd = "";
  let fence: string | undefined;
  for (let segment = 0; segment < segments.length; segment += 2) {
    const line = segments[segment];
    if (frontmatter) {
      if (segment && /^---\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.trim().slice(fenceMatch[1].length).trim() === ""
      )
        fence = undefined;
      continue;
    }
    // Parse the displayed title separately so checked edits preserve hidden annotations.
    // Do not promote an item inside a comment or a code example to a real task.
    const beganInComment = Boolean(commentEnd);
    let visible = "",
      pos = 0;
    while (pos < line.length) {
      if (commentEnd) {
        const end = line.indexOf(commentEnd, pos);
        if (end < 0) break;
        pos = end + commentEnd.length;
        commentEnd = "";
        continue;
      }
      const start = line.slice(pos).search(/<!--|%%/);
      if (start < 0) {
        visible += line.slice(pos);
        break;
      }
      visible += line.slice(pos, pos + start);
      pos += start;
      commentEnd = line.startsWith("<!--", pos) ? "-->" : "%%";
      pos += commentEnd === "-->" ? 4 : 2;
    }
    if (beganInComment || !visible.trim()) continue;
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const heading = visible.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level)
        headings.pop();
      headings.push({ level, text: heading[2] });
      continue;
    }
    const item = line.match(taskPattern);
    const shown = visible.match(taskPattern);
    if (!item || !shown || !visibleText(shown[4])) continue;
    const section = headings.at(-1)?.text ?? "";
    const identity = JSON.stringify([
      path,
      headings.map((h) => h.text),
      item[1] + item[3] + item[4].trimEnd(),
    ]);
    const group = groups.get(identity) ?? [];
    const task: Task = {
      path,
      section,
      segment,
      identity,
      id: JSON.stringify([identity, group.length]),
      count: 0,
      label: visibleText(shown[4]),
      titleMarkdown: taskTitleParts(item[4]).title,
      block: item[4].match(/\s\^([\w-]+)\s*$/)?.[1] ?? "",
      done: item[2].toLowerCase() === "x",
      ordinal: group.length,
      prefix: item[1],
    };
    group.push(task);
    groups.set(identity, group);
    ordered.push(task);
  }
  for (const group of groups.values()) {
    for (const task of group) task.count = group.length;
  }
  const blocks = new Map<string, number>();
  for (const task of ordered)
    if (task.block) blocks.set(task.block, (blocks.get(task.block) ?? 0) + 1);
  for (const task of ordered)
    if (task.block && blocks.get(task.block) === 1) {
      task.id = blockTaskId(path, task.block);
      task.count = 1;
    }
  return {
    segments,
    ordered,
    byId: new Map(ordered.map((task) => [task.id, task])),
  };
}

export function refOf({ path, id, count, label, section, block }: Task): Ref {
  return { path, id, count, label, section, block };
}

export function matchTask(parsed: Parsed, ref: Ref) {
  if (ref.block) {
    const matches = parsed.ordered.filter((task) => task.block === ref.block);
    return matches.length === 1 ? matches[0] : null;
  }
  const task = parsed.byId.get(ref.id);
  return task?.count === 1 && ref.count === 1 ? task : null;
}

export function changeCheckbox(parsed: Parsed, task: Task, checked: boolean) {
  const line = parsed.segments[task.segment];
  parsed.segments[task.segment] =
    line.slice(0, task.prefix.length) +
    (checked ? "x" : " ") +
    line.slice(task.prefix.length + 1);
  return parsed.segments.join("");
}
