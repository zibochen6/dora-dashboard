import { createHmac } from "node:crypto";
import {
  documentJson,
  makeBlock,
  object,
  readDocumentJson,
  replaceBlock,
} from "./documents.ts";
import { validDay } from "./model.ts";
import { bookTitle, type ReadingExcerpt } from "./reading.ts";

export function wereadCacheFolder(
  root: string,
  ref: string,
  key: string | null,
) {
  if (!ref || !key) return "";
  // The provider does not return an account identifier. Rotated credentials
  // start a separate cache, including when an existing secret reference is reused.
  const scope = createHmac("sha256", key)
    .update("Dora Dashboard / WeRead cache / " + ref)
    .digest("hex")
    .slice(0, 32);
  return root + "/WeRead/" + scope;
}

export interface WereadEntry {
  id: string;
  text: string;
  stamp: string;
  kind: "highlight" | "review";
}
export interface WereadBook {
  id: string;
  title: string;
  sort: number;
  notes: number;
  reviews: number;
  entries: WereadEntry[];
}

export const safeWereadId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id);
export const wereadScopePath = (folder: string) => folder + "/sync-scope.md";
export function wereadPath(folder: string, id: string) {
  if (!safeWereadId(id)) throw new Error("Invalid WeRead book identifier.");
  return folder + "/book-" + id + ".md";
}
export function isWereadBookPath(path: string, folder: string) {
  if (!path.startsWith(folder + "/book-") || !path.endsWith(".md"))
    return false;
  return safeWereadId(path.slice(folder.length + 6, -3));
}
const block = (entry: WereadEntry) =>
  "weread-" +
  entry.kind +
  "-" +
  entry.id.replace(/[-_]/g, (character) => (character === "_" ? "--u" : "--h"));

export function readWereadScope(raw: string) {
  const scope = readDocumentJson(raw, "weread-scope");
  if (!object(scope) || scope.version !== 1 || !validDay(scope.from))
    throw new Error("Invalid WeRead sync range.");
  return scope.from;
}

export function writeWereadScope(from: string) {
  return (
    "# WeRead sync range\n\n" +
    makeBlock("weread-scope", documentJson({ version: 1, from })) +
    "\n"
  );
}

export function readWereadBook(raw: string, id: string): WereadBook {
  const value = readDocumentJson(raw, "weread-data");
  if (
    !object(value) ||
    value.version !== 1 ||
    value.id !== id ||
    typeof value.title !== "string" ||
    ![value.sort, value.notes, value.reviews].every(
      (x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0,
    ) ||
    !Array.isArray(value.entries) ||
    value.entries.some(
      (row) =>
        !object(row) ||
        !safeWereadId(row.id) ||
        typeof row.text !== "string" ||
        typeof row.stamp !== "string" ||
        (row.kind !== "highlight" && row.kind !== "review"),
    )
  ) {
    throw new Error("Invalid WeRead book cache.");
  }
  return value as unknown as WereadBook;
}

export function writeWereadBook(raw: string | null, book: WereadBook) {
  const data = documentJson({ version: 1, ...book });
  const content = (["highlight", "review"] as const)
    .map(
      (kind) =>
        "## " +
        (kind === "highlight" ? "Highlights" : "Notes") +
        "\n\n" +
        book.entries
          .filter((row) => row.kind === kind)
          .map(
            (row) =>
              row.stamp +
              " · " +
              row.text.replace(/[\\`*_~\[\]!<>#|%]/g, "\\$&") +
              " ^" +
              block(row),
          )
          .join("\n\n"),
    )
    .join("\n\n");
  if (raw !== null)
    return replaceBlock(
      replaceBlock(raw, "weread-data", data),
      "weread-content",
      content,
    );
  const title = book.title.replace(/[\r\n#<>]/g, " ").trim();
  return (
    "# " +
    title +
    "\n\n" +
    makeBlock("weread-content", content) +
    "\n\n" +
    makeBlock("weread-data", data) +
    "\n"
  );
}

export function parseWereadCache(raw: string, path: string): ReadingExcerpt[] {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  if (!filename.startsWith("book-") || !filename.endsWith(".md"))
    throw new Error("Invalid WeRead book path.");
  const book = readWereadBook(raw, filename.slice(5, -3));
  return book.entries.map((entry) => ({
    kind: entry.kind === "highlight" ? "划线" : "微信读书评论",
    title: bookTitle(book.title),
    bookId: book.id,
    text: entry.text,
    stamp: entry.stamp,
    ref: { path, block: block(entry) },
  }));
}
