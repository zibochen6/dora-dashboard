import { Plugin, Notice, SecretComponent, getLanguage } from "obsidian";
import { configFrom, renamed } from "./config.js";
import { JournalEditor } from "./journal-editor.js";
import { BoardView, viewType } from "./dashboard.js";
import { Notes, resolveSources, titleOf, uniqueId } from "./storage.js";
import { dayKey, visiblePath } from "./model.ts";
import { parseReadingBook, parseThinking } from "./reading.ts";
import { OfficialWeread } from "./weread-official.ts";
import {
  isWereadBookPath,
  parseWereadCache,
  wereadCacheFolder,
} from "./weread-cache.ts";
import { MediaController } from "./media-controller.ts";
import { egoCollector } from "./media-collector.ts";
import { DashboardSettings, SettingsDialog } from "./settings.js";
import { button, el, form, pickPath, row, iconButton } from "./ui.js";

export default class DoraDashboard extends Plugin {
  async onload() {
    this.views = new Set();
    this.journalDrafts = new Map();
    this.journalEditors = new Map();
    this.bookListeners = new Set();
    this.bookState = { phase: "idle" };
    this.queue = Promise.resolve();
    this.jobs = new Map();
    this.active = true;
    const raw = await this.loadData();
    this.cfg = configFrom(raw);
    if (raw && raw.version !== this.cfg.version) await this.saveData(this.cfg);
    this.notes = new Notes(this.app.vault);
    this.registerView(viewType, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new DashboardSettings(this.app, this));
    this.addRibbonIcon(
      "layout-dashboard",
      this.t("Open dashboard", "打开看板"),
      () => this.openDashboard().catch((e) => this.fail(e)),
    );
    this.addCommand({
      id: "open",
      name: this.t("Open dashboard", "打开看板"),
      callback: () => this.openDashboard().catch((e) => this.fail(e)),
    });
    this.registerEvent(
      this.app.vault.on("rename", (file, from) => {
        const to = file.path;
        if (visiblePath(to))
          void this.update((c) => renamed(c, from, to)).catch((e) =>
            this.fail(e),
          );
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.active && this.cfg.openOnStartup)
        void this.openDashboard().catch((e) => this.fail(e));
    });
  }
  onunload() {
    this.active = false;
    for (const editor of this.journalEditors.values()) editor.close();
    this.journalDrafts.clear();
    this.bookListeners.clear();
    for (const c of this.jobs.values()) c.abort();
    this.jobs.clear();
    void this.media?.stop();
    this.settingsDialog?.close();
  }
  t(en, zh) {
    return this.uiLanguage() === "zh" ? zh : en;
  }
  uiLanguage() {
    const lang = this.cfg?.language;
    return (lang === "auto" || !lang ? getLanguage() : lang)
      .toLowerCase()
      .startsWith("zh")
      ? "zh"
      : "en";
  }
  errorText(error) {
    const msg = error?.message || String(error);
    const labels = {
      "Task changed. Reopen the source note":
        "这条待办已变化，请重新打开原笔记。",
      "The task source is no longer linked": "这条待办的来源已取消关联。",
      "This task now has nested content. Open the source note": "这条待办已添加子项，请打开原笔记查看。",
      "Enter a single-line task title": "请填写单行待办标题。",
      "Edit inline comments and task markers in the source note": "请在原笔记中编辑这条待办的行内注释或任务标记。",
      "The task title could not be saved. Check the Markdown format": "无法保存这个待办标题，请检查 Markdown 格式。",
      "This journal changed elsewhere. Keep your draft and reopen it":
        "原笔记已在别处修改，草稿仍在这里。",
      "Source note is missing": "找不到来源笔记，请重新绑定。",
      "Choose a visible vault path": "请选择库内可见路径。",
      "Choose a file inside this vault": "请选择当前库中的实际文件。",
      "A folder already uses this name": "这个名称已被一个文件夹使用。",
      "Open the original note to edit this ambiguous date heading": "这个标题中的日期含义不明确，请打开日记原文编辑。",
      "Close the open properties, code block or comment in the original journal": "请先在日记原文中补全未闭合的属性块、代码块或注释。",
      "Close the properties block in the source note first": "请先在原笔记中补全属性块的结束标记。",
      "Invalid habit note": "习惯笔记格式有误，请检查原文。",
    };
    if (this.uiLanguage() === "zh") return labels[msg] || msg;
    return ({
      "This journal changed elsewhere. Keep your draft and reopen it": "This note changed elsewhere. Your draft is still here.",
      "这一天的日记在别处被修改了。请复制未保存的文字，再从原日记查看最新内容。": "This entry changed elsewhere. Your draft is still here.",
      "当天有多个日期段，请打开日记原文编辑。": "Several sections have this date. Open the original note to edit them.",
      "无法定位当天日记，请检查月记末尾是否有未闭合的代码块或注释。": "Check the original note for an unclosed code block or comment.",
      "请使用比当天日期更深的 Markdown 标题（例如 ###），以免覆盖其他日记段落。": "Use a heading below the date heading so other journal entries stay intact.",
    })[msg] || msg;
  }
  fail(error) {
    new Notice(this.errorText(error));
  }
  async openDashboard() {
    const leaf =
      this.app.workspace.getLeavesOfType(viewType)[0] ||
      this.app.workspace.getLeaf("tab");
    if (leaf.getViewState().type !== viewType)
      await leaf.setViewState({ type: viewType, active: true });
    if (leaf.isDeferred) await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  openSettings(group = "appearance") {
    this.settingsDialog?.close();
    this.settingsDialog = new SettingsDialog(this, group);
    this.settingsDialog.open();
  }
  async openNote(path, fragment = "") {
    await this.notes.guard(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) throw Error(this.t("Source note is missing", "找不到来源笔记"));
    if (fragment)
      await this.app.workspace.openLinkText(path + fragment, "", true);
    else await this.app.workspace.getLeaf("tab").openFile(file);
  }
  feedback(label, undo) {
    this.lastAction = { label, undo };
    for (const view of this.views) view.schedule();
  }
  feedbackBar(parent, redraw) {
    const action = this.lastAction;
    if (!action) return;
    const bar = el(parent, "div", "", "dd-feedback");
    const message = el(bar, "span", action.label);
    message.setAttribute("role", "status");
    button(bar, this.t("Undo", "撤销"), async () => {
      if (this.lastAction !== action || action.pending) return;
      action.pending = true;
      try {
        await action.undo();
        if (this.lastAction === action) this.lastAction = null;
        for (const view of this.views) view.schedule();
        redraw();
      } catch (error) {
        message.textContent = this.errorText(error);
      } finally { action.pending = false; }
    }, { icon: "undo-2", cls: "dd-link" });
    iconButton(bar, this.t("Dismiss message", "收起提示"), "x", () => {
      if (this.lastAction === action && !action.pending) {
        this.lastAction = null;
        for (const view of this.views) view.schedule();
        redraw();
      }
    });
  }
  update(mutator) {
    const action = this.queue.then(async () => {
      const before = this.cfg,
        draft = structuredClone(before);
      if (mutator(draft) === false) return;
      const next = configFrom(draft);
      const aiChanged = JSON.stringify(before.ai) !== JSON.stringify(next.ai);
      if (aiChanged && before.modules.ai) next.modules.ai = false;
      await this.saveData(next);
      this.cfg = next;
      if (
        aiChanged ||
        !next.modules.ai ||
        before.language !== next.language ||
        next.root !== before.root
      )
        this.cancel("ai");
      if (before.modules.weread !== next.modules.weread || before.wereadSecret !== next.wereadSecret ||
          before.root !== next.root || before.sources.highlights !== next.sources.highlights) {
        this.cancel("weread");
        this.setBookState({ phase: "idle" });
      }
      if (
        !next.modules.creator ||
        !next.modules.media ||
        before.root !== next.root ||
        JSON.stringify(before.accounts) !== JSON.stringify(next.accounts)
      ) {
        this.cancel("account");
        const old = this.media;
        this.media = null;
        await old?.stop();
      }
      for (const view of this.views) view.schedule();
    });
    this.queue = action.catch(() => {});
    return action;
  }
  cancel(kind) {
    const job = this.jobs.get(kind);
    if (!job) return;
    job.abort();
    this.jobs.delete(kind);
    if (kind === "weread") this.setBookState({ phase: "cancelled" });
  }
  jobSignal(kind) {
    this.cancel(kind);
    const ctrl = new AbortController();
    this.jobs.set(kind, ctrl);
    return ctrl.signal;
  }
  isCurrent(kind, signal) {
    return (
      this.active && this.jobs.get(kind)?.signal === signal && !signal.aborted
    );
  }
  getSecret(ref) {
    return ref ? this.app.secretStorage?.getSecret(ref) : null;
  }
  secretSetting(parent, label, ref, onChange) {
    const box = row(parent, label);
    if (!this.app.secretStorage || typeof SecretComponent !== "function") {
      el(
        box,
        "small",
        this.t(
          "Update Obsidian to use the keychain.",
          "请先更新 Obsidian 以使用密钥库。",
        ),
      );
      return;
    }
    new SecretComponent(this.app, box)
      .setValue(ref || "")
      .onChange((v) =>
        Promise.resolve(onChange(v || "")).catch((e) => this.fail(e)),
      );
  }
  bookCache() {
    const ref = this.cfg.wereadSecret;
    return this.cfg.modules.weread
      ? wereadCacheFolder(this.cfg.root, ref, this.getSecret(ref))
      : "";
  }
  setBookState(state) {
    this.bookState = state;
    for (const listener of this.bookListeners) {
      if (listener.host.isConnected) listener.draw();
      else this.bookListeners.delete(listener);
    }
  }
  async syncBooks(test = false) {
    if (this.jobs.has("weread")) return;
    if (!this.cfg.modules.weread) throw Error(this.t("Enable WeRead first", "请先启用微信读书同步"));
    const key = this.getSecret(this.cfg.wereadSecret);
    if (!key) throw Error(this.t("Select a WeRead secret", "请选择微信读书密钥"));
    const signal = this.jobSignal("weread");
    const service = new OfficialWeread(this.notes, { cacheFolder: this.bookCache(), readingFolder: this.cfg.sources.highlights });
    this.setBookState({ phase: test ? "testing" : "running" });
    try {
      if (test) {
        await service.test(key, signal);
        if (this.isCurrent("weread", signal)) this.setBookState({ phase: "connected" });
      } else {
        const result = await service.sync(key, signal, (done, total) => {
          if (this.isCurrent("weread", signal)) this.setBookState({ phase: "running", done, total });
        });
        if (this.isCurrent("weread", signal)) {
          this.setBookState({ phase: "done", ...result });
          for (const view of this.views) view.schedule();
        }
      }
    } catch (error) {
      if (this.isCurrent("weread", signal)) this.setBookState({ phase: "failed", test, message: this.errorText(error) });
    } finally {
      if (this.isCurrent("weread", signal)) this.jobs.delete("weread");
    }
  }
  async mediaController() {
    if (!this.active || !this.cfg.modules.creator || !this.cfg.modules.media)
      return null;
    if (!this.media)
      this.media = new MediaController(
        this.notes,
        egoCollector,
        this.cfg.accounts,
        this.cfg.root,
      );
    return this.media;
  }
  async syncMedia() {
    const ctl = await this.mediaController();
    if (ctl) await ctl.enter(true);
  }
  async taskGroups(onlyStudy = false, includeInbox = true) {
    const cfg = this.cfg,
      src = resolveSources(cfg);
    const groups = cfg.projects
      .filter((x) => !onlyStudy || x.learning)
      .map((project) => ({ path: project.path, project }));
    if (!onlyStudy && includeInbox && !groups.some((g) => g.path === src.inbox))
      groups.unshift({ path: src.inbox });
    return Promise.all(
      groups.map(async (group) => {
        try {
          return { ...group, tasks: await this.notes.tasks(group.path) };
        } catch (error) {
          return { ...group, tasks: [], error };
        }
      }),
    );
  }
  async unlinkProject(opened, label = this.t("Project removed", "已删除项目")) {
    const saved = structuredClone(opened);
    let index, nextId;
    await this.update(cfg => {
      index = cfg.projects.findIndex(project => project.id === saved.id);
      if (index < 0 || JSON.stringify(cfg.projects[index]) !== JSON.stringify(saved))
        throw Error(this.t("The project changed. Reopen the dialog", "项目信息已变更，请重新打开操作窗口"));
      nextId = cfg.projects[index + 1]?.id;
      cfg.projects.splice(index, 1);
    });
    this.feedback(label + " · " + saved.name, () => this.update(cfg => {
      if (cfg.projects.some(project => project.id === saved.id || project.path === saved.path ||
        project.name.trim().toLowerCase() === saved.name.trim().toLowerCase()))
        throw Error(this.t("A matching project is already linked", "已有相同项目或关联清单，请核对当前项目"));
      const successor = cfg.projects.findIndex(project => project.id === nextId);
      cfg.projects.splice(successor >= 0 ? successor : Math.min(index, cfg.projects.length), 0, structuredClone(saved));
    }));
  }
  removeProject(project) {
    return form(this, this.t("Delete project", "删除项目"), [], () => this.unlinkProject(project), {
      submit: this.t("Delete", "删除"),
      description: this.t(
        `Remove “${project.name}” from the dashboard. The checklist and its history stay in the source note.`,
        `将「${project.name}」从看板移除。原清单和历史记录保存在来源笔记中。`,
      ),
    });
  }
  projectForm({ learning = false, existing = "", project: opened, afterSave } = {}) {
    const t = (en, zh) => this.t(en, zh);
    const fields = [
      {
        key: "name",
        label: this.t("Project name", "项目名称"),
        required: true,
        value: opened?.name ?? (existing ? titleOf(existing) : ""),
      },
      {
        key: "kind",
        label: this.t("Type", "类型"),
        value: (opened?.learning ?? learning) ? "learning" : "project",
        options: [
          ["project", this.t("Project", "普通项目")],
          ["learning", this.t("Learning", "学习项目")],
        ],
      },
    ];
    if (!opened) fields.pop();
    let chosen = existing;
    const title = opened
      ? t("Edit project", "编辑项目")
      : learning ? t("New learning project", "新建学习项目") : t("New project", "新建项目");
    return form(this, title, fields, async ({ name, kind = learning ? "learning" : "project" }) => {
      const linked = chosen;
      if (!name || name.length > 100 || /[\r\n]/.test(name))
        throw Error(t("Enter a project name of 1–100 characters", "请输入 1–100 个字符的项目名称"));
      const comparableName = name.toLowerCase();
      const requireUniqueName = (cfg) => {
        if (cfg.projects.some(project => project.id !== opened?.id && project.name.trim().toLowerCase() === comparableName)) {
          throw Error(t("A project already uses that name", "已有同名项目"));
        }
      };
      if (opened) {
        await this.update(cfg => {
          const current = cfg.projects.find(x => x.id === opened.id);
          if (!current || current.path !== opened.path || current.name !== opened.name || current.learning !== opened.learning)
            throw Error(t("The project changed. Reopen the editor", "项目信息已变更，请重新打开编辑窗口"));
          if (comparableName !== current.name.trim().toLowerCase()) requireUniqueName(cfg);
          current.name = name;
          current.learning = kind === "learning";
        });
        return;
      }
      requireUniqueName(this.cfg);
      const id = uniqueId(),
        safe = name
          .replace(/[<>:"/\\|?*#[\]\x00-\x1f]/g, " ")
          .replace(/^[. ]+|[. ]+$/g, "")
          .trim();
      if (!linked && !safe) throw Error(t("Enter a project name", "请填写项目名称"));
      const path = linked || this.cfg.root + "/Projects/" + [...safe].slice(0, 55).join("") + ".md";
      if (this.cfg.projects.some((x) => x.path === path))
        throw Error(this.t("Checklist already linked", "这份清单已关联"));
      if (linked) {
        if (!visiblePath(path) || !/\.md$/i.test(path) || (await this.notes.readOptional(path)) === null)
          throw Error(t("Choose an existing Markdown note in this vault", "请选择库内已有 Markdown 笔记"));
      } else {
        await this.notes.updateDocument(path, (raw) => {
          if (raw !== null) throw Object.assign(Error(t("A note with this name already exists.", "已有同名笔记。")), { collisionPath: path });
          return "# " + safe + "\n";
        });
      }
      try {
        await this.update((cfg) => {
          requireUniqueName(cfg);
          if (cfg.projects.some((x) => x.path === path))
            throw Error(this.t("Checklist already linked", "这份清单已关联"));
          cfg.projects.push({ id, name, path, learning: kind === "learning" });
        });
      } catch (error) {
        if (linked) throw error;
        throw Object.assign(Error(t("Checklist created. Link it to retry", "清单已创建，可直接关联重试") + " · " + path, {cause:error}), {collisionPath:path});
      }
      return id;
    }, {
      submit: opened ? t("Save", "保存") : t("Create project", "创建项目"),
      text: existing || undefined, afterSave,
      onError: (e, { err, body, inputs }) => {
        if (!e.collisionPath) return;
        const name = inputs.name.value;
        button(err, t("Open existing note", "查看已有笔记"), () => this.openNote(e.collisionPath));
        button(err, t("Link this note", "关联这篇笔记"), () => {
          if (inputs.name.value !== name) return body.requestSubmit();
          chosen = e.collisionPath;
          body.requestSubmit();
        });
        inputs.name.addEventListener("input", () => { chosen = ""; err.replaceChildren(); }, { once: true });
      },
    });
  }
  habitForm(habit) {
    const t = (en, zh) => this.t(en, zh);
    const root = this.cfg.root;
    const all = [0, 1, 2, 3, 4, 5, 6], work = [1, 2, 3, 4, 5];
    const dayNames = [t("Sun", "周日"), t("Mon", "周一"), t("Tue", "周二"), t("Wed", "周三"), t("Thu", "周四"), t("Fri", "周五"), t("Sat", "周六")];
    const dates = new Set(habit?.days ?? all);
    const preset = dates.size === 7 ? "daily" : dates.size === 5 && work.every(i => dates.has(i)) ? "weekdays" : "custom";
    const examples = [[t("Reading", "阅读"), "book-open"], [t("Exercise", "健身"), "sprout"], [t("Music practice", "练琴"), "music-2"]];
    form(this, t("Habit", "习惯"), [
      { key: "name", label: t("Habit name", "习惯名称"), value: habit?.name, required: true },
      { key: "frequency", label: t("Frequency", "频率"), value: preset, options: [
        ["daily", t("Every day", "每天")], ["weekdays", t("Weekdays", "工作日")], ["custom", t("Custom days", "自定义")],
      ] },
    ], async ({ name, frequency }) => {
      const days = frequency === "daily" ? all : frequency === "weekdays" ? work : all.filter(i => dates.has(i));
      if (!days.length) throw Error(t("Choose at least one day", "至少选择一天"));
      if (this.cfg.root !== root) throw Error(t("The destination changed. Reopen this habit.", "写入位置已更改，请重新打开习惯。"));
      await this.notes.editHabits(root, data => {
        if (habit) {
          const row = data.items.find(h => h.id === habit.id);
          if (!row || row.name !== habit.name || String(row.days) !== String(habit.days)) throw Error(t("Habit changed", "习惯已变化"));
          Object.assign(row, { name, days });
        } else data.items.push({ id: uniqueId(), name, days, checks: [], icon: examples.find(x => x[0] === name)?.[1] ?? "sprout" });
      });
      for (const view of this.views) view.schedule();
    }, { setup: ({ inputs, body, err }) => {
      if (!habit) {
        const presets = el(body, "div", "", "dd-row");
        inputs.name.parentElement.after(presets);
        for (const [name] of examples) button(presets, name, () => { inputs.name.value = name; inputs.name.focus(); }, { cls: "dd-link" });
      }
      const custom = el(body, "fieldset", "", "dd-weekdays");
      err.before(custom);
      el(custom, "legend", t("Scheduled days", "计划日"));
      for (const i of all) {
        const label = el(custom, "label");
        const check = el(label, "input");
        check.type = "checkbox";
        check.checked = dates.has(i);
        check.onchange = () => check.checked ? dates.add(i) : dates.delete(i);
        el(label, "span", dayNames[i]);
      }
      const show = () => { custom.hidden = inputs.frequency.value !== "custom"; };
      inputs.frequency.onchange = show;
      show();
    } });
  }
  chooseSource(id, afterSave) {
    const kind = id === "inbox" ? "file" : ["highlights", "thoughts"].includes(id) ? "any" : "folder";
    const before = this.cfg.sources[id], oldMode = this.cfg.journalMode;
    const save = async (path, mode) => {
      await this.update(cfg => {
        if (cfg.sources[id] !== before || (id === "journal" && cfg.journalMode !== oldMode))
          throw Error(this.t("This source changed. Choose it again.", "来源已变化，请重新选择。"));
        cfg.sources[id] = path;
        if (mode) cfg.journalMode = mode;
        if (["highlights", "thoughts"].includes(id) && !cfg.visible.includes(id)) cfg.visible.push(id);
      });
      afterSave?.();
    };
    pickPath(this, kind, async path => {
      const modes = id === "journal" ? this.notes.journalModes(path) : [];
      if (modes.length < 2) return save(path, modes[0]);
      form(this, this.t("This folder contains daily and monthly notes", "这个目录同时包含日记和月记"), [{
        key: "mode", label: this.t("Write entries to", "日记写入方式"), value: oldMode, options: [
          ["daily", this.t("Daily notes", "每天一篇")], ["monthly", this.t("Monthly notes", "每月一篇")],
        ],
      }], ({ mode }) => save(path, mode), { text: path });
    });
  }
  async editDiary(day) {
    const cfg = this.cfg;
    const key = JSON.stringify([this.notes.journalPath(cfg, day), cfg.journalMode, day]);
    let opened = this.journalDrafts.get(key)?.opened;
    if (!opened) {
      try { opened = await this.notes.diary(cfg, day); }
      catch (error) {
        if (!["Close the properties block in the source note first", "Close the open properties, code block or comment in the original journal", "Open the original note to edit this ambiguous date heading"].includes(error.message)) throw error;
        form(this, day, [], () => this.openNote(this.notes.journalPath(cfg, day)),
          { text: this.errorText(error), submit: this.t("Open original note", "打开原文") });
        return;
      }
    }
    const existing = this.journalEditors.get(key);
    if (existing) { existing.input?.focus(); return; }
    const editor = new JournalEditor(this, day, opened, key);
    this.journalEditors.set(key, editor);
    editor.open();
  }
  async excerpts(kind, isVisible = () => true) {
    const cfg = this.cfg,
      source = cfg.sources[kind],
      rows = [];
    for (const file of source ? this.notes.noteList(source) : []) {
      if (!isVisible() || !this.cfg.visible.includes(kind) || this.cfg.sources[kind] !== source) return [];
      if (file.path.startsWith(cfg.root + "/WeRead/")) continue;
      const raw = await this.notes.readOptional(file.path);
      if (!raw) continue;
      if (kind === "thoughts") rows.push(...parseThinking(raw, file.path));
      else {
        const book = parseReadingBook(raw, file.path).filter(
          (r) => r.kind === "划线",
        );
        if (book.length) rows.push(...book);
        else {
          let section = "",
            quote = [],
            fence = "";
          const flush = () => {
            if (!quote.length) return;
            const text = quote.join(" ").trim();
            quote = [];
            if (text)
              rows.push({
                text: text.replace(/\s+\^[\w-]+$/, ""),
                title: file.basename,
                stamp: "",
                ref: {
                  path: file.path,
                  section,
                  block: text.match(/\s\^([\w-]+)$/)?.[1],
                },
              });
          };
          for (const line of raw.split(/\r?\n/)) {
            const mark = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
            if (mark) {
              flush();
              if (!fence) fence = mark;
              else if (mark[0] === fence[0] && mark.length >= fence.length)
                fence = "";
              continue;
            }
            if (fence) continue;
            if (/^\s*>/.test(line)) quote.push(line.replace(/^\s*>\s?/, ""));
            else {
              flush();
              section = line.match(/^#{1,6}\s+(.+)/)?.[1] ?? section;
            }
          }
          flush();
        }
      }
    }
    const cache = cfg.modules.weread ? this.bookCache() : "";
    if (cache)
      for (const file of this.notes.noteList(cache)) {
        if (
          !isVisible() ||
          !this.cfg.modules.weread || !this.cfg.visible.includes(kind) ||
          this.bookCache() !== cache
        )
          return [];
        if (!isWereadBookPath(file.path, cache)) continue;
        const text = await this.notes.readOptional(file.path);
        rows.push(
          ...parseWereadCache(text, file.path).filter((r) =>
            kind === "highlights" ? r.kind === "划线" : r.kind !== "划线",
          ),
        );
      }
    return rows.sort((a, b) => b.stamp.localeCompare(a.stamp));
  }
  async aiFacts() {
    const fields = this.cfg.ai.fields,
      facts = {};
    if (fields.includes("tasks"))
      facts.tasks = (await this.taskGroups())
        .flatMap((g) => g.tasks)
        .filter((t) => t.day === dayKey())
        .slice(0, 20)
        .map((t) => t.label);
    if (fields.includes("projects"))
      facts.projects = this.cfg.projects.slice(0, 20).map((p) => p.name);
    if (fields.includes("habits"))
      facts.habits = (await this.notes.habits(this.cfg.root)).items
        .filter((h) => h.checks.includes(dayKey()))
        .slice(0, 20)
        .map((h) => h.name);
    return facts;
  }
}
