import {
  applyBatch,
  archivePath,
  checkpointPath,
  dailyPath,
  emptyArchive,
  readMedia,
  validateSources,
  writeMedia,
} from "./media.ts";
import type {
  Archive,
  Cursor,
  FanPoint,
  MediaSource,
  Post,
  SourceKey,
} from "./media.ts";
import type { Collector } from "./media-collector.ts";
import { dayKey, validDay } from "./model.ts";

export interface MediaStorage {
  readOptional(path: string): Promise<string | null>;
  updateDocument(
    path: string,
    change: (old: string | null) => string,
  ): Promise<unknown>;
}

interface DailyAccount {
  updated: string;
  works: Record<string, Pick<Post, "counts" | "detail">>;
  fans?: FanPoint;
}
interface Checkpoint {
  day: string;
  platform: MediaSource["platform"];
  profileId: string;
  accountId: string;
  archive: Archive;
}
interface ActiveSource extends MediaSource {
  cursor: Cursor;
  savedWorks: number;
}
export interface MediaSyncProgress {
  total: number;
  succeeded: number;
  failures: Partial<Record<SourceKey, string>>;
  current?: ActiveSource;
  finishedAt?: string;
}

function checkArchive(archive: Archive, source: MediaSource) {
  if (
    !archive ||
    !archive.accounts ||
    typeof archive.accounts !== "object" ||
    Array.isArray(archive.accounts) ||
    typeof archive.active !== "string" ||
    (archive.active && archive.active !== source.accountId) ||
    (archive.success !== "" && !validDay(archive.success)) ||
    Object.entries(archive.accounts).some(
      ([id, account]) =>
        id !== source.accountId ||
        id !== account?.id ||
        !account.works ||
        !account.fans ||
        typeof account.works !== "object" ||
        typeof account.fans !== "object",
    )
  ) {
    throw new Error(
      "Invalid archive or account identity. Check the linked account and note.",
    );
  }
  return archive;
}

/**
 * One instance belongs to one set of account bindings. Reconfiguration waits
 * for stop() before creating the next controller, so checkpointers never overlap.
 */
export class MediaController {
  readonly sources: readonly MediaSource[];
  readonly archives: Partial<Record<SourceKey, Archive>> = Object.create(null);
  progress?: MediaSyncProgress;
  running = false;
  error = "";
  private archiveErrors: Partial<Record<SourceKey, string>> =
    Object.create(null);
  private loaded?: Promise<void>;
  private job?: Promise<void>;
  private attempted = "";
  private listeners = new Set<() => void>();
  private cancel?: AbortController;
  private storage: MediaStorage;
  private collector: Collector;
  private root: string;

  constructor(
    storage: MediaStorage,
    collector: Collector,
    sources: readonly MediaSource[],
    root: string,
  ) {
    this.storage = storage;
    this.collector = collector;
    this.sources = Object.freeze(validateSources(sources));
    this.root = root;
  }

