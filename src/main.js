import { Plugin, Notice, SecretComponent, getLanguage } from "obsidian";
import { configFrom, renamed } from "./config.js";
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
import { button, el, form, row } from "./ui.js";

export default class DoraDashboard extends Plugin {
  async onload() {
    this.views = new Set();
    this.queue = Promise.resolve();
    this.jobs = new Map();
    this.active = true;
    const raw = await this.loadData();
    this.cfg = configFrom(raw);
    if (raw && raw.version !== 1) await this.saveData(this.cfg);
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
      "This journal changed elsewhere. Keep your draft and reopen it":
        "日记已在别处修改，请保留草稿并重新打开。",
      "Source note is missing": "找不到来源笔记，请重新绑定。",
      "Choose a visible vault path": "请选择库内可见路径。",
      "Choose a file inside this vault": "请选择当前库中的实际文件。",
      "A folder already uses this name": "这个名称已被一个文件夹使用。",
      "Invalid habit note": "习惯笔记格式有误，请检查原文。",
    };
    return this.uiLanguage() === "zh" ? labels[msg] || msg : msg;
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
      if (
        !next.modules.weread ||
        before.wereadSecret !== next.wereadSecret ||
        before.root !== next.root ||
        before.sources.highlights !== next.sources.highlights
      )
        this.cancel("weread");
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
    this.jobs.get(kind)?.abort();
    this.jobs.delete(kind);
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
  async syncBooks(test = false) {
    if (!this.cfg.modules.weread)
      throw Error(this.t("Enable WeRead first", "请先启用微信读书同步"));
    const key = this.getSecret(this.cfg.wereadSecret);
    if (!key)
      throw Error(this.t("Select a WeRead secret", "请选择微信读书密钥"));
    const signal = this.jobSignal("weread"),
      service = new OfficialWeread(this.notes, {
        cacheFolder: this.bookCache(),
        readingFolder: this.cfg.sources.highlights,
      });
    if (test) {
      await service.test(key, signal);
      if (this.isCurrent("weread", signal))
        new Notice(this.t("Connected to WeRead", "微信读书连接成功"));
      return;
    }
    const result = await service.sync(key, signal, () => {});
    if (this.isCurrent("weread", signal)) {
      new Notice(
        this.t("Updated books", "已更新书籍") +
          " · " +
          result.updated +
          (result.failed
            ? " / " + this.t("failed", "失败") + " " + result.failed
            : ""),
      );
      for (const view of this.views) view.schedule();
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
  projectForm(learning = false, existing = "") {
    const p = this;
    form(
      this,
      this.t("Project", "项目"),
      [
        {
          key: "name",
          label: this.t("Project name", "项目名称"),
          required: true,
          value: existing ? titleOf(existing) : "",
        },
        {
          key: "kind",
          label: this.t("Type", "类型"),
          value: learning ? "learning" : "project",
          options: [
            ["project", this.t("Project", "普通项目")],
            ["learning", this.t("Learning", "学习项目")],
          ],
        },
      ],
      async ({ name, kind }) => {
        const id = uniqueId(),
          safe = name
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
            .replace(/^[. ]+|[. ]+$/g, "")
            .trim();
        if (!safe) throw Error(p.t("Enter a project name", "请填写项目名称"));
        const path = existing || this.cfg.root + "/Projects/" + safe + ".md";
        if (this.cfg.projects.some((x) => x.path === path))
          throw Error(this.t("Checklist already linked", "这份清单已关联"));
        if (!existing)
          await this.notes.updateDocument(path, (raw) => {
            if (raw !== null)
              throw Error(
                this.t(
                  "Choose Link checklist to use the existing note",
                  "已有同名笔记，请用「关联已有清单」",
                ),
              );
            return "# " + safe + "\n";
          });
        await this.update((cfg) => {
          if (cfg.projects.some((x) => x.path === path))
            throw Error(this.t("Checklist already linked", "这份清单已关联"));
          cfg.projects.push({ id, name, path, learning: kind === "learning" });
        });
      },
    );
  }
  habitForm(habit) {
    const t = (en, zh) => this.t(en, zh);
    const weekdays = [
      t("Sun", "周日"),
      t("Mon", "周一"),
      t("Tue", "周二"),
      t("Wed", "周三"),
      t("Thu", "周四"),
      t("Fri", "周五"),
      t("Sat", "周六"),
    ];
    const fields = [
      {
        key: "name",
        label: t("Habit name", "习惯名称"),
        value: habit?.name ?? "",
      },
    ];
    if (!habit)
      fields.push({
        key: "preset",
        label: t("Optional example", "可选示例"),
        options: [
          ["", "—"],
          ["reading", t("Reading", "阅读")],
          ["exercise", t("Exercise", "健身")],
          ["music", t("Music practice", "练琴")],
        ],
      });
    for (let i = 0; i < 7; i++)
      fields.push({
        key: "day" + i,
        label: weekdays[i],
        options: [
          ["on", t("Scheduled", "计划日")],
          ["off", t("Rest", "休息日")],
        ],
        value: !habit || habit.days.includes(i) ? "on" : "off",
      });
    form(this, t("Habit", "习惯"), fields, async (v) => {
      const examples = {
        reading: [t("Reading", "阅读"), "book-open"],
        exercise: [t("Exercise", "健身"), "dumbbell"],
        music: [t("Music practice", "练琴"), "music-2"],
      };
      const name = v.name || examples[v.preset]?.[0];
      if (!name)
        throw Error(
          t("Enter a name or choose an example", "填写名称或选择示例"),
        );
      const days = weekdays
        .map((_, i) => i)
        .filter((i) => v["day" + i] === "on");
      if (!days.length)
        throw Error(t("Choose at least one day", "至少选择一个计划日"));
      await this.notes.editHabits(this.cfg.root, (data) => {
        if (habit) {
          const row = data.items.find((h) => h.id === habit.id);
          if (!row) throw Error(t("Habit changed", "习惯已变化"));
          Object.assign(row, { name, days });
        } else
          data.items.push({
            id: uniqueId(),
            name,
            days,
            checks: [],
            icon: examples[v.preset]?.[1] || "sprout",
          });
      });
      for (const view of this.views) view.schedule();
    });
  }
  async editDiary(day) {
    const opened = await this.notes.diary(this.cfg, day);
    form(
      this,
      day,
      [
        {
          key: "text",
          label: this.t("Journal entry", "日记正文"),
          type: "textarea",
          value: opened.text,
        },
      ],
      async (v) => {
        await this.notes.saveDiary(opened, v.text);
        for (const view of this.views) view.schedule();
      },
    );
  }
  async excerpts(kind, isVisible = () => true) {
    const cfg = this.cfg,
      source = cfg.sources[kind],
      rows = [];
    for (const file of source ? this.notes.noteList(source) : []) {
      if (!isVisible() || this.cfg.sources[kind] !== source) return [];
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
          !this.cfg.modules.weread ||
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
