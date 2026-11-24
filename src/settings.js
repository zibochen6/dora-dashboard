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
function renderSettings(p, host, active, go) {
  const t = (en, zh) => p.t(en, zh),
    cfg = p.cfg;
  const redraw = () => {
    if (host.isConnected) go(active);
  };
  const edit = async (mutator) => {
    await p.update(mutator);
    redraw();
  };
  host.empty();
  host.classList.add("dd-settings");
  const nav = el(host, "nav", "", "dd-settings-nav");
  for (const [id, label] of Object.entries(tabs)) {
    const b = button(nav, t(...label), () => go(id));
    if (active === id) b.setAttribute("aria-current", "page");
  }
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
    cfg.order.forEach((id, i) => {
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
          if (at + offset >= 0 && at + offset < c.order.length)
            [c.order[at], c.order[at + offset]] = [
              c.order[at + offset],
              c.order[at],
            ];
        });
      iconButton(tools, t("Move up", "上移"), "arrow-up", () =>
        move(-1),
      ).disabled = i === 0;
      iconButton(tools, t("Move down", "下移"), "arrow-down", () =>
        move(1),
      ).disabled = i === cfg.order.length - 1;
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
        form(
          p,
          t("Remove this page?", "移除这个页面？"),
          [],
          () =>
            edit((c) => {
              c.pages = c.pages.filter((x) => x.id !== page.id);
            }),
          {
            submit: t("Remove page", "移除页面"),
            text: t("Linked notes stay in your vault.", "关联笔记保存在库内。"),
          },
        ),
      );
      page.widgets.forEach((w, i) => {
        const wrap = row(group, t(...widgets[w.kind]), w.path || "");
        iconButton(wrap, t("Remove widget", "移除组件"), "x", () =>
          edit((c) => {
            c.pages.find((x) => x.id === page.id).widgets.splice(i, 1);
          }),
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
    const setRoot = (path) =>
      edit((c) => {
        if (!visiblePath(path))
          throw Error(t("Choose a visible vault folder", "请选择库内可见目录"));
        c.root = path;
      });
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
      button(tools, t("Choose", "选择"), () =>
        pickPath(p, kind, (path) =>
          edit((c) => {
            c.sources[id] = path;
          }),
        ),
      );
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
      iconButton(tools, t("Unlink project", "取消关联项目"), "unlink", () =>
        edit((c) => {
          c.projects = c.projects.filter((x) => x.id !== project.id);
        }),
      );
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
    Promise.resolve(accountSettings(p, social, redraw)).catch((e) => p.fail(e));
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
      button(tools, t("Test connection", "测试连接"), () => p.syncBooks(true));
      button(
        tools,
        t("Sync highlights & thoughts", "同步划线与想法"),
        () => p.syncBooks(),
        { icon: "refresh-cw" },
      );
    }
    const ai = el(host, "section", "", "dd-group");
    Promise.resolve(aiSettings(p, ai, redraw)).catch((e) => p.fail(e));
  }
}
