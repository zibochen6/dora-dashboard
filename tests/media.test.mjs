import assert from "node:assert/strict";
import test from "node:test";
import { MediaController } from "../src/media-controller.ts";
import {
  archivePath,
  checkpointPath,
  dailyPath,
  currentRows,
  validateSources,
} from "../src/media.ts";
import { dayKey } from "../src/model.ts";

const root = "Example library";
const first = {
  key: "one",
  name: "First",
  platform: "xhs",
  profileId: "p1",
  accountId: "id1",
};
const second = {
  key: "two",
  name: "Second",
  platform: "xhs",
  profileId: "p2",
  accountId: "id2",
};

function memoryNotes() {
  const records = new Map(),
    reads = [];
  return {
    records,
    reads,
    async readOptional(path) {
      reads.push(path);
      return records.get(path) ?? null;
    },
    async updateDocument(path, edit) {
      const value = edit(records.get(path) ?? null);
      records.set(path, value);
      return value;
    },
  };
}

function twoBatches() {
  const collector = {
    calls: [],
    failAccount: "",
    prefix: "post",
    replaceIdentity: false,
    async step({ accountId, cursor, day }) {
      collector.calls.push([accountId, cursor.offset]);
      if (collector.failAccount === accountId && cursor.offset === 1)
        throw Error("Signed out");
      return {
        id: collector.replaceIdentity ? "different" : accountId,
        name: accountId,
        inventory: 2,
        next: cursor.offset === 0 ? { phase: "list", offset: 1 } : null,
        posts: [
          {
            id: collector.prefix + cursor.offset,
            title: "Example",
            published: day,
            observed: "",
            counts: { views: 1 },
            detail: {},
          },
        ],
      };
    },
    async close() {},
  };
  return collector;
}

test("an empty account list never touches storage or Ego Lite", async () => {
  const notes = memoryNotes(),
    browser = twoBatches();
  const controller = new MediaController(notes, browser, [], root);
  await controller.load();
  await controller.enter(true);
  assert.deepEqual(notes.reads, []);
  assert.deepEqual(browser.calls, []);
  assert.equal(notes.records.size, 0);
});

test("account bindings reject duplicate identities, colliding folders, and invalid paths", () => {
  assert.throws(() => validateSources([first, { ...second, key: "ONE" }]));
  assert.throws(() =>
    validateSources([first, { ...second, accountId: first.accountId }]),
  );
  assert.throws(() => validateSources([{ ...first, key: "../shared" }]));
  assert.throws(() => archivePath("", "NUL"));
  assert.throws(() => dailyPath("", "ok", "../other"));
});

test("same-platform accounts load independent snapshots without contacting the browser", async () => {
  const notes = memoryNotes(),
    browser = twoBatches();
  const controller = new MediaController(notes, browser, [first, second], root);
  await controller.enter(true);
  assert.equal(controller.progress.succeeded, 2);
  assert.deepEqual(
    currentRows(controller.archives, controller.sources).map(
      (row) => row.account,
    ),
    ["id1", "id1", "id2", "id2"],
  );
  const expected = [first, second].flatMap((s) => [
    archivePath(root, s.key),
    checkpointPath(root, s.key),
    dailyPath(root, s.key, dayKey()),
  ]);
  assert.deepEqual([...notes.records.keys()].sort(), expected.sort());
  const offline = twoBatches();
  offline.step = () => {
    throw Error("Offline");
  };
  const reopened = new MediaController(
    notes,
    offline,
    [{ ...second, name: "Renamed" }],
    root,
  );
  await reopened.load();
  assert.equal(currentRows(reopened.archives, reopened.sources).length, 2);
  assert.deepEqual(offline.calls, []);
});

