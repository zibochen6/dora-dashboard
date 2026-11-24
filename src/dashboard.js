import { ItemView } from "obsidian";
import { cards, modules } from "./config.js";
import { dayKey } from "./model.ts";
import { recentDays, resolveSources, titleOf, uniqueId } from "./storage.js";
import { button, el, form, icon, iconButton, pickPath } from "./ui.js";
import { creatorView } from "./creator-view.js";
import { financeView } from "./finance-view.js";
import { reflectionPanel } from "./reflection.js";

export const viewType = "dora-dashboard";
const hasNote = (path, source) =>
  !!source &&
  (source === "/" ||
    path === source ||
    path.startsWith(source + "/") ||
    source.startsWith(path + "/"));
export class BoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.page = "home";
    this.index = { highlights: 0, thoughts: 0 };
    this.expanded = new Set();
    this.disposers = [];
    this.revision = 0;
    this.t = (en, zh) => plugin.t(en, zh);
  }
  getViewType() {
    return viewType;
  }
  getDisplayText() {
    return "Dora Dashboard";
  }
  getIcon() {
    return "layout-dashboard";
  }
  cleanup(callback) {
    this.disposers.push(callback);
  }
  drain() {
    for (const fn of this.disposers.splice(0)) fn();
  }
  async onOpen() {
    this.contentEl.addClass("dd-host");
    this.plugin.views.add(this);
    const onFile = (file) => {
      if (
        [...(this.watched ?? [])].some((source) => hasNote(file.path, source))
      )
        this.schedule();
    };
    for (const event of ["create", "modify", "delete"])
      this.registerEvent(this.app.vault.on(event, onFile));
    this.registerEvent(
      this.app.vault.on("rename", (file, from) => {
        onFile(file);
        onFile({ path: from });
      }),
    );
    this.registerInterval(
      window.setInterval(() => {
        if (this.today !== dayKey()) this.schedule();
      }, 60000),
    );
    await this.refresh();
  }
  async onClose() {
    this.plugin.views.delete(this);
    this.closed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.drain();
    this.contentEl.empty();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.refresh().catch((e) => this.plugin.fail(e)),
      90,
    );
  }
  async refresh() {
    if (this.closed) return;
    const revision = ++this.revision;
    this.drain();
    const cfg = this.plugin.cfg;
    if (!cfg) return;
    this.watched = new Set();
    this.today = dayKey();
    const navs = [["home", this.t("Home", "首页"), "house"]];
    for (const key of ["study", "creator", "finance"])
      if (cfg.modules[key])
        navs.push([key, this.t(...modules[key]), modules[key][2]]);
    for (const page of cfg.pages)
      navs.push([page.id, page.title, "panels-top-left"]);
    if (!navs.some(([key]) => key === this.page)) this.page = "home";
    const focus = this.contentEl.ownerDocument.activeElement?.dataset?.focus;
    const scrolled = this.contentEl.scrollTop;
    const root = this.contentEl.ownerDocument.createElement("div");
    root.className = "dd-app";
    const shell = el(root, "div", "", "dd-shell");
    const nav = el(shell, "nav", "", "dd-nav");
    nav.setAttribute("aria-label", this.t("Dashboard pages", "看板页面"));
    const logo = el(nav, "div", "", "dd-brand");
    logo.title = "Dora Dashboard";
    const flower = el(logo, "i", "", "dd-flower");
    for (let i = 0; i < 4; i++) el(flower, "i");
    for (const [id, label, glyph] of navs) {
      const b = button(
        nav,
        label,
        () => {
          this.page = id;
          return this.refresh();
        },
        { icon: glyph, cls: "dd-nav-item" },
      );
      if (id === this.page) b.setAttribute("aria-current", "page");
    }
    button(nav, this.t("Settings", "设置"), () => this.plugin.openSettings(), {
      icon: "settings",
      cls: "dd-nav-item",
    });
    const content = el(shell, "main", "", "dd-main");
    const header = el(content, "header", "", "dd-hero");
    const date = el(header, "time", "", "dd-date");
    icon(date, "calendar-days");
    date.dateTime = this.today;
    el(
      date,
      "span",
      new Intl.DateTimeFormat(this.plugin.uiLanguage(), {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date()),
    );
    const title = el(header, "h1");
    if (this.page === "home") {
      const h = new Date().getHours();
      const greet =
        h < 11
          ? this.t("Good morning", "早上好")
          : h < 14
            ? this.t("Good afternoon", "中午好")
            : h < 19
              ? this.t("Good afternoon", "下午好")
              : this.t("Good evening", "晚上好");
      if (cfg.nickname) {
        title.append(greet + this.t(", ", "，"));
        el(title, "span", cfg.nickname, "dd-marker");
      } else el(title, "span", greet, "dd-marker");
    } else
      el(title, "span", navs.find(([k]) => k === this.page)[1], "dd-marker");
    const body = el(content, "div", "", "dd-content");
    // Mount immediately so that a slow source never holds the rest of the page hostage.
    this.contentEl.replaceChildren(root);
    this.contentEl.scrollTop = scrolled;
    const src = resolveSources(cfg);
    const watch = (...paths) =>
      paths.filter(Boolean).forEach((p) => this.watched.add(p));
    const tasks = (includeInbox = true) => {
      watch(
        ...(includeInbox ? [src.inbox] : []),
        ...cfg.projects.map((p) => p.path),
      );
      return this.plugin.taskGroups(false, includeInbox);
    };
    const guards = [];
    const render = (parent, fn) => {
      guards.push(
        Promise.resolve()
          .then(() => (revision === this.revision ? fn() : undefined))
          .catch((e) => {
            if (revision === this.revision)
              el(parent, "p", this.plugin.errorText(e), "dd-error");
          }),
      );
    };
    if (this.page === "home") {
      const grid = el(body, "div", "", "dd-grid");
      const visible = cfg.order.filter((k) => cfg.visible.includes(k));
      const defaultOrder = Object.keys(cards).filter((k) =>
        cfg.visible.includes(k),
      );
      const classic =
        visible.join() === defaultOrder.join() &&
        visible.some((k) => ["tasks", "projects"].includes(k)) &&
        visible.some((k) => !["tasks", "projects"].includes(k));
      let left, right, pair;
      if (classic) {
        grid.classList.add("dd-classic");
        left = el(grid, "div", "", "dd-stack");
        right = el(grid, "div", "", "dd-side");
        pair = el(right, "div", "", "dd-pair");
      }
      let shared;
      const get = () => (shared ??= tasks(visible.includes("tasks")));
      for (const key of visible) {
        const parent = !classic
          ? grid
          : ["tasks", "projects"].includes(key)
            ? left
            : ["habits", "journal"].includes(key)
              ? pair
              : right;
        const card = this.card(parent, key);
        if (key === "tasks")
          render(card, async () => this.taskCard(card, await get()));
        if (key === "projects")
          render(card, async () => this.projectsCard(card, await get()));
        if (key === "habits") {
          watch(cfg.root + "/Habits.md");
          render(card, () => this.habitsCard(card));
        }
        if (key === "journal") {
          watch(src.journal);
          render(card, () => this.journalCard(card));
        }
        if (key === "highlights" || key === "thoughts") {
          watch(src[key]);
          if (cfg.modules.weread) watch(this.plugin.bookCache());
          render(card, () => this.excerptCard(card, key));
        }
      }
      if (!visible.length)
        button(
          body,
          this.t("Choose home cards", "选择首页卡片"),
          () => this.plugin.openSettings("modules"),
          { icon: "panels-top-left" },
        );
      if (cfg.modules.ai) {
        watch(cfg.root + "/Reflections");
        const a = el(body, "section", "", "dd-card");
        render(a, () => reflectionPanel(this, a));
      }
    } else if (this.page === "creator") {
      watch(src.drafts, src.ideas);
      if (cfg.modules.media) watch(cfg.root + "/Creator");
      render(body, () => creatorView(this, body));
    } else if (this.page === "finance") {
      watch(src.finance);
      render(body, () => financeView(this, body));
    } else if (this.page === "study") {
      watch(...cfg.projects.filter((p) => p.learning).map((p) => p.path));
      render(body, async () =>
        this.projectsCard(body, await this.plugin.taskGroups(true), true),
      );
    } else {
      let shared;
      const get = () => (shared ??= tasks());
      const page = cfg.pages.find((p) => p.id === this.page);
      for (const w of page?.widgets ?? []) {
        const card = el(body, "section", "", "dd-card");
        if (w.kind === "note") {
          button(card, titleOf(w.path), () => this.plugin.openNote(w.path), {
            icon: "file-text",
          });
          continue;
        }
        render(card, async () => {
          const groups = await get();
          if (w.kind === "tasks") {
            el(card, "h2", this.t(...cards.tasks));
            return this.taskCard(card, groups);
          }
          if (w.kind === "progress") {
            el(card, "h2", this.t("Project progress", "项目进度"));
            return this.projectsCard(card, groups);
          }
          el(card, "h2", this.t("Milestones", "里程碑"));
          const milestones = groups.flatMap((g) =>
            g.tasks.filter((x) => x.milestone),
          );
          for (const task of milestones) this.taskRow(card, task);
          if (!milestones.length)
            el(
              card,
              "p",
              this.t(
                "Add a milestone to a project.",
                "在项目中添加第一个里程碑。",
              ),
              "dd-muted",
            );
        });
      }
      if (!page?.widgets.length)
        button(body, this.t("Add a widget", "添加组件"), () =>
          this.plugin.openSettings("modules"),
        );
    }
    await Promise.all(guards);
    if (focus && revision === this.revision)
      this.contentEl
        .querySelector('[data-focus="' + CSS.escape(focus) + '"]')
        ?.focus({ preventScroll: true });
  }
  card(parent, key) {
    const card = el(parent, "section", "", "dd-card dd-" + key);
    card.dataset.card = key;
    card.style.setProperty(
      "--dd-accent",
      this.plugin.cfg.colors[key] || cards[key][2],
    );
    const head = el(card, "div", "", "dd-card-head");
    icon(head, cards[key][3]);
    el(head, "h2", this.t(...cards[key]));
    return card;
  }
  taskRow(parent, task, allowSchedule = false) {
    const r = el(
      parent,
      "div",
      "",
      "dd-task-row" + (task.done ? " is-done" : ""),
    );
    const check = iconButton(
      r,
      this.t("Toggle task", "切换完成状态") + " · " + task.label,
      task.done ? "circle-check" : "circle",
      async () => {
        await this.plugin.notes.changeTask(task, "done", !task.done);
        this.undo = { ...task, done: !task.done };
        await this.refresh();
      },
    );
    check.setAttribute("aria-pressed", String(task.done));
    check.dataset.focus = task.id;
    button(
      r,
      task.label,
      () =>
        this.plugin.openNote(
          task.path,
          task.block
            ? "#^" + task.block
            : task.section
              ? "#" + task.section
              : "",
        ),
      { cls: "dd-text" },
    );
    if (allowSchedule) {
      const selected = task.day === this.today;
      iconButton(
        r,
        selected
          ? this.t("Remove from today", "移出今天")
          : this.t("Plan for today", "安排到今天"),
        selected ? "calendar-check" : "calendar-plus",
        async () => {
          await this.plugin.notes.changeTask(
            task,
            "day",
            selected ? "" : this.today,
          );
          await this.refresh();
        },
      );
    }
  }
  addTask(path, day = "", milestone = false) {
    const label = milestone
      ? this.t("Add milestone", "添加里程碑")
      : this.t("Add task", "添加待办");
    form(
      this.plugin,
      label,
      [{ key: "name", label: this.t("Title", "名称"), required: true }],
      async (v) => {
        await this.plugin.notes.addTask(path, v.name, day, milestone);
        await this.refresh();
      },
    );
  }
  taskCard(card, groups) {
    for (const g of groups)
      if (g.error)
        el(
          card,
          "small",
          g.path + " · " + this.plugin.errorText(g.error),
          "dd-error",
        );
    const rows = groups.flatMap((g) => g.tasks);
    const list = rows
      .filter((t) => t.day === this.today)
      .sort((a, b) => Number(a.done) - Number(b.done));
    const surface = el(card, "div", "", "dd-task-surface");
    for (const task of list) this.taskRow(surface, task);
    const inbox = resolveSources(this.plugin.cfg).inbox;
    button(
      surface,
      list.length
        ? this.t("Add task", "添加待办")
        : this.t("Write your first task", "记第一条待办"),
      () => this.addTask(inbox, this.today),
      { icon: "plus", cls: "dd-link" },
    );
    const unscheduled = rows.filter((t) => t.day !== this.today && !t.done);
    if (unscheduled.length) {
      const more = el(card, "details", "", "dd-disclosure");
      el(
        more,
        "summary",
        this.t("Plan from your notes", "从清单安排") +
          " · " +
          unscheduled.length,
      );
      for (const task of unscheduled) this.taskRow(more, task, true);
    }
    if (this.undo) {
      const previous = this.undo;
      button(
        card,
        this.t("Undo last change", "撤销上次勾选"),
        async () => {
          await this.plugin.notes.changeTask(previous, "done", !previous.done);
          this.undo = null;
          await this.refresh();
        },
        { icon: "undo-2", cls: "dd-link" },
      );
    }
  }
  projectsCard(card, groups, study = false) {
    const projects = groups.filter((g) => g.project);
    for (const { project, tasks, error } of projects) {
      const box = el(card, "article", "", "dd-project");
      const title = el(box, "div", "", "dd-project-title");
      icon(title, study ? "book-open" : "layers");
      button(title, project.name, () => this.plugin.openNote(project.path), {
        cls: "dd-text",
      });
      el(
        title,
        "small",
        tasks.filter((t) => t.done).length + " / " + tasks.length,
        "dd-count",
      );
      const meter = el(box, "progress");
      meter.max = Math.max(1, tasks.length);
      meter.value = tasks.filter((t) => t.done).length;
      if (error) el(box, "small", this.plugin.errorText(error), "dd-error");
      const group = study
        ? [
            ...tasks.filter((t) => !t.done && !t.milestone).slice(0, 1),
            ...tasks.filter((t) => t.milestone),
          ]
        : tasks;
      const preview = group.slice(0, 4);
      for (const item of preview) this.taskRow(box, item, true);
      if (group.length > 4) {
        const rest = el(box, "details");
        el(
          rest,
          "summary",
          this.t("More tasks", "更多待办") + " · " + (group.length - 4),
        );
        for (const item of group.slice(4)) this.taskRow(rest, item, true);
      }
      const actions = el(box, "div", "", "dd-row");
      button(
        actions,
        this.t("Task", "待办"),
        () => this.addTask(project.path),
        { icon: "plus" },
      );
      button(
        actions,
        this.t("Milestone", "里程碑"),
        () => this.addTask(project.path, "", true),
        { icon: "flag" },
      );
    }
    const tools = el(card, "div", "", "dd-row");
    button(
      tools,
      study
        ? this.t("New learning project", "新建学习项目")
        : this.t("New project", "新建项目"),
      () => this.plugin.projectForm(study),
      { icon: "plus" },
    );
    button(
      tools,
      this.t("Link checklist", "关联已有清单"),
      () =>
        pickPath(this.plugin, "file", (path) =>
          this.plugin.projectForm(study, path),
        ),
      { icon: "link", cls: "dd-link" },
    );
  }
  async habitsCard(card) {
    const p = this.plugin,
      cfg = p.cfg,
      data = await p.notes.habits(cfg.root);
    const tiles = el(card, "div", "", "dd-habit-tiles");
    const dow = new Date().getDay();
    for (const [i, h] of data.items.entries()) {
      if (!h.days.includes(dow)) continue;
      const done = h.checks.includes(this.today);
      const b = button(
        tiles,
        h.name,
        async () => {
          await p.notes.editHabits(cfg.root, (d) => {
            const item = d.items.find((x) => x.id === h.id);
            if (!item) throw Error("Habit changed");
            item.checks = done
              ? item.checks.filter((date) => date !== this.today)
              : [...new Set([...item.checks, this.today])];
          });
          await this.refresh();
        },
        { icon: done ? "circle-check" : h.icon || "leaf", cls: "dd-habit" },
      );
      b.dataset.tint = String(i % 4);
      b.setAttribute("aria-pressed", String(done));
      el(
        b,
        "small",
        h.checks.length +
          " " +
          this.t(h.checks.length === 1 ? "day" : "days", "天"),
      );
    }
    const tools = el(card, "div", "", "dd-row");
    button(tools, this.t("Add habit", "添加习惯"), () => p.habitForm(), {
      icon: "plus",
    });
    if (data.items.length) {
      const details = el(card, "details", "", "dd-disclosure");
      el(details, "summary", this.t("Habit history", "打卡历史"));
      for (const h of data.items) {
        const line = el(details, "div", "", "dd-history");
        el(line, "strong", h.name);
        el(
          line,
          "small",
          [...h.checks].sort().reverse().join(" · ") ||
            this.t("No check-ins yet", "暂无打卡记录"),
        );
        button(line, this.t("Edit habit", "编辑习惯"), () => p.habitForm(h), {
          icon: "pencil",
          cls: "dd-link",
        });
      }
    }
  }
  async journalCard(card) {
    const p = this.plugin,
      cfg = p.cfg,
      days = recentDays(15 * 7),
      written = await p.notes.journalDays(cfg, days);
    const grid = el(card, "div", "", "dd-heatmap");
    grid.setAttribute("aria-label", this.t("Last 15 weeks", "近 15 周"));
    for (const day of days) {
      const cell = el(grid, "button", "", "dd-cell");
      cell.type = "button";
      cell.dataset.written = String(written.has(day));
      cell.title = day;
      cell.setAttribute(
        "aria-label",
        day +
          " · " +
          (written.has(day)
            ? this.t("Written", "已写")
            : this.t("No entry", "未写")),
      );
      cell.onclick = () => p.editDiary(day).catch((e) => p.fail(e));
    }
    el(
      card,
      "small",
      this.t("Past 15 weeks", "近 15 周") +
        " · " +
        written.size +
        " " +
        this.t(written.size === 1 ? "day written" : "days written", "天有记录"),
      "dd-muted",
    );
    const tools = el(card, "div", "", "dd-row");
    button(
      tools,
      this.t("Write today", "写今天日记"),
      () => p.editDiary(this.today),
      { icon: "pen-line" },
    );
    if (!cfg.sources.journal)
      button(
        tools,
        this.t("Choose folder", "选择日记目录"),
        () => p.openSettings("sources"),
        { cls: "dd-link" },
      );
  }
  async excerptCard(card, key) {
    const p = this.plugin,
      revision = this.revision,
      rows = await p.excerpts(
        key,
        () => !this.closed && revision === this.revision,
      );
    if (this.closed || revision !== this.revision) return;
    if (!rows.length) {
      button(
        card,
        this.t("Choose reading source", "选择摘录来源"),
        () => p.openSettings("sources"),
        { icon: "folder-open" },
      );
      return;
    }
    const at = Math.max(0, Math.min(this.index[key], rows.length - 1));
    this.index[key] = at;
    const entry = rows[at],
      expanded = this.expanded.has(key);
    const paragraph = el(
      card,
      "blockquote",
      entry.text,
      "dd-quote" + (expanded ? " is-expanded" : ""),
    );
    const tools = el(card, "div", "", "dd-excerpt-tools");
    button(
      tools,
      entry.title,
      () =>
        p.openNote(
          entry.ref.path,
          entry.ref.block
            ? "#^" + entry.ref.block
            : entry.ref.section
              ? "#" + entry.ref.section
              : "",
        ),
      { cls: "dd-source" },
    );
    const wrap = el(tools, "div", "", "dd-row");
    const prev = iconButton(
      wrap,
      this.t("Previous excerpt", "上一条"),
      "chevron-left",
      () => {
        this.index[key]--;
        this.expanded.delete(key);
        return this.refresh();
      },
    );
    prev.disabled = at === 0;
    el(wrap, "small", at + 1 + " / " + rows.length);
    const next = iconButton(
      wrap,
      this.t("Next excerpt", "下一条"),
      "chevron-right",
      () => {
        this.index[key]++;
        this.expanded.delete(key);
        return this.refresh();
      },
    );
    next.disabled = at === rows.length - 1;
    const more = button(
      card,
      expanded ? this.t("Collapse", "收起") : this.t("Expand", "展开"),
      () => {
        if (expanded) this.expanded.delete(key);
        else this.expanded.add(key);
        return this.refresh();
      },
      { cls: "dd-link" },
    );
    const measure = () => {
      more.hidden =
        !expanded && paragraph.scrollHeight <= paragraph.clientHeight + 1;
    };
    const obs = new ResizeObserver(measure);
    obs.observe(paragraph);
    this.cleanup(() => obs.disconnect());
    measure();
  }
}
