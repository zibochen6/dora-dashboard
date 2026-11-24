import { el, button, form } from "./ui.js";
import { join, resolveSources, titleOf } from "./storage.js";
import { listProfiles, identifyAccount } from "./media-collector.ts";
import {
  archivePath,
  fanSummary,
  platforms,
  sourceAccount,
  validateSources,
  workUrl,
} from "./media.ts";

const labels = {
  douyin: ["Douyin", "抖音"],
  xhs: ["Xiaohongshu", "小红书"],
  kuaishou: ["Kuaishou", "快手"],
  bilibili: ["Bilibili", "B 站"],
};
const pageSize = 15;

const integrationErrors = [
  [
    /Ego Lite is unavailable|未找到 ego-browser/i,
    "Install Ego Lite and open it once to connect an account.",
    "请先安装并打开 Ego Lite，再连接账号。",
  ],
  [
    /Ego Lite could not complete|Ego Lite returned no result|未能完成读取/,
    "Ego Lite did not return a result. Open the browser and retry.",
    "Ego Lite 未返回结果，请打开浏览器后重试。",
  ],
  [
    /signed-in account does not match|账号与绑定账号不符/,
    "The signed-in account does not match this binding.",
    "当前登录账号与绑定账号不一致。",
  ],
  [
    /登录状态|登录或完成人工验证/,
    "Sign in or complete verification in Ego Lite, then retry.",
    "请在 Ego Lite 登录或完成人工验证后重试。",
  ],
  [
    /Duplicate creator account binding/,
    "This platform account is already connected.",
    "这个平台账号已经绑定。",
  ],
  [
    /Invalid creator account binding/,
    "The account identity could not be verified.",
    "无法核实此账号的身份。",
  ],
  [
    /inventory changed|平台列表持续变动/,
    "The platform list changed during sync. Please retry.",
    "平台作品列表在同步期间变化，请重试。",
  ],
  [
    /Pagination did not advance|平台分页未前进/,
    "The platform stopped paging. Resume later.",
    "平台分页未继续，已保留进度。",
  ],
  [
    /Invalid archive or account identity|Invalid sync checkpoint|Invalid sync cursor|Incomplete creator snapshot/,
    "Could not use this account archive. Check the source note.",
    "此账号的作品档案暂时无法使用，请检查来源笔记。",
  ],
];
function integrationMessage(error, t) {
  const message = error?.message || String(error);
  const entry = integrationErrors.find(([pattern]) => pattern.test(message));
  return entry ? t(entry[1], entry[2]) : message;
}

