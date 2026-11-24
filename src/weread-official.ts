import { request } from "node:https";
import { object } from "./documents.ts";
import { parseReadingBook, readingText } from "./reading.ts";
import {
  readWereadBook,
  readWereadScope,
  safeWereadId,
  wereadPath,
  wereadScopePath,
  writeWereadBook,
  writeWereadScope,
} from "./weread-cache.ts";
import type { WereadBook, WereadEntry } from "./weread-cache.ts";

const gateway = "https://i.weread.qq.com/api/agent/gateway";
const skillVersion = "1.0.6";
type Endpoint = "/user/notebooks" | "/book/bookmarklist" | "/review/list/mine";
export type WereadRequest = (
  key: string,
  endpoint: Endpoint,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;
type Failure = "auth" | "network" | "rate" | "response" | "write";
const failureText: Record<Failure, string> = {
  auth: "WeRead could not authorize this API key.",
  network: "Could not connect to WeRead. Please try again.",
  rate: "WeRead has reached its rate limit. Please try again later.",
  response: "WeRead returned an unexpected response.",
  write: "Could not save the WeRead cache. Check the selected folder.",
};
export class WereadError extends Error {
  readonly kind: Failure;
  constructor(kind: Failure) {
    super(failureText[kind]);
    this.kind = kind;
  }
}

export const requestWeread: WereadRequest = (key, endpoint, params, signal) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({
      api_name: endpoint,
      ...params,
      skill_version: skillVersion,
    });
    const outgoing = request(
      gateway,
      {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.on("error", () => reject(new WereadError("network")));
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          reject(
            new WereadError(
              status === 401 || status === 403
                ? "auth"
                : status === 429
                  ? "rate"
                  : "response",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            reject(new WereadError("response"));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const raw: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (!object(raw)) throw new WereadError("response");
            const result = object(raw.data) ? raw.data : raw;
            const code = Number(raw.errcode ?? result.errcode ?? 0);
            if (code)
              throw new WereadError(
                [-2010, 401, 403].includes(code)
                  ? "auth"
                  : code === 429
                    ? "rate"
                    : "response",
              );
            resolve(result);
          } catch (error) {
            reject(
              error instanceof WereadError
                ? error
                : new WereadError("response"),
            );
          }
        });
      },
    );
    outgoing.on("error", () => reject(new WereadError("network")));
    outgoing.end(body);
  });

