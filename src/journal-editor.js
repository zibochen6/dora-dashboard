import { Modal } from "obsidian";
import { el, button } from "./ui.js";

export class JournalEditor extends Modal {
  constructor(plugin, day, opened, key) {
    super(plugin.app);
    Object.assign(this, { plugin, day, opened, key });
  }
  close() {
    if (!this.saving || !this.plugin.active) super.close();
  }
  onOpen() {
    const { plugin, day, key, opened } = this;
    const t = (en, zh) => plugin.t(en, zh);
    this.titleEl.setText(day);
    this.modalEl.addClass("dd-modal");
    const body = el(this.contentEl, "form", "", "dd-form");
    const label = el(body, "label", "", "dd-field");
    el(label, "span", t("Journal entry", "日记正文"));
    const input = this.input = el(label, "textarea");
    input.value = plugin.journalDrafts.get(key)?.text ?? opened.text;
    const status = el(body, "p", "", "dd-muted");
    status.setAttribute("role", "status");
    if (plugin.journalDrafts.has(key)) status.textContent = t("Draft restored", "已恢复草稿");
    const actions = el(body, "div", "", "dd-row");
    const discard = button(actions, t("Discard draft", "放弃草稿"), () => {
      plugin.journalDrafts.delete(key);
      this.close();
    });
    const keepDraft = () => {
      const dirty = input.value !== opened.text;
      if (dirty) plugin.journalDrafts.set(key, { opened, text: input.value });
      else plugin.journalDrafts.delete(key);
      discard.hidden = !dirty;
      confirm.hidden = true;
    };
    if (opened.file) button(actions, t("Open original note", "打开原文"), () => plugin.openNote(opened.file.path));
    const error = el(body, "div", "", "dd-error");
    error.setAttribute("role", "alert");
    const copy = button(actions, t("Copy draft", "复制草稿"), async () => {
      await input.ownerDocument.defaultView.navigator.clipboard.writeText(input.value);
      status.textContent = t("Draft copied", "已复制草稿");
    });
    copy.hidden = true;
    const row = el(body, "div", "", "dd-form-actions");
    button(row, t("Close", "关闭"), () => this.close());
    const save = el(row, "button", t("Save", "保存"), "mod-cta");
    save.type = "submit";
    const confirm = button(row, t("Clear this day’s text", "确认清空当天正文"), () => commit(true));
    confirm.hidden = true;
    const commit = async (clear) => {
      if (this.saving) return;
      if (opened.text.trim() && !input.value.trim() && !clear) {
        status.textContent = t("This will clear the text for this day.", "这会清空当天的正文。");
        confirm.hidden = false;
        return;
      }
      this.saving = true;
      input.readOnly = true;
      save.disabled = true;
      try {
        if (plugin.notes.journalPath(plugin.cfg, day) !== opened.path)
          throw Error(t("The journal location changed. Your draft is here.", "日记位置已变化，草稿仍在此处。"));
        await plugin.notes.saveDiary(opened, input.value, clear);
        plugin.journalDrafts.delete(key);
        this.saving = false;
        this.close();
        for (const view of plugin.views) view.schedule();
      } catch (e) {
        error.textContent = plugin.errorText(e);
        copy.hidden = false;
      } finally {
        this.saving = false;
        input.readOnly = false;
        save.disabled = false;
      }
    };
    input.addEventListener("input", keepDraft);
    discard.hidden = input.value === opened.text;
    body.onsubmit = event => { event.preventDefault(); void commit(false); };
    input.focus();
  }
  onClose() {
    this.plugin.journalEditors.delete(this.key);
    this.contentEl.empty();
  }
}