function noteTitle(value, t) {
  const name = value.trim().replace(/\.md$/i, "").trim();
  if (
    !name ||
    name.startsWith(".") ||
    /[. ]$/.test(name) ||
    /[\\/:*?"<>|#^[\]\r\n\x00-\x1f]/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw Error(t("Enter a valid note name.", "请输入有效的笔记名。"));
  }
  return name;
}

function noteSection(view, parent, group, folder) {
  const plugin = view.plugin;
  const t = (en, zh) => view.t(en, zh);
  const draft = group === "drafts";
  const section = el(parent, "section", "", "dd-card");
  const header = el(section, "div", "", "dd-row");
  el(header, "h2", draft ? t("Drafts", "稿件") : t("Ideas", "选题"));
  const create = draft ? t("New draft", "新建稿件") : t("New idea", "新建选题");
  button(
    header,
    create,
    () =>
      form(
        plugin,
        create,
        [{ key: "title", label: t("Note title", "笔记标题"), required: true }],
        async (values) => {
          const name = noteTitle(values.title, t);
          const path = join(folder, name + ".md");
          await plugin.notes.updateDocument(path, (existing) => {
            if (existing !== null)
              throw Error(
                t("A note with this name already exists.", "已有同名笔记。"),
              );
            return "# " + name + "\n";
          });
          await plugin.openNote(path);
        },
      ),
    { icon: "plus" },
  );
  const notes = plugin.notes
    .noteList(folder)
    .sort(
      (a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path),
    );
  if (!notes.length) {
    el(
      section,
      "p",
      draft
        ? t("No drafts yet.", "还没有稿件。")
        : t("No ideas yet.", "还没有选题。"),
      "dd-muted",
    );
    return;
  }
  const list = el(section, "div", "", "dd-note-list");
  const show = (container, file) => {
    const link = button(
      container,
      file.basename || titleOf(file.path),
      () => plugin.openNote(file.path),
      { icon: "file-text" },
    );
    link.title = file.path;
  };
  notes.slice(0, 5).forEach((file) => show(list, file));
  if (notes.length > 5) {
    const more = el(list, "details");
    el(more, "summary", t("More", "更多") + " (" + (notes.length - 5) + ")");
    more.addEventListener("toggle", () => {
      if (!more.open || more.children.length > 1) return;
      notes.slice(5).forEach((file) => show(more, file));
    });
  }
}

function drawWorks(view, host, sources, archives) {
  const t = (en, zh) => view.t(en, zh);
  host.replaceChildren();
  const active =
    sources.find((source) => source.key === view.creatorAccount) ?? sources[0];
  const label = el(host, "label", t("Account ", "账号 "));
  const select = el(label, "select");
  for (const source of sources)
    el(
      select,
      "option",
      source.name + " · " + t(...labels[source.platform]),
    ).value = source.key;
  select.value = active.key;
  select.addEventListener("change", () => {
    view.creatorAccount = select.value;
    view.creatorPage = 0;
    drawWorks(view, host, sources, archives);
  });
  const archive = archives[active.key];
  const account = sourceAccount(archive, active);
  if (archive?.error)
    el(host, "p", integrationMessage(archive.error, t), "dd-muted");
  if (!account) {
    el(
      host,
      "p",
      t("No saved works for this account yet.", "这个账号还没有已保存的作品。"),
      "dd-muted",
    );
    return;
  }
  const rows = Object.values(account.works).sort(
    (a, b) =>
      b.published.localeCompare(a.published) || a.id.localeCompare(b.id),
  );
  const format = new Intl.NumberFormat(t("en", "zh-CN"));
  const count = (value) =>
    typeof value === "number" ? format.format(value) : "—";
  const latestFans = fanSummary(account).last;
  const stats = [
    t("Works", "作品") + " " + count(rows.length),
    t("Followers", "粉丝") + " " + count(latestFans?.total),
  ];
  if (account.updated) {
    const date = new Date(account.updated);
    if (Number.isFinite(date.valueOf()))
      stats.push(
        t("Updated", "更新于") + " " + date.toLocaleString(t("en", "zh-CN")),
      );
  }
  el(host, "p", stats.join(" · "), "dd-muted");
  button(
    host,
    t("Open archive", "打开作品档案"),
    () => view.plugin.openNote(archivePath(view.plugin.cfg.root, active.key)),
    { icon: "file-text" },
  );
  if (!rows.length) return;
  const pages = Math.ceil(rows.length / pageSize);
  const page = Math.min(Math.max(view.creatorPage ?? 0, 0), pages - 1);
  const scroll = el(host, "div", "", "dd-table-wrap");
  const table = el(scroll, "table", "", "dd-table");
  const header = el(el(table, "thead"), "tr");
  for (const title of [
    t("Work", "作品"),
    t("Published", "发布时间"),
    t("Views", "播放 / 浏览"),
    t("Likes", "点赞"),
    t("Comments", "评论"),
  ]) {
    el(header, "th", title).scope = "col";
  }
  const body = el(table, "tbody");
  for (const post of rows.slice(page * pageSize, (page + 1) * pageSize)) {
    const row = el(body, "tr");
    const anchor = el(el(row, "td"), "a", post.title);
    anchor.href = workUrl({ platform: active.platform, id: post.id });
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    el(row, "td", post.published.slice(0, 10) || "—");
    for (const metric of ["views", "likes", "comments"])
      el(row, "td", count(post.counts[metric]));
  }
  if (pages > 1) {
    const nav = el(host, "div", "", "dd-row");
    const go = (delta) => {
      view.creatorPage = page + delta;
      drawWorks(view, host, sources, archives);
    };
    button(nav, t("Previous", "上一页"), () => go(-1), {
      icon: "chevron-left",
    }).disabled = page === 0;
    el(nav, "span", page + 1 + " / " + pages, "dd-muted");
    button(nav, t("Next", "下一页"), () => go(1), {
      icon: "chevron-right",
    }).disabled = page + 1 === pages;
  }
}

export async function creatorView(view, parent) {
  const plugin = view.plugin;
  const t = (en, zh) => view.t(en, zh);
  if (!plugin.cfg.modules.creator) return;
  const paths = resolveSources(plugin.cfg);
  noteSection(view, parent, "drafts", paths.drafts);
  noteSection(view, parent, "ideas", paths.ideas);
  const works = el(parent, "section", "", "dd-card");
  const header = el(works, "div", "", "dd-row");
  el(header, "h2", t("Works", "作品数据"));
  if (!plugin.cfg.modules.media || !plugin.cfg.accounts.length) {
    if (!plugin.cfg.modules.media)
      for (const source of plugin.cfg.accounts) {
        button(
          works,
          t("Open archive", "打开作品档案") + " · " + source.name,
          async () => {
            const path = archivePath(plugin.cfg.root, source.key);
            if ((await plugin.notes.readOptional(path)) === null)
              throw Error(t("No saved works yet.", "还没有已保存的作品。"));
            await plugin.openNote(path);
          },
          { icon: "file-text" },
        );
      }
    button(
      works,
      t("Configure creator accounts", "配置创作账号"),
      () => plugin.openSettings("connections"),
      { icon: "settings" },
    );
    return;
  }
  let alive = true,
    unsubscribe;
  view.cleanup(() => {
    alive = false;
    unsubscribe?.();
  });
  const controller = await plugin.mediaController();
  if (!alive || !controller) return;
  await controller.load();
  if (!alive) return;

  const sync = button(
    header,
    t("Sync works", "同步作品"),
    async () => {
      try {
        await plugin.syncMedia();
      } catch (error) {
        plugin.fail(error);
      }
    },
    { icon: "refresh-cw" },
  );
  const status = el(works, "div", "", "dd-muted");
  status.setAttribute("aria-live", "polite");
  const results = el(works, "div");
  const last = new Map();
  const update = () => {
    if (!alive) return;
    sync.disabled = controller.running;
    status.replaceChildren();
    const { progress, sources, archives } = controller;
    if (progress) {
      const current = progress.current;
      if (controller.running && current) {
        el(
          status,
          "p",
          current.name +
            " · " +
            t("Saved works", "已读取作品") +
            " " +
            current.savedWorks,
        );
      }
      el(
        status,
        "span",
        t("Synced accounts", "已同步账号") +
          " " +
          progress.succeeded +
          " / " +
          progress.total,
      );
      for (const source of sources)
        if (progress.failures[source.key]) {
          el(
            status,
            "p",
            source.name +
              " · " +
              integrationMessage(progress.failures[source.key], t),
          );
        }
    }
    if (controller.error)
      el(status, "p", integrationMessage(controller.error, t));
    if (
      sources.length &&
      (!last.size ||
        sources.some((source) => last.get(source.key) !== archives[source.key]))
    ) {
      for (const source of sources) last.set(source.key, archives[source.key]);
      drawWorks(view, results, sources, archives);
    }
  };
  unsubscribe = controller.subscribe(update);
  update();
}

function validBinding(plugin, section) {
  return (
    section.isConnected &&
    plugin.cfg.modules.creator &&
    plugin.cfg.modules.media
  );
}

// If the user disables the module or leaves its settings, release the in-flight browser operation.
async function useBrowser(plugin, section, action) {
  if (!validBinding(plugin, section)) return;
  const cancel = new AbortController();
  const session = plugin.jobSignal?.("account");
  const signal = session
    ? AbortSignal.any([cancel.signal, session])
    : cancel.signal;
  const observer = new MutationObserver(() => {
    if (!validBinding(plugin, section)) cancel.abort();
  });
  observer.observe(section.ownerDocument.body, {
    childList: true,
    subtree: true,
  });
  try {
    const result = await action(signal);
    if (!validBinding(plugin, section) || signal.aborted) return;
    return result;
  } catch (error) {
    if (!signal.aborted && validBinding(plugin, section)) {
      throw Error(integrationMessage(error, (en, zh) => plugin.t(en, zh)));
    }
  } finally {
    observer.disconnect();
    if (session && plugin.isCurrent("account", session))
      plugin.cancel("account");
  }
}

async function accountKey(platform, accountId) {
  const bytes = new TextEncoder().encode(platform + ":" + accountId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  // Stable across renaming, disconnecting and rebinding; paths do not reveal the account ID.
  return Array.from(new Uint8Array(digest).slice(0, 16), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

export function accountSettings(plugin, parent, rerender) {
  const t = (en, zh) => plugin.t(en, zh);
  const section = el(parent, "section", "", "dd-section");
  el(section, "h3", t("Creator accounts", "创作账号"));
  for (const source of plugin.cfg.accounts) {
    const row = el(section, "div", "", "dd-row");
    el(row, "span", source.name + " · " + t(...labels[source.platform]));
    button(
      row,
      t("Rename", "改名"),
      () =>
        form(
          plugin,
          t("Account name", "账号名称"),
          [
            {
              key: "name",
              label: t("Name", "名称"),
              value: source.name,
              required: true,
            },
          ],
          async (values) => {
            const name = values.name.trim();
            if (!name) throw Error(t("Enter a name.", "请输入名称。"));
            await plugin.update((cfg) => {
              const entry = cfg.accounts.find(
                (item) => item.key === source.key,
              );
              if (entry) entry.name = name;
            });
            rerender();
          },
        ),
      { icon: "pencil" },
    );
    button(row, t("Disconnect", "解除绑定"), () => {
      if (row.querySelector("[data-disconnect]")) return;
      const confirm = el(row, "span", "", "dd-row");
      confirm.dataset.disconnect = "";
      el(
        confirm,
        "span",
        t(
          "Keep saved notes and disconnect this account?",
          "保留已保存的笔记并解除账号绑定？",
        ),
      );
      button(confirm, t("Disconnect account", "确认解除"), async () => {
        await plugin.update((cfg) => {
          cfg.accounts = cfg.accounts.filter((item) => item.key !== source.key);
        });
        rerender();
      });
      button(confirm, t("Cancel", "取消"), () => confirm.remove());
    });
  }
  if (!plugin.cfg.modules.creator || !plugin.cfg.modules.media) {
    el(
      section,
      "p",
      t(
        "Enable Creator and creator account sync to connect an account.",
        "开启「自媒体」和「创作平台同步」后即可绑定账号。",
      ),
      "dd-muted",
    );
    return;
  }
  const status = el(section, "div");
  status.setAttribute("aria-live", "polite");
  const add = button(
    section,
    t("Add creator account", "添加创作账号"),
    async () => {
      add.disabled = true;
      status.replaceChildren();
      try {
        const profiles = await useBrowser(plugin, section, (signal) =>
          listProfiles(signal),
        );
        if (!profiles) return;
        if (!profiles.length) {
          el(
            status,
            "p",
            t(
              "Open Ego Lite and sign in to a creator platform first.",
              "请先打开 Ego Lite 并登录创作者平台。",
            ),
            "dd-muted",
          );
          return;
        }
        form(
          plugin,
          t("Verify signed-in account", "核对登录账号"),
          [
            {
              key: "platform",
              label: t("Platform", "平台"),
              options: platforms.map((id) => [id, t(...labels[id])]),
              value: platforms[0],
            },
            {
              key: "profileId",
              label: t("Ego Lite profile", "Ego Lite 配置"),
              options: profiles.map((p) => [p.id, p.name || p.id]),
              value: profiles[0].id,
            },
            {
              key: "alias",
              label: t("Display name (optional)", "显示名称（可选）"),
            },
          ],
          async (values) => {
            const { platform, profileId } = values;
            const identity = await useBrowser(plugin, section, (signal) =>
              identifyAccount(platform, profileId, signal),
            );
            if (!identity) return;
            const binding = {
              key: await accountKey(platform, identity.id),
              platform,
              profileId,
              accountId: identity.id,
              name: values.alias?.trim() || identity.name || identity.id,
            };
            if (!validBinding(plugin, section)) return;
            try {
              validateSources([...plugin.cfg.accounts, binding]);
            } catch (error) {
              throw Error(integrationMessage(error, t));
            }
            status.replaceChildren();
            el(
              status,
              "p",
              t("Signed in as", "已登录账号") +
                " " +
                identity.name +
                " · " +
                identity.id +
                " · " +
                t(...labels[platform]),
            );
            button(status, t("Confirm binding", "确认绑定"), async () => {
              if (!validBinding(plugin, section)) return;
              await plugin.update((cfg) => {
                if (!cfg.modules.creator || !cfg.modules.media) return;
                try {
                  validateSources([...cfg.accounts, binding]);
                } catch (error) {
                  throw Error(integrationMessage(error, t));
                }
                cfg.accounts.push(binding);
              });
              rerender();
            });
            button(status, t("Cancel", "取消"), () => status.replaceChildren());
          },
          { submit: t("Verify account", "核对账号") },
        );
      } catch (error) {
        if (validBinding(plugin, section))
          el(
            status,
            "p",
            plugin.errorText?.(error) || error.message || String(error),
            "dd-muted",
          );
      } finally {
        add.disabled = false;
      }
    },
    { icon: "plus" },
  );
}
