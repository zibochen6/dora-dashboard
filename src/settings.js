import { Modal, PluginSettingTab } from "obsidian";
import { cards, defaultSources, modules, widgets } from "./config.js";
import { uniqueId } from "./storage.js";
import { visiblePath } from "./model.ts";
import {
  button,
  el,
  form,
  iconButton,
  pickPath,
  row,
  section,
  toggle,
} from "./ui.js";
import { accountSettings } from "./creator-view.js";
import { aiSettings } from "./reflection.js";

const tabs = {
  appearance: ["Appearance & layout", "外观与布局"],
  modules: ["Pages & cards", "栏目与卡片"],
  sources: ["Note sources", "笔记来源"],
  connections: ["Accounts & connections", "账号与连接"],
};
const sources = {
  inbox: ["Task inbox", "待办清单", "file"],
  journal: ["Journal folder", "日记目录", "folder"],
  highlights: ["Highlight note or folder", "划线笔记或目录", "any"],
  thoughts: ["Thought note or folder", "想法笔记或目录", "any"],
  finance: ["Finance folder", "财务目录", "folder"],
  drafts: ["Drafts folder", "稿件目录", "folder"],
  ideas: ["Ideas folder", "选题目录", "folder"],
};
export class DashboardSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.group = "appearance";
  }
  display() {
    renderSettings(this.plugin, this.containerEl, this.group, (id) => {
      this.group = id;
      this.display();
    });
  }
  hide() {
    this.containerEl.empty();
  }
}
export class SettingsDialog extends Modal {
  constructor(plugin, group) {
    super(plugin.app);
    this.plugin = plugin;
    this.group = group;
  }
  onOpen() {
    this.modalEl.addClass("dd-settings-dialog");
    this.titleEl.setText("Dora Dashboard");
    this.draw();
  }
  draw() {
    renderSettings(this.plugin, this.contentEl, this.group, (id) => {
      this.group = id;
      this.draw();
    });
  }
  onClose() {
    this.contentEl.empty();
    if (this.plugin.settingsDialog === this) this.plugin.settingsDialog = null;
  }
}
function select(parent, label, value, options, change) {
  const input = el(parent, "select");
  input.setAttribute("aria-label", label);
  for (const [id, name] of options) el(input, "option", name).value = id;
  input.value = value;
  input.addEventListener("change", () => change(input.value));
  return input;
}
function settingsControlKey(node) {
  if (!node?.matches?.("input, button, select, summary")) return "";
  const group = node.closest(".dd-custom-group")?.querySelector(".dd-setting-info strong")?.textContent ?? "";
  const setting = node.closest(".dd-setting")?.querySelector(".dd-setting-info strong")?.textContent ?? "";
  return JSON.stringify([group, setting, node.tagName, node.getAttribute("aria-label") || node.textContent]);
}
function renderSettings(p, host, active, go) {
  const t = (en, zh) => p.t(en, zh),
    cfg = p.cfg;
  const redraw = () => {
    if (host.isConnected) go(active);
  };
  const edit = async (mutator) => {
    const doc = host.ownerDocument;
    const prior = host.contains(doc.activeElement) ? doc.activeElement : null;
    const key = settingsControlKey(prior);
    await p.update(mutator);
    const restore = prior && (doc.activeElement === prior || doc.activeElement === doc.body);
    redraw();
    if (restore && key && doc.activeElement === doc.body)
      [...host.querySelectorAll("input,button,select,summary")].find(node => settingsControlKey(node) === key)?.focus({preventScroll:true});
  };
  async function removeItem(listOf, index, item, label, kind) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let after;
    await p.update(c => {
      const list = listOf(c);
      if (!list || !same(list[index], item)) throw Error(t("This item changed. Reopen settings.", "此项已变化，请重新打开设置。"));
      list.splice(index, 1);
      after = structuredClone(list);
    });
    p.feedback(label, () => p.update(c => {
      const list = listOf(c);
      if (!list || (kind === "widget" ? !same(list, after) :
        list.some(x => x.id === item.id || (kind === "project" && x.path === item.path))))
        throw Error(t("This list changed. The current entries were kept.", "列表已变化，已保留现有内容。"));
      const nextId = after[index]?.id;
      const next = nextId ? list.findIndex(x => x.id === nextId) : -1;
      list.splice(next >= 0 ? next : Math.min(index, list.length), 0, structuredClone(item));
    }));
    redraw();
  }
  host.empty();
  host.classList.add("dd-settings");
  const nav = el(host, "nav", "", "dd-settings-nav");
  for (const [id, label] of Object.entries(tabs)) {
    const b = button(nav, t(...label), () => go(id));
    if (active === id) b.setAttribute("aria-current", "page");
  }
  p.feedbackBar(host, redraw);
  if (active === "appearance") {
    const box = section(host, t(...tabs.appearance));
    select(
      row(box, t("Language", "界面语言")),
      t("Language", "界面语言"),
      cfg.language,
      [
        ["auto", t("Follow Obsidian", "跟随 Obsidian")],
        ["zh", "简体中文"],
        ["en", "English"],
      ],
      (v) =>
        edit((c) => {
          c.language = v;
        }).catch((e) => p.fail(e)),
    );
    button(
      row(
        box,
        t("Greeting name", "问候中的称呼"),
        cfg.nickname || t("Greeting only", "只显示问候语"),
      ),
      t("Edit", "编辑"),
      () =>
        form(
          p,
          t("Greeting name", "问候中的称呼"),
          [
            {
              key: "name",
              label: t("Nickname (optional)", "昵称（可选）"),
              value: cfg.nickname,
            },
          ],
          ({ name }) =>
            edit((c) => {
              c.nickname = name;
            }),
        ),
    );
    toggle(
      row(box, t("Open on startup", "启动时打开看板")),
      t("Open on startup", "启动时打开看板"),
      cfg.openOnStartup,
      (v) =>
        edit((c) => {
          c.openOnStartup = v;
        }),
    );
    const list = section(host, t("Card order and color", "卡片顺序与配色"));
    const visible = cfg.order.filter(id => cfg.visible.includes(id));
    visible.forEach((id, i) => {
      const tools = row(list, t(...cards[id]));
      const color = el(tools, "input");
      color.type = "color";
      color.value = cfg.colors[id] || cards[id][2];
      color.setAttribute(
        "aria-label",
        t("Card color", "卡片颜色") + " · " + t(...cards[id]),
      );
      color.onchange = () =>
        edit((c) => {
          c.colors[id] = color.value;
        }).catch((e) => p.fail(e));
      const move = (offset) =>
        edit((c) => {
          const at = c.order.indexOf(id);
          const target = c.order.indexOf(visible[i + offset]);
          if (target >= 0 && at >= 0) [c.order[at], c.order[target]] = [c.order[target], c.order[at]];
        });
      iconButton(tools, t("Move up", "上移"), "arrow-up", () =>
        move(-1),
      ).disabled = i === 0;
      iconButton(tools, t("Move down", "下移"), "arrow-down", () =>
        move(1),
      ).disabled = i === visible.length - 1;
    });
  } else if (active === "modules") {
    const home = section(host, t("Home cards", "首页卡片"));
    for (const [id, title] of Object.entries(cards))
      toggle(
        row(home, t(...title)),
        t(...title),
        cfg.visible.includes(id),
        (v) =>
          edit((c) => {
            c.visible = c.visible.filter((x) => x !== id);
            if (v) c.visible.push(id);
          }),
      );
    const pages = section(host, t("Pages", "栏目"));
    for (const id of ["study", "creator", "finance"])
      toggle(
        row(pages, t(...modules[id])),
        t(...modules[id]),
        !!cfg.modules[id],
        (v) =>
          edit((c) => {
            c.modules[id] = v;
          }),
      );
    const custom = section(host, t("Custom pages", "自定义页"));
    for (const page of cfg.pages) {
      const group = el(custom, "div", "", "dd-custom-group");
      const tools = row(group, page.title);
      button(tools, t("Rename", "改名"), () =>
        form(
          p,
          t("Page name", "页面名称"),
          [
            {
              key: "title",
              label: t("Title", "名称"),
              value: page.title,
              required: true,
            },
          ],
          (v) =>
            edit((c) => {
              c.pages.find((x) => x.id === page.id).title = v.title;
            }),
        ),
      );
      button(tools, t("Remove page", "移除页面"), () =>
        removeItem(c => c.pages, cfg.pages.indexOf(page), page, t("Page removed", "已移除页面") + " · " + page.title, "page"));
      page.widgets.forEach((w, i) => {
        const wrap = row(group, t(...widgets[w.kind]), w.path || "");
        iconButton(wrap, t("Remove widget", "移除组件"), "x", () =>
          removeItem(c => c.pages.find(x => x.id === page.id)?.widgets, i, w, t("Widget removed", "已移除组件") + " · " + t(...widgets[w.kind]), "widget"),
        );
      });
      button(
        group,
        t("Add widget", "添加组件"),
        () =>
          form(
            p,
            t("Widget", "组件"),
            [
              {
                key: "kind",
                label: t("Type", "类型"),
                options: Object.entries(widgets).map(([k, l]) => [k, t(...l)]),
              },
            ],
            async ({ kind }) => {
              const add = (path) =>
                edit((c) => {
                  c.pages
                    .find((x) => x.id === page.id)
                    .widgets.push({ kind, ...(path ? { path } : {}) });
                });
              if (kind === "note") pickPath(p, "file", add);
              else await add();
            },
          ),
        { icon: "plus" },
      );
    }
    button(
      custom,
      t("New page", "新增页面"),
      () =>
        form(
          p,
          t("New page", "新增页面"),
          [{ key: "name", label: t("Page name", "页面名称"), required: true }],
          (v) =>
            edit((c) => {
              c.pages.push({ id: uniqueId(), title: v.name, widgets: [] });
            }),
        ),
      { icon: "plus" },
    );
  } else if (active === "sources") {
    const base = section(host, t("Default destination", "默认写入位置"));
    const tools = row(base, t("Dashboard folder", "看板目录"), cfg.root);
    const setRoot = path => {
      if (!visiblePath(path)) throw Error(t("Choose a visible vault folder", "请选择库内可见目录"));
      if (path === cfg.root) return;
      const affected = [t(...cards.habits)];
      for (const id of ["inbox", "journal", "finance", "drafts", "ideas"])
        if (!cfg.sources[id]) affected.push(t(...sources[id]));
      if (cfg.modules.media) affected.push(t(...modules.media));
      if (cfg.modules.ai) affected.push(t(...modules.ai));
      if (cfg.modules.weread) affected.push(t(...modules.weread));
      form(p, t("Change dashboard folder", "更换看板目录"), [], () => edit(c => {
        if (c.root !== cfg.root) throw Error(t("The folder changed. Reopen settings.", "目录已变化，请重新打开设置。"));
        c.root = path;
      }), {
        text: cfg.root + " → " + path + "\n" + affected.join(t(", ", "、")) + "\n" +
          t("Existing notes stay in the original folder. Explicitly linked sources keep their location.", "现有笔记保留在原目录。已单独关联的来源继续使用原位置。"),
        submit: t("Use this folder", "使用这个目录"),
      });
    };
    button(tools, t("Choose", "选择"), () => pickPath(p, "folder", setRoot));
    button(tools, t("New location", "新位置"), () =>
      form(
        p,
        t("Dashboard folder", "看板目录"),
        [
          {
            key: "path",
            label: t("Vault-relative folder", "相对笔记库的目录"),
            value: cfg.root,
            required: true,
          },
        ],
        (v) => setRoot(v.path),
        {
          text: t(
            "Existing notes stay in their current location. Select the old folder again to access them.",
            "现有笔记保存在原位置，选回原目录可继续使用。",
          ),
        },
      ),
    );
    const box = section(host, t("Source bindings", "来源绑定"));
    for (const id of Object.keys(defaultSources)) {
      if ((id === "finance" && !cfg.modules.finance) || (["drafts", "ideas"].includes(id) && !cfg.modules.creator)) continue;
      const [en, zh, kind] = sources[id],
        bound = cfg.sources[id];
      const tools = row(
        box,
        t(en, zh),
        bound ||
          (["highlights", "thoughts"].includes(id)
            ? t("Choose a source to show excerpts", "选择来源后显示摘录")
            : t("Uses the dashboard folder", "使用默认看板目录")),
      );
      button(tools, t("Choose", "选择"), () => p.chooseSource(id, redraw));
      if (bound)
        iconButton(tools, t("Reset binding", "重置绑定"), "rotate-ccw", () =>
          edit((c) => {
            c.sources[id] = "";
          }),
        );
    }
    select(
      row(box, t("Journal format", "日记格式")),
      t("Journal format", "日记格式"),
      cfg.journalMode,
      [
        [
          "daily",
          t("One note per day · YYYY-MM-DD.md", "每日一篇 · YYYY-MM-DD.md"),
        ],
        [
          "monthly",
          t("Monthly note · YYYY/YYYY-MM.md", "每月一篇 · YYYY/YYYY-MM.md"),
        ],
      ],
      (v) =>
        edit((c) => {
          c.journalMode = v;
        }).catch((e) => p.fail(e)),
    );
    const projects = section(host, t("Project checklists", "项目清单"));
    for (const project of cfg.projects) {
      const tools = row(projects, project.name, project.path);
      button(tools, t("Rebind", "重新关联"), () =>
        pickPath(p, "file", (path) =>
          edit((c) => {
            if (c.projects.some((x) => x.id !== project.id && x.path === path))
              throw Error(t("Already linked", "清单已关联"));
            c.projects.find((x) => x.id === project.id).path = path;
          }),
        ),
      );
      iconButton(tools, t("Unlink project", "取消关联项目"), "unlink", async () => {
        await p.unlinkProject(project, t("Project unlinked", "已取消关联"));
        redraw();
      });
    }
    button(
      projects,
      t("Link checklist", "关联已有清单"),
      () => pickPath(p, "file", path => p.projectForm({existing:path})),
      { icon: "link" },
    );
  } else {
    const social = section(
      host,
      t(...modules.media),
      t(
        "Uses your signed-in Ego Lite browser to read the platforms you select.",
        "通过已登录的 Ego Lite 读取你选定的平台。",
      ),
    );
    if (!cfg.modules.creator)
      button(social, t("Enable the Creator page", "开启自媒体栏目"), () =>
        edit((c) => {
          c.modules.creator = true;
        }),
      );
    else
      toggle(
        row(social, t("Enable platform sync", "启用平台同步")),
        t("Enable platform sync", "启用平台同步"),
        !!cfg.modules.media,
        (v) =>
          edit((c) => {
            c.modules.media = v;
          }),
      );
    if (cfg.modules.creator && cfg.modules.media) Promise.resolve(accountSettings(p, social, redraw)).catch((e) => p.fail(e));
    const reading = section(host, t(...modules.weread));
    toggle(
      row(reading, t("Connect WeRead", "连接微信读书")),
      t("Connect WeRead", "连接微信读书"),
      !!cfg.modules.weread,
      (v) =>
        edit((c) => {
          c.modules.weread = v;
        }),
    );
    if (cfg.modules.weread) {
      p.secretSetting(
        reading,
        t("WeRead API key", "微信读书密钥"),
        cfg.wereadSecret,
        (ref) =>
          edit((c) => {
            c.wereadSecret = ref;
          }),
      );
      const tools = el(reading, "div", "", "dd-row");
      const status = el(reading, "p", "", "dd-muted");
      status.setAttribute("role", "status");
      const draw = () => {
        tools.replaceChildren();
        const s = p.bookState;
        const count = s.total === undefined ? "" : " · " + s.done + " / " + s.total;
        const ready = !!p.getSecret(p.cfg.wereadSecret);
        const labels = {
          running: t("Syncing books", "正在同步书籍") + count, testing: t("Testing connection…", "正在测试连接…"),
          cancelled: t("Sync stopped. Saved books are available.", "已停止，已保存的书摘可继续阅读。"),
          connected: t("Connected to WeRead", "微信读书连接成功"),
          done: t("Books updated", "已更新书籍") + " · " + (s.updated ?? 0) + (s.failed ? t(" · Failed ", " · 失败 ") + s.failed : ""),
          failed: s.message, idle: "",
        };
        status.textContent = ready ? labels[s.phase] : t("Choose a key to connect.", "选择密钥后即可连接。");
        if (s.phase === "running" || s.phase === "testing") {
          button(tools, t("Stop", "停止"), () => p.cancel("weread"));
        } else if (ready) {
          button(tools, t("Test connection", "测试连接"), () => p.syncBooks(true));
          button(tools, s.phase === "failed" || s.phase === "cancelled" || s.failed ? t("Retry sync", "重新同步") :
            t("Sync highlights & thoughts", "同步划线与想法"), () => p.syncBooks(), { icon: "refresh-cw" });
        }
      };
      for (const listener of p.bookListeners) if (!listener.host.isConnected) p.bookListeners.delete(listener);
      p.bookListeners.add({ host: reading, draw });
      draw();
    }
    const ai = el(host, "div");
    Promise.resolve(aiSettings(p, ai, redraw)).catch((e) => p.fail(e));
  }
}