  subscribe(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  private emit() {
    for (const callback of this.listeners) callback();
  }

  load() {
    this.loaded ??= Promise.all(
      this.sources.map(async (source) => {
        const { key } = source;
        try {
          const raw = await this.storage.readOptional(
            archivePath(this.root, key),
          );
          this.archives[key] = checkArchive(
            readMedia(raw, emptyArchive),
            source,
          );
          delete this.archiveErrors[key];
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Could not read the account archive.";
          this.archives[key] = { ...emptyArchive(), error: message };
          this.archiveErrors[key] = message;
        }
      }),
    ).then(() => this.emit());
    return this.loaded;
  }

  enter(force = false) {
    if (this.job) return this.job;
    const day = dayKey();
    if (!this.sources.length || (!force && this.attempted === day))
      return Promise.resolve();
    this.attempted = day;
    this.running = true;
    this.progress = undefined;
    this.error = "";
    const cancel = new AbortController();
    this.cancel = cancel;
    this.job = this.scan(day, force, cancel.signal)
      .catch((error) => {
        if (!cancel.signal.aborted)
          this.error =
            error instanceof Error
              ? error.message
              : "Could not read creator data.";
      })
      .finally(() => {
        if (this.progress) this.progress.finishedAt = new Date().toISOString();
        this.running = false;
        this.job = undefined;
        this.cancel = undefined;
        this.emit();
      });
    this.emit();
    return this.job;
  }

  async stop() {
    this.cancel?.abort();
    this.attempted = "";
    await Promise.all([this.job, this.loaded]);
  }

  private async scan(day: string, force: boolean, signal: AbortSignal) {
    if (force && this.loaded) {
      await this.loaded;
      this.loaded = undefined;
    }
    signal.throwIfAborted();
    await this.load();
    signal.throwIfAborted();
    const due: MediaSource[] = [];
    for (const source of this.sources) {
      signal.throwIfAborted();
      if (
        force ||
        this.archiveErrors[source.key] ||
        this.archives[source.key]?.success !== day
      )
        due.push(source);
      else {
        try {
          if (await this.readCheckpoint(source)) due.push(source);
        } catch {
          due.push(source);
        }
      }
    }
    const progress: MediaSyncProgress = {
      total: due.length,
      succeeded: 0,
      failures: Object.create(null),
    };
    this.progress = progress;
    this.emit();
    for (const source of due) {
      signal.throwIfAborted();
      const issue = this.archiveErrors[source.key];
      if (issue) {
        progress.failures[source.key] = issue;
        continue;
      }
      const space = "Dora Dashboard " + crypto.randomUUID();
      let usedSpace = false;
      try {
        let checkpoint = await this.readCheckpoint(source);
        signal.throwIfAborted();
        if (
          checkpoint &&
          (checkpoint.accountId !== source.accountId ||
            checkpoint.platform !== source.platform)
        ) {
          throw new Error("This checkpoint belongs to another account.");
        }
        if (checkpoint && !checkpoint.archive.pending) {
          await this.commit(source, checkpoint, signal);
          if (checkpoint.day === day) {
            progress.succeeded++;
            continue;
          }
          checkpoint = null;
        }
        const fresh = (): Checkpoint => {
          const archive = structuredClone(
            this.archives[source.key] ?? emptyArchive(),
          );
          delete archive.error;
          delete archive.pending;
          return {
            day,
            platform: source.platform,
            profileId: source.profileId,
            accountId: source.accountId,
            archive,
          };
        };
        if (
          !checkpoint ||
          checkpoint.day !== day ||
          checkpoint.profileId !== source.profileId
        )
          checkpoint = fresh();
        let cursor: Cursor = checkpoint.archive.pending?.cursor ?? {
          phase: "list",
          offset: 0,
        };
        let run = checkpoint.archive.pending?.run ?? crypto.randomUUID();
        let restarted = false;
        for (;;) {
          signal.throwIfAborted();
          const account = checkpoint.archive.accounts[source.accountId];
          const seenWorks = Object.values(account?.works ?? {}).filter(
            (post) => post.run === run,
          );
          progress.current = {
            ...source,
            cursor,
            savedWorks: seenWorks.length,
          };
          this.emit();
          usedSpace = true;
          const batch = await this.collector.step(
            {
              space,
              profileId: source.profileId,
              accountId: source.accountId,
              platform: source.platform,
              day,
              cursor,
            },
            signal,
          );
          signal.throwIfAborted();
          if (batch.id !== source.accountId)
            throw new Error(
              "The signed-in account does not match the binding.",
            );
          if (batch.warning) throw new Error(batch.warning);
          const inventory = batch.inventory ?? account?.inventory;
          const ids = new Set([
            ...seenWorks.map((post) => post.id),
            ...(batch.posts ?? []).map((post) => post.id),
          ]);
          if (
            batch.restart ||
            (!batch.next && inventory != null && ids.size !== inventory)
          ) {
            if (restarted)
              throw new Error(
                "The platform inventory changed during sync. Please try again.",
              );
            restarted = true;
            checkpoint = fresh();
            await this.writeCheckpoint(source, null, signal);
            cursor = { phase: "list", offset: 0 };
            run = crypto.randomUUID();
            continue;
          }
          if (
            batch.next?.phase === cursor.phase &&
            (batch.next.window ?? 0) === (cursor.window ?? 0) &&
            batch.next.offset <= cursor.offset
          )
            throw new Error(
              "Pagination did not advance. The checkpoint was kept.",
            );
          applyBatch(
            checkpoint.archive,
            batch,
            day,
            new Date().toISOString(),
            run,
          );
          await this.writeCheckpoint(source, checkpoint, signal);
          if (!batch.next) {
            await this.commit(source, checkpoint, signal);
            progress.succeeded++;
            break;
          }
          cursor = batch.next;
        }
      } catch (error) {
        if (signal.aborted) return;
        progress.failures[source.key] =
          error instanceof Error
            ? error.message
            : "Could not read this creator account.";
      } finally {
        delete progress.current;
        this.emit();
        if (usedSpace) await this.collector.close(space).catch(() => {});
      }
    }
  }

  private async readCheckpoint(
    source: MediaSource,
  ): Promise<Checkpoint | null> {
    const raw = await this.storage.readOptional(
      checkpointPath(this.root, source.key),
    );
    const { checkpoint } = readMedia<{ checkpoint: Checkpoint | null }>(
      raw,
      () => ({ checkpoint: null }),
    );
    if (checkpoint === null) return null;
    if (!checkpoint || !validDay(checkpoint.day))
      throw new Error("Invalid sync checkpoint.");
    checkArchive(checkpoint.archive, source);
    const pending = checkpoint.archive.pending;
    if (
      pending &&
      (pending.day !== checkpoint.day ||
        pending.account !== source.accountId ||
        !pending.run ||
        !pending.cursor ||
        !["list", "deep", "fans"].includes(pending.cursor.phase) ||
        !Number.isSafeInteger(pending.cursor.offset) ||
        pending.cursor.offset < 0)
    ) {
      throw new Error("Invalid sync cursor.");
    }
    return checkpoint;
  }

  private writeCheckpoint(
    source: MediaSource,
    checkpoint: Checkpoint | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return this.storage.updateDocument(
      checkpointPath(this.root, source.key),
      (raw) => {
        signal.throwIfAborted();
        return writeMedia(raw, "Sync checkpoint", { checkpoint });
      },
    );
  }

  // Keep a complete checkpoint until both user-visible notes are committed.
  // A crash between writes is replayed idempotently on the next sync.
  private async commit(
    source: MediaSource,
    checkpoint: Checkpoint,
    signal: AbortSignal,
  ) {
    const { archive, day } = checkpoint;
    const account = archive.accounts[source.accountId];
    if (
      !account ||
      account.id !== source.accountId ||
      archive.active !== account.id ||
      archive.success !== day ||
      archive.pending
    )
      throw new Error("Incomplete creator snapshot.");
    signal.throwIfAborted();
    const summary: DailyAccount = {
      updated: account.updated,
      works: Object.fromEntries(
        Object.values(account.works).map(({ id, counts, detail }) => [
          id,
          { counts, detail },
        ]),
      ),
      ...(account.fans[day] ? { fans: account.fans[day] } : {}),
    };
    await this.storage.updateDocument(
      dailyPath(this.root, source.key, day),
      (raw) => {
        signal.throwIfAborted();
        return writeMedia(raw, day + " · " + source.name, summary);
      },
    );
    await this.storage.updateDocument(
      archivePath(this.root, source.key),
      (raw) => {
        signal.throwIfAborted();
        checkArchive(readMedia(raw, emptyArchive), source);
        return writeMedia(raw, source.name, archive);
      },
    );
    this.archives[source.key] = structuredClone(archive);
    await this.writeCheckpoint(source, null, signal);
  }
}
