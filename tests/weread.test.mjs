import assert from "node:assert/strict";
import { test } from "node:test";
import { OfficialWeread } from "../src/weread-official.ts";
import * as cache from "../src/weread-cache.ts";

const folder = "Reading/Cache";
const current = Math.floor(Date.now() / 1000) - 120;

class MemoryNotes {
  files = new Map();
  beforeWrite;
  noteList() {
    return [];
  }
  async readOptional(path) {
    return this.files.get(path) ?? null;
  }
  async updateDocument(path, edit) {
    this.beforeWrite?.(path);
    const raw = edit(this.files.get(path) ?? null);
    this.files.set(path, raw);
    return raw;
  }
}

function book(id, text) {
  return {
    bookId: id,
    book: { title: "Sample " + id },
    sort: current,
    noteCount: 1,
    reviewCount: 0,
    marks: [{ bookmarkId: "pencil", markText: text, createTime: current }],
    reviews: [],
  };
}

function library(rows) {
  return {
    calls: [],
    failReview: "",
    async send(_key, route, params, signal) {
      signal.throwIfAborted();
      this.calls.push({ route, id: params.bookId ?? params.bookid });
      if (route === "/user/notebooks") {
        return {
          books: rows.map(({ marks, reviews, ...info }) => info),
          hasMore: 0,
        };
      }
      const row = rows.find(
        (item) => item.bookId === (params.bookId ?? params.bookid),
      );
      assert.ok(row, "known synthetic book");
      if (route === "/book/bookmarklist") return { updated: row.marks };
      assert.equal(route, "/review/list/mine");
      if (row.bookId === this.failReview) throw Error("Synthetic interruption");
      return { reviews: row.reviews, hasMore: 0 };
    },
  };
}

function client(notes, source, cacheFolder = folder) {
  return new OfficialWeread(notes, { cacheFolder }, source.send.bind(source));
}
const sync = (service, signal = new AbortController().signal) =>
  service.sync("fixture", signal, () => {});
const texts = (notes, path) =>
  cache
    .parseWereadCache(notes.files.get(path), path)
    .map((row) => row.text)
    .sort();

test("WeRead sync deduplicates entries, skips unchanged books after reload, and counts only new entries", async () => {
  const notes = new MemoryNotes(),
    row = book("one", "First highlight");
  row.marks.push({ ...row.marks[0] });
  row.reviewCount = 1;
  row.reviews = [
    {
      review: { reviewId: "pencil", content: "A thought", createTime: current },
    },
  ];
  const source = library([row]),
    path = cache.wereadPath(folder, row.bookId);
  assert.deepEqual(await sync(client(notes, source)), {
    updated: 1,
    highlights: 1,
    reviews: 1,
    failed: 0,
  });
  assert.deepEqual(texts(notes, path), ["A thought", "First highlight"]);
  const previous = notes.files.get(path);
  source.calls.length = 0;
  assert.deepEqual(await sync(client(notes, source)), {
    updated: 0,
    highlights: 0,
    reviews: 0,
    failed: 0,
  });
  assert.deepEqual(
    source.calls.map((call) => call.route),
    ["/user/notebooks"],
  );
  assert.equal(notes.files.get(path), previous);
  row.sort++;
  row.noteCount++;
  row.marks.push({
    bookmarkId: "next",
    markText: "Next highlight",
    createTime: current + 1,
  });
  assert.deepEqual(await sync(client(notes, source)), {
    updated: 1,
    highlights: 1,
    reviews: 0,
    failed: 0,
  });
  assert.deepEqual(texts(notes, path), [
    "A thought",
    "First highlight",
    "Next highlight",
  ]);
});