test("a partial scan leaves the previous account archive and daily snapshot intact", async () => {
  const notes = memoryNotes(),
    browser = twoBatches();
  const controller = new MediaController(notes, browser, [first, second], root);
  await controller.enter(true);
  const archive = archivePath(root, first.key),
    daily = dailyPath(root, first.key, dayKey());
  const before = [notes.records.get(archive), notes.records.get(daily)];
  browser.failAccount = first.accountId;
  browser.prefix = "next";
  await controller.enter(true);
  assert.deepEqual(
    [notes.records.get(archive), notes.records.get(daily)],
    before,
  );
  assert.equal(controller.progress.succeeded, 1);
  assert.equal(controller.progress.failures[first.key], "Signed out");
  assert.deepEqual(
    Object.keys(controller.archives.two.accounts.id2.works).sort(),
    ["next0", "next1"],
  );
  const reopened = new MediaController(notes, browser, [first], root);
  browser.failAccount = "";
  browser.calls.length = 0;
  await reopened.enter(true);
  assert.deepEqual(browser.calls, [[first.accountId, 1]]);
  assert.deepEqual(
    Object.keys(reopened.archives.one.accounts.id1.works).sort(),
    ["next0", "next1"],
  );
});

test("a switched browser identity cannot replace confirmed works", async () => {
  const notes = memoryNotes(),
    browser = twoBatches();
  const controller = new MediaController(notes, browser, [first], root);
  await controller.enter(true);
  const archive = archivePath(root, first.key),
    previous = notes.records.get(archive);
  browser.replaceIdentity = true;
  await controller.enter(true);
  assert.match(controller.progress.failures.one, /match/);
  assert.equal(notes.records.get(archive), previous);
});

test("a complete checkpoint is replayed when a write fails between publishing the two notes", async () => {
  const notes = memoryNotes(),
    browser = twoBatches();
  const controller = new MediaController(notes, browser, [first], root);
  await controller.enter(true);
  const archive = archivePath(root, first.key),
    previous = notes.records.get(archive),
    write = notes.updateDocument;
  notes.updateDocument = async (path, edit) => {
    if (path === archive) throw Error("Read only");
    return write(path, edit);
  };
  browser.prefix = "updated";
  await controller.enter(true);
  assert.equal(controller.progress.failures.one, "Read only");
  assert.equal(notes.records.get(archive), previous);
  notes.updateDocument = write;
  browser.calls.length = 0;
  const reopened = new MediaController(notes, browser, [first], root);
  await reopened.enter(true);
  assert.deepEqual(browser.calls, []);
  assert.equal(reopened.progress.succeeded, 1);
  assert.deepEqual(
    Object.keys(reopened.archives.one.accounts.id1.works).sort(),
    ["updated0", "updated1"],
  );
});

test("duplicate syncs share one job and disabling sync cancels and releases its browser space", async () => {
  const notes = memoryNotes();
  let signalEntered,
    closeCount = 0;
  const starting = new Promise((resolve) => {
    signalEntered = resolve;
  });
  const browser = {
    async step(_job, signal) {
      signalEntered();
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("Cancelled")), {
          once: true,
        }),
      );
    },
    async close() {
      closeCount++;
    },
  };
  const controller = new MediaController(notes, browser, [first], root);
  assert.equal(controller.enter(true), controller.enter(true));
  await starting;
  await controller.stop();
  assert.equal(controller.running, false);
  assert.equal(closeCount, 1);
  assert.equal(notes.records.size, 0);
});

test("malformed user-edited account Markdown stays intact while other accounts can update", async () => {
  const notes = memoryNotes(),
    browser = twoBatches();
  const path = archivePath(root, first.key);
  notes.records.set(path, "Custom note");
  const controller = new MediaController(notes, browser, [first, second], root);
  await controller.enter(true);
  assert.equal(controller.progress.succeeded, 1);
  assert.ok(controller.progress.failures.one);
  assert.equal(notes.records.get(path), "Custom note");
  assert.deepEqual(browser.calls, [
    [second.accountId, 0],
    [second.accountId, 1],
  ]);
});
