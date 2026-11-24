import { visiblePath } from "./model.ts";

export const cards = {
  tasks: ["Today's tasks", "今日待办", "#bfc8f4", "list-checks"],
  projects: ["Projects", "项目", "#cdd2f6", "layers"],
  habits: ["Today's habits", "今日习惯", "#edc5dd", "sprout"],
  journal: ["Journal", "日记热力图", "#c8dfad", "calendar-days"],
  highlights: ["Recent highlights", "近期划线", "#ffe89e", "book-open"],
  thoughts: ["Recent thoughts", "近期想法", "#cbd4fa", "notebook-pen"],
};
export const modules = {
  study: ["Learning", "学习", "graduation-cap"],
  creator: ["Creator", "自媒体", "clapperboard"],
  finance: ["Finances", "财务", "wallet"],
  weread: ["WeRead sync", "微信读书同步"],
  media: ["Creator account sync", "创作平台同步"],
  ai: ["AI reflection", "AI 寄语"],
};
export const widgets = {
  note: ["Note link", "笔记入口"],
  tasks: cards.tasks,
  milestones: ["Milestones", "里程碑"],
  progress: ["Project progress", "项目进度"],
};
export const defaultSources = {
  inbox: "",
  journal: "",
  highlights: "",
  thoughts: "",
  finance: "",
  drafts: "",
  ideas: "",
};
function fresh() {
  return {
    version: 1,
    language: "auto",
    nickname: "",
    openOnStartup: false,
    root: "Dora Dashboard",
    order: Object.keys(cards),
    visible: ["tasks", "projects", "habits", "journal"],
    colors: {},
    modules: {},
    sources: { ...defaultSources },
    journalMode: "daily",
    projects: [],
    pages: [],
    accounts: [],
    financeGoal: "",
    currency: "CNY",
    wereadSecret: "",
    ai: { endpoint: "", model: "", secret: "", lang: "auto", fields: [] },
  };
}
export function configFrom(raw) {
  const cfg = fresh();
  if (raw == null) return cfg;
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    ![undefined, 0, 1].includes(raw.version)
  )
    throw Error("Unsupported settings format");
  const data = { ...raw };
  if (!data.version && Array.isArray(data.cards)) data.visible = data.cards;
  for (const key of ["nickname", "financeGoal", "wereadSecret"])
    if (typeof data[key] === "string") cfg[key] = data[key];
  if (visiblePath(data.root)) cfg.root = data.root;
  if (["en", "zh", "auto"].includes(data.language))
    cfg.language = data.language;
  if (data.journalMode === "monthly") cfg.journalMode = "monthly";
  if (/^[A-Z]{3}$/.test(data.currency)) cfg.currency = data.currency;
  cfg.openOnStartup = data.openOnStartup === true;
  const known = (items, keys) =>
    [...new Set(items)].filter((id) => Object.hasOwn(keys, id));
  if (Array.isArray(data.order))
    cfg.order = known([...data.order, ...cfg.order], cards);
  if (Array.isArray(data.visible)) cfg.visible = known(data.visible, cards);
  for (const id of Object.keys(cards))
    if (/^#[\da-f]{6}$/i.test(data.colors?.[id]))
      cfg.colors[id] = data.colors[id];
  for (const id of Object.keys(modules))
    cfg.modules[id] = data.modules?.[id] === true;
  for (const id of Object.keys(defaultSources))
    if (
      visiblePath(data.sources?.[id]) ||
      (id !== "inbox" && data.sources?.[id] === "/")
    )
      cfg.sources[id] = data.sources[id];
  const validId = (id) =>
    typeof id === "string" &&
    /^[a-z\d_-]{1,100}$/i.test(id) &&
    !["__proto__", "prototype", "constructor"].includes(id);
  const list = (x) => (Array.isArray(x) ? x : []);
  cfg.projects = list(data.projects).filter(
    (p) =>
      validId(p?.id) &&
      typeof p.name === "string" &&
      visiblePath(p.path) &&
      /\.md$/i.test(p.path),
  );
  cfg.pages = list(data.pages)
    .filter((p) => validId(p?.id) && typeof p.title === "string")
    .map((p) => ({
      ...p,
      widgets: list(p.widgets).filter(
        (w) =>
          w &&
          Object.hasOwn(widgets, w.kind) &&
          (w.kind !== "note" || visiblePath(w.path)),
      ),
    }));
  cfg.accounts = list(data.accounts).filter(
    (a) =>
      validId(a?.key) &&
      ["douyin", "xhs", "kuaishou", "bilibili"].includes(a.platform) &&
      typeof a.name === "string" &&
      typeof a.profileId === "string" &&
      !!a.profileId &&
      validId(a.accountId),
  );
  for (const key of ["endpoint", "model", "secret", "lang"])
    if (typeof data.ai?.[key] === "string") cfg.ai[key] = data.ai[key];
  cfg.ai.fields = list(data.ai?.fields).filter((x) =>
    ["tasks", "projects", "habits"].includes(x),
  );
  return cfg;
}
export function renamed(config, from, to) {
  const move = (p) =>
    p === from ? to : p?.startsWith(from + "/") ? to + p.slice(from.length) : p;
  let changed = false;
  const set = (o, k) => {
    const value = move(o[k]);
    if (value !== o[k]) {
      o[k] = value;
      changed = true;
    }
  };
  set(config, "root");
  for (const key of Object.keys(config.sources)) set(config.sources, key);
  for (const project of config.projects) set(project, "path");
  for (const page of config.pages)
    for (const widget of page.widgets) if (widget.path) set(widget, "path");
  return changed;
}