test("partial failure keeps the last complete book and retries just the affected book", async () => {
  const notes = new MemoryNotes(),
    rows = [book("one", "Original one"), book("two", "Original two")];
  const source = library(rows),
    path = cache.wereadPath(folder, "two");
  await sync(client(notes, source));
  const previous = notes.files.get(path);
  for (const row of rows) {
    row.sort++;
    row.marks[0].markText = "Revised " + row.bookId;
  }
  source.failReview = "two";
  const partial = await sync(client(notes, source));
  assert.equal(partial.updated, 1);
  assert.equal(partial.failed, 1);
  assert.deepEqual(texts(notes, cache.wereadPath(folder, "one")), [
    "Revised one",
  ]);
  assert.equal(notes.files.get(path), previous);

  source.failReview = "";
  source.calls.length = 0;
  const retry = await sync(client(notes, source));
  assert.equal(retry.failed, 0);
  assert.equal(retry.updated, 1);
  assert.deepEqual(
    source.calls
      .filter((call) => call.route === "/book/bookmarklist")
      .map((call) => call.id),
    ["two"],
  );
  assert.deepEqual(texts(notes, path), ["Revised two"]);
});

test("concurrent note edits and unrelated files survive cache writes", async () => {
  const notes = new MemoryNotes(),
    row = book("one", "Before");
  const path = cache.wereadPath(folder, row.bookId),
    service = client(notes, library([row]));
  await sync(service);
  const previous = notes.files.get(path);
  row.sort++;
  row.marks[0].markText = "After";
  const edited = previous + "\nA local annotation.\n";
  notes.beforeWrite = (target) => {
    if (target === path) notes.files.set(target, edited);
  };
  assert.equal((await sync(service)).failed, 1);
  assert.equal(notes.files.get(path), edited);
  notes.beforeWrite = undefined;
  assert.equal((await sync(service)).updated, 1);
  assert.ok(notes.files.get(path).endsWith("\nA local annotation.\n"));
  assert.deepEqual(texts(notes, path), ["After"]);

  const unrelated = "# A note with this filename\nHandwritten content.\n";
  notes.files.set(path, unrelated);
  assert.equal((await sync(service)).failed, 1);
  assert.equal(notes.files.get(path), unrelated);
});

test("cancelling before startup or at the commit boundary preserves the previous book", async () => {
  const notes = new MemoryNotes(),
    row = book("one", "Original");
  const path = cache.wereadPath(folder, row.bookId),
    source = library([row]),
    service = client(notes, source);
  await assert.rejects(sync(service, AbortSignal.abort()), {
    name: "AbortError",
  });
  assert.equal(source.calls.length, 0);
  assert.equal(notes.files.size, 0);
  await sync(service);
  const previous = notes.files.get(path);
  row.sort++;
  row.marks[0].markText = "Pending";
  const controller = new AbortController();
  notes.beforeWrite = (target) => {
    if (target === path) controller.abort();
  };
  await assert.rejects(sync(service, controller.signal), {
    name: "AbortError",
  });
  assert.equal(notes.files.get(path), previous);
});

test("changing the credential behind one secret reference isolates notes for the very same book", async () => {
  const notes = new MemoryNotes();
  const ref = "test-reference",
    firstKey = "fictional-reader-A",
    nextKey = "fictional-reader-B";
  const first = await cache.wereadCacheFolder("Public board", ref, firstKey);
  const second = await cache.wereadCacheFolder("Public board", ref, nextKey);
  assert.ok(first && second);
  assert.notEqual(first, second);
  assert.equal(
    await cache.wereadCacheFolder("Public board", ref, firstKey),
    first,
  );
  assert.equal(await cache.wereadCacheFolder("Public board", ref, ""), "");
  assert.equal(await cache.wereadCacheFolder("Public board", "", firstKey), "");
  for (const key of [firstKey, nextKey])
    assert.ok(!first.includes(key) && !second.includes(key));

  for (const [location, key, text] of [
    [first, firstKey, "First reader"],
    [second, nextKey, "Second reader"],
  ]) {
    const service = client(notes, library([book("same-book", text)]), location);
    assert.equal(
      (await service.sync(key, new AbortController().signal, () => {})).updated,
      1,
    );
  }
  const firstPath = cache.wereadPath(first, "same-book"),
    secondPath = cache.wereadPath(second, "same-book");
  assert.deepEqual(texts(notes, firstPath), ["First reader"]);
  assert.deepEqual(texts(notes, secondPath), ["Second reader"]);
  assert.equal(cache.isWereadBookPath(firstPath, second), false);
  assert.equal(cache.isWereadBookPath(secondPath, first), false);
});
