// Managed blocks leave the surrounding Markdown and its line endings intact.
function block(raw: string, name: string) {
  const open = "<!-- dora:" + name + " -->";
  const close = "<!-- /dora:" + name + " -->";
  const lines = raw.matchAll(/^(.*)(?:\r?\n|$)/gm);
  let start = -1,
    end = -1;
  for (const match of lines) {
    if (match[1] === open) {
      if (start !== -1) throw new Error("看板记录包含重复区块。");
      start = match.index + match[0].length;
    }
    if (match[1] === close) {
      if (start === -1 || end !== -1) throw new Error("看板记录区块不完整。");
      end = match.index;
    }
  }
  if (start === -1 || end < start) throw new Error("看板记录区块不完整。");
  return { start, end, eol: raw.includes("\r\n") ? "\r\n" : "\n" };
}
export function readBlock(raw: string, name: string) {
  const { start, end } = block(raw, name);
  return raw.slice(start, end).replace(/\r?\n$/, "");
}
export function makeBlock(name: string, text: string) {
  return (
    "<!-- dora:" + name + " -->\n" + text + "\n<!-- /dora:" + name + " -->"
  );
}
export function replaceBlock(raw: string, name: string, text: string) {
  const { start, end, eol } = block(raw, name);
  const next =
    raw.slice(0, start) + text.replace(/\r?\n/g, eol) + eol + raw.slice(end);
  if (readBlock(next, name) !== text.replace(/\r?\n/g, eol))
    throw new Error("文字中包含看板保留的标记。");
  return next;
}
export function documentJson(value: unknown) {
  return "~~~json\n" + JSON.stringify(value, null, 2) + "\n~~~";
}
export function readDocumentJson(raw: string, name: string): unknown {
  const text = readBlock(raw, name);
  const match = /^~~~json\r?\n([\s\S]+)\r?\n~~~$/.exec(text);
  if (match)
    try {
      return JSON.parse(match[1]);
    } catch {
      /* Use the same recoverable error. */
    }
  throw new Error("有一份看板记录无法解析，请检查原文。");
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