type BookRow = Omit<WereadBook, "entries">;
interface Storage {
  noteList(folder: string): { path: string }[];
  readOptional(path: string): Promise<string | null>;
  updateDocument(
    path: string,
    edit: (current: string | null) => string,
  ): Promise<unknown>;
}
export interface WereadFolders {
  cacheFolder: string;
  readingFolder?: string;
}
type Progress = (current: number, total: number) => void;
export interface WereadResult {
  updated: number;
  highlights: number;
  reviews: number;
  failed: number;
  warning?: string;
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const count = (value: unknown): value is number =>
  value === 0 || positive(value);
const more = (value: unknown) => value === 1 || value === true;
function stamp(value: unknown) {
  if (!positive(value) || value > 253402300799)
    throw new WereadError("response");
  return new Date((value + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function parseBooks(data: Record<string, unknown>): BookRow[] {
  if (!Array.isArray(data.books)) throw new WereadError("response");
  return data.books.map((row) => {
    const title = row?.book?.title;
    if (
      !safeWereadId(row?.bookId) ||
      typeof title !== "string" ||
      !title.trim() ||
      !count(row.sort) ||
      !count(row.noteCount) ||
      !count(row.reviewCount)
    )
      throw new WereadError("response");
    return {
      id: row.bookId,
      title,
      sort: row.sort,
      notes: row.noteCount,
      reviews: row.reviewCount,
    };
  });
}

function entries(
  value: unknown,
  kind: WereadEntry["kind"],
  expected: number,
): WereadEntry[] {
  if (value == null && expected === 0) return [];
  if (!Array.isArray(value)) throw new WereadError("response");
  return value.flatMap((row) => {
    const entry = kind === "review" ? row?.review : row;
    const id = kind === "highlight" ? entry?.bookmarkId : entry?.reviewId;
    const raw = kind === "highlight" ? entry?.markText : entry?.content;
    if (!safeWereadId(id) || typeof raw !== "string")
      throw new WereadError("response");
    const text = readingText(raw, kind === "highlight");
    return [{ id, text, kind, stamp: stamp(entry.createTime) }];
  });
}

export class OfficialWeread {
  private storage: Storage;
  private send: WereadRequest;
  private folders: WereadFolders;
  constructor(
    storage: Storage,
    folders: WereadFolders,
    send: WereadRequest = requestWeread,
  ) {
    this.folders = { ...folders };
    this.storage = storage;
    this.send = send;
  }

  async test(key: string, signal: AbortSignal) {
    signal.throwIfAborted();
    parseBooks(await this.send(key, "/user/notebooks", { count: 1 }, signal));
  }

  private async cutoff(signal: AbortSignal) {
    const today = () => stamp(Math.floor(Date.now() / 1000)).slice(0, 10);
    const { readingFolder, cacheFolder } = this.folders;
    const paths = readingFolder
      ? this.storage
          .noteList(readingFolder)
          .filter(({ path }) => !path.startsWith(cacheFolder + "/"))
      : [];
    let latest = "";
    for (let offset = 0; offset < paths.length; offset += 8) {
      signal.throwIfAborted();
      const batch = await Promise.allSettled(
        paths.slice(offset, offset + 8).map(async ({ path }) => {
          const raw = await this.storage.readOptional(path);
          return raw
            ? parseReadingBook(raw, path).reduce(
                (day, row) =>
                  row.stamp.slice(0, 10) > day ? row.stamp.slice(0, 10) : day,
                "",
              )
            : "";
        }),
      );
      for (const row of batch)
        if (
          row.status === "fulfilled" &&
          row.value > latest &&
          row.value <= today()
        )
          latest = row.value;
    }
    return (
      latest || stamp(Math.floor(Date.now() / 1000) - 60 * 86400).slice(0, 10)
    );
  }

  private async list(key: string, cutoff: string, signal: AbortSignal) {
    const result = new Map<string, BookRow>();
    let lastSort: number | undefined;
    for (let i = 0; i < 100; i++) {
      const data = await this.send(
        key,
        "/user/notebooks",
        { count: 20, ...(lastSort === undefined ? {} : { lastSort }) },
        signal,
      );
      const page = parseBooks(data);
      for (const book of page) {
        if (
          (book.notes || book.reviews) &&
          (!result.size ||
            (book.sort && stamp(book.sort).slice(0, 10) >= cutoff)) &&
          !result.has(book.id)
        ) {
          result.set(book.id, book);
        }
      }
      const next = page.at(-1)?.sort;
      if (!more(data.hasMore)) return [...result.values()];
      if (!next || (lastSort !== undefined && next >= lastSort))
        throw new WereadError("response");
      if (stamp(next).slice(0, 10) < cutoff) return [...result.values()];
      lastSort = next;
    }
    throw new WereadError("response");
  }

  private async fetchBook(
    key: string,
    book: BookRow,
    signal: AbortSignal,
  ): Promise<WereadBook> {
    const marks = await this.send(
      key,
      "/book/bookmarklist",
      { bookId: book.id },
      signal,
    );
    const highlights = entries(marks.updated, "highlight", book.notes);
    if (!highlights.length && book.notes) throw new WereadError("response");
    const reviews: WereadEntry[] = [];
    const seen = new Set<number>();
    let synckey = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.send(
        key,
        "/review/list/mine",
        { bookid: book.id, count: 20, synckey },
        signal,
      );
      reviews.push(...entries(data.reviews, "review", book.reviews));
      if (!more(data.hasMore)) {
        if (!reviews.length && book.reviews) throw new WereadError("response");
        const unique = new Map(
          [...highlights, ...reviews]
            .filter((row) => row.text)
            .map((row) => [row.kind + ":" + row.id, row]),
        );
        return {
          ...book,
          entries: [...unique.values()].sort((a, b) =>
            b.stamp.localeCompare(a.stamp),
          ),
        };
      }
      if (!positive(data.synckey) || seen.has(data.synckey))
        throw new WereadError("response");
      synckey = data.synckey;
      seen.add(synckey);
    }
    throw new WereadError("response");
  }

  async sync(
    key: string,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<WereadResult> {
    signal.throwIfAborted();
    const scopePath = wereadScopePath(this.folders.cacheFolder);
    let from: string;
    let savedScope: string | null;
    try {
      savedScope = await this.storage.readOptional(scopePath);
      from = savedScope
        ? readWereadScope(savedScope)
        : await this.cutoff(signal);
    } catch {
      signal.throwIfAborted();
      throw new WereadError("write");
    }
    signal.throwIfAborted();
    const books = await this.list(key, from, signal);
    signal.throwIfAborted();
    if (!savedScope && books.length)
      try {
        signal.throwIfAborted();
        await this.storage.updateDocument(scopePath, (raw) => {
          signal.throwIfAborted();
          return raw ?? writeWereadScope(from);
        });
        const confirmed = await this.storage.readOptional(scopePath);
        if (!confirmed || readWereadScope(confirmed) !== from)
          throw new WereadError("write");
      } catch {
        signal.throwIfAborted();
        throw new WereadError("write");
      }
    const result: WereadResult = {
      updated: 0,
      highlights: 0,
      reviews: 0,
      failed: 0,
    };
    let index = 0;
    progress(index, books.length);
    for (const book of books) {
      signal.throwIfAborted();
      try {
        const path = wereadPath(this.folders.cacheFolder, book.id);
        const raw = await this.storage.readOptional(path);
        const previous = raw === null ? null : readWereadBook(raw, book.id);
        if (
          previous?.sort === book.sort &&
          previous.notes === book.notes &&
          previous.reviews === book.reviews &&
          previous.title === book.title
        )
          continue;
        const next = await this.fetchBook(key, book, signal);
        signal.throwIfAborted();
        try {
          await this.storage.updateDocument(path, (current) => {
            signal.throwIfAborted();
            if (current !== raw) throw new WereadError("write");
            return writeWereadBook(current, next);
          });
          const saved = await this.storage.readOptional(path);
          if (
            !saved ||
            JSON.stringify(readWereadBook(saved, book.id).entries) !==
              JSON.stringify(next.entries)
          )
            throw new WereadError("write");
        } catch {
          throw new WereadError("write");
        }
        result.updated++;
        const seen = new Set(
          previous?.entries.map((entry) => entry.kind + ":" + entry.id),
        );
        for (const row of next.entries)
          if (!seen.has(row.kind + ":" + row.id)) {
            if (row.kind === "highlight") result.highlights++;
            else result.reviews++;
          }
      } catch (error) {
        signal.throwIfAborted();
        result.failed++;
        result.warning ??=
          error instanceof WereadError ? error.message : failureText.write;
        if (
          error instanceof WereadError &&
          (error.kind === "auth" || error.kind === "rate")
        ) {
          result.failed += books.length - index - 1;
          break;
        }
      } finally {
        progress(++index, books.length);
      }
    }
    return result;
  }
}
