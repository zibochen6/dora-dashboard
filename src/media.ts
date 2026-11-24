import { validDay } from "./model.ts";
import {
  documentJson,
  makeBlock,
  readDocumentJson,
  replaceBlock,
} from "./documents.ts";

export const platforms = ["douyin", "xhs", "kuaishou", "bilibili"] as const;
export type Platform = (typeof platforms)[number];
export const platformNames: Record<Platform, string> = {
  douyin: "抖音",
  xhs: "小红书",
  kuaishou: "快手",
  bilibili: "B 站",
};
export type SourceKey = string;
export interface MediaSource {
  readonly key: SourceKey;
  readonly name: string;
  readonly platform: Platform;
  readonly profileId: string;
  readonly accountId: string;
}

const safeId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{1,160}$/.test(value) &&
  !Object.hasOwn(Object.prototype, value) &&
  value !== "prototype";

function safeKey(value: unknown): value is string {
  return safeId(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}

export function validateSources(
  sources: readonly MediaSource[],
): MediaSource[] {
  const keys = new Set<string>(),
    identities = new Set<string>();
  return sources.map((source) => {
    if (
      !source ||
      !safeKey(source.key) ||
      !platforms.includes(source.platform) ||
      !safeId(source.accountId) ||
      typeof source.profileId !== "string" ||
      !source.profileId.trim() ||
      typeof source.name !== "string" ||
      !source.name.trim()
    ) {
      throw new Error("Invalid creator account binding.");
    }
    const pathKey = source.key.toLowerCase();
    const identity = source.platform + ":" + source.accountId;
    if (keys.has(pathKey) || identities.has(identity))
      throw new Error("Duplicate creator account binding.");
    keys.add(pathKey);
    identities.add(identity);
    return Object.freeze({ ...source, name: source.name.trim() });
  });
}

export const metrics = [
  "views",
  "likes",
  "comments",
  "favorites",
  "shares",
] as const;
export type Metric = (typeof metrics)[number];
export const metricNames: Record<Metric, string> = {
  views: "播放 / 浏览",
  likes: "点赞",
  comments: "评论",
  favorites: "收藏",
  shares: "分享",
};
export type Counts = Partial<Record<Metric, number>>;
export interface Post {
  id: string;
  title: string;
  published: string;
  counts: Counts;
  detail: Record<string, string>;
  observed: string;
  run?: string;
  supplement?: {
    run: string;
    observed: string;
    counts: Metric[];
    fields: string[];
  };
}
export interface FanPoint {
  day: string;
  total?: number;
  net?: number;
  gain?: number;
  loss?: number;
}
export interface Account {
  id: string;
  name: string;
  works: Record<string, Post>;
  fans: Record<string, FanPoint>;
  updated: string;
  coverage: string;
  inventory: number | null;
}
export interface Cursor {
  phase: "list" | "deep" | "fans";
  offset: number;
  /** Size reported for this list window (works) or this analysis phase (pages). */
  total?: number;
  window?: number;
  previous?: number;
  anchor?: string;
}
export interface Archive {
  active: string;
  accounts: Record<string, Account>;
  success: string;
  pending?: { day: string; account: string; cursor: Cursor; run: string };
  error?: string;
}
export interface Batch {
  id: string;
  name: string;
  posts?: Post[];
  enrich?: { id: string; counts: Counts; detail: Record<string, string> }[];
  fans?: FanPoint[];
  coverage?: string;
  inventory?: number;
  next: Cursor | null;
  warning?: string;
  restart?: boolean;
}
export interface WorkRef {
  platform: Platform;
  account: string;
  id: string;
}
export interface WorkRow extends WorkRef {
  post: Post;
}
export const emptyArchive = (): Archive => ({
  active: "",
  accounts: {},
  success: "",
});
function sourceFolder(root: string, key: SourceKey) {
  if (!safeKey(key)) throw new Error("Invalid account key.");
  return (root ? root + "/" : "") + "Creator/" + key;
}
export const archivePath = (root: string, key: SourceKey) =>
  sourceFolder(root, key) + "/Archive.md";
export const checkpointPath = (root: string, key: SourceKey) =>
  sourceFolder(root, key) + "/Checkpoint.md";
export function dailyPath(root: string, key: SourceKey, day: string) {
  if (!validDay(day)) throw new Error("Invalid snapshot date.");
  return sourceFolder(root, key) + "/Daily/" + day + ".md";
}
export const workKey = (r: WorkRef) =>
  JSON.stringify([r.platform, r.account, r.id]);
export function workUrl(r: WorkRef) {
  const id = encodeURIComponent(r.id);
  return (
    {
      douyin: "https://www.douyin.com/video/",
      xhs: "https://www.xiaohongshu.com/explore/",
      kuaishou: "https://www.kuaishou.com/short-video/",
      bilibili: "https://www.bilibili.com/video/",
    }[r.platform] + id
  );
}
export function readMedia<T>(raw: string | null, empty: () => T): T {
  if (raw === null) return empty();
  const doc = readDocumentJson(raw, "media-data") as {
    version?: number;
    data?: T;
  };
  if (
    doc?.version !== 1 ||
    !doc.data ||
    typeof doc.data !== "object" ||
    Array.isArray(doc.data)
  )
    throw new Error("作品数据文件格式异常，请检查原文。");
  return doc.data;
}
export function writeMedia<T>(raw: string | null, title: string, data: T) {
  const body = documentJson({ version: 1, data });
  return raw === null
    ? "# " +
        title.replace(/[\r\n]+/g, " ") +
        "\n\n" +
        makeBlock("media-data", body) +
        "\n"
    : replaceBlock(raw, "media-data", body);
}
export function applyBatch(
  archive: Archive,
  batch: Batch,
  day: string,
  now: string,
  run: string,
): Account {
  if (!safeId(batch.id)) throw new Error("无法确认当前平台账号。");
  if (archive.pending?.day === day && archive.pending.account !== batch.id)
    throw new Error("同步过程中切换了账号，请重新刷新。");
  const a = (archive.accounts[batch.id] ??= {
    id: batch.id,
    name: batch.name,
    works: {},
    fans: {},
    updated: "",
    coverage: "",
    inventory: null,
  });
  a.name = batch.name || a.name;
  archive.active = batch.id;
  for (const p of batch.posts ?? []) {
    if (!safeId(p.id) || !p.title)
      throw new Error("平台作品缺少有效标识或标题。");
    const old = a.works[p.id];
    const next: Post = {
      ...p,
      counts: { ...p.counts },
      detail: { ...p.detail },
      observed: now,
      run,
    };
    // Keep the last confirmed detail result visible until the second source finishes.
    if (old?.supplement) {
      next.supplement = {
        ...old.supplement,
        counts: old.supplement.counts.filter(
          (k) => next.counts[k] === undefined,
        ),
        fields: old.supplement.fields.filter(
          (k) => next.detail[k] === undefined,
        ),
      };
      for (const k of next.supplement.counts) next.counts[k] = old.counts[k];
      for (const k of next.supplement.fields) next.detail[k] = old.detail[k];
    }
    a.works[p.id] = next;
  }
  for (const extra of batch.enrich ?? []) {
    if (!safeId(extra.id)) throw new Error("Invalid post identifier.");
    const p = a.works[extra.id];
    if (!p) continue;
    if (p.supplement) {
      for (const k of p.supplement.counts) delete p.counts[k];
      for (const k of p.supplement.fields) delete p.detail[k];
    }
    Object.assign(p.counts, extra.counts);
    Object.assign(p.detail, extra.detail);
    p.supplement = {
      run,
      observed: now,
      counts: Object.keys(extra.counts) as Metric[],
      fields: Object.keys(extra.detail),
    };
  }
  for (const point of batch.fans ?? []) {
    if (!validDay(point.day) || point.day > day) continue;
    a.fans[point.day] = { ...a.fans[point.day], ...point };
  }
  if (batch.coverage) a.coverage = batch.coverage;
  if (batch.inventory !== undefined) a.inventory = batch.inventory;
  if (batch.next)
    archive.pending = { day, account: batch.id, cursor: batch.next, run };
  else {
    for (const [id, post] of Object.entries(a.works)) {
      if (post.run !== run) {
        delete a.works[id];
        continue;
      }
      if (post.supplement && post.supplement.run !== run) {
        for (const k of post.supplement.counts) delete post.counts[k];
        for (const k of post.supplement.fields) delete post.detail[k];
        delete post.supplement;
      }
    }
    delete archive.pending;
    archive.success = day;
    a.updated = now;
  }
  if (batch.warning) archive.error = batch.warning;
  return a;
}
export function fanSummary(account: Account) {
  const sorted = Object.values(account.fans).sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  const pts = sorted.map((p, index) => {
    const prev = sorted[index - 1];
    if (
      p.net !== undefined ||
      p.total === undefined ||
      prev?.total === undefined ||
      Date.parse(p.day) - Date.parse(prev.day) !== 86400000
    )
      return p;
    return { ...p, net: p.total - prev.total };
  });
  const last = pts.at(-1);
  return { points: pts, last, net: last?.net };
}
export function sourceAccount(
  archive: Archive | undefined,
  source: MediaSource,
) {
  return archive?.accounts[source.accountId];
}
export function currentRows(
  archives: Partial<Record<SourceKey, Archive>>,
  sources: readonly MediaSource[],
): WorkRow[] {
  return sources.flatMap((source) => {
    const account = sourceAccount(archives[source.key], source);
    return account
      ? Object.values(account.works).map((post) => ({
          platform: source.platform,
          account: account.id,
          id: post.id,
          post,
        }))
      : [];
  });
}
export function selectRows(
  rows: WorkRow[],
  platform: string,
  from: string,
  to: string,
  sort: Metric | "published",
  query: string,
) {
  const q = query.trim().toLocaleLowerCase();
  return rows
    .filter(
      (r) =>
        (!platform || platform === r.platform) &&
        (!from || r.post.published.slice(0, 10) >= from) &&
        (!to || (!!r.post.published && r.post.published.slice(0, 10) <= to)) &&
        (!q || r.post.title.toLocaleLowerCase().includes(q)),
    )
    .sort(
      (a, b) =>
        (sort === "published"
          ? 0
          : (b.post.counts[sort] ?? -1) - (a.post.counts[sort] ?? -1)) ||
        b.post.published.localeCompare(a.post.published) ||
        workKey(a).localeCompare(workKey(b)),
    );
}
