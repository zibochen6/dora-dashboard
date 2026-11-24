import {
  Modal,
  Notice,
  setIcon,
  FuzzySuggestModal,
  TFile,
  TFolder,
} from "obsidian";
import { visiblePath } from "./model.ts";

export function el(parent, tag, text = "", cls = "") {
  const node = parent.ownerDocument.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  parent.appendChild(node);
  return node;
}
export function icon(parent, id) {
  const item = el(parent, "span", "", "dd-icon");
  setIcon(item, id);
  item.setAttribute("aria-hidden", "true");
  return item;
}
export function button(parent, label, fn, { icon: glyph, cls = "" } = {}) {
  const node = el(parent, "button", "", "dd-button " + cls);
  node.type = "button";
  if (glyph) icon(node, glyph);
  if (label) el(node, "span", label);
  node.addEventListener("click", async (ev) => {
    try {
      await fn(ev);
    } catch (error) {
      new Notice(error?.message || String(error));
    }
  });
  return node;
}
export function iconButton(parent, label, glyph, fn) {
  const b = button(parent, "", fn, { icon: glyph, cls: "dd-icon-button" });
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}
export function form(plugin, title, fields, onSubmit, options = {}) {
  class EditForm extends Modal {
    onOpen() {
      this.titleEl.setText(title);
      this.modalEl.addClass("dd-modal");
      const body = el(this.contentEl, "form", "", "dd-form");
      const inputs = {};
      for (const field of fields) {
        const tag = field.options
          ? "select"
          : field.type === "textarea"
            ? "textarea"
            : "input";
        const label = el(body, "label", "", "dd-field");
        el(label, "span", field.label);
        const input = el(label, tag);
        if (tag === "input") input.type = field.type || "text";
        if (field.options)
          for (const [value, name] of field.options)
            el(input, "option", name).value = value;
        input.value = field.value ?? field.options?.[0]?.[0] ?? "";
        input.required = !!field.required;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.readOnly) input.readOnly = true;
        inputs[field.key] = input;
      }
      if (options.text) el(body, "pre", options.text, "dd-preview");
      const err = el(body, "p", "", "dd-error");
      err.setAttribute("role", "alert");
      const row = el(body, "div", "", "dd-form-actions");
      button(row, plugin.t("Cancel", "取消"), () => this.close());
      const ok = el(
        row,
        "button",
        options.submit || plugin.t("Save", "保存"),
        "mod-cta",
      );
      ok.type = "submit";
      body.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (ok.disabled) return;
        ok.disabled = true;
        err.textContent = "";
        try {
          await onSubmit(
            Object.fromEntries(
              Object.entries(inputs).map(([k, v]) => [
                k,
                v.type === "textarea" ? v.value : v.value.trim(),
              ]),
            ),
          );
          this.close();
        } catch (e) {
          err.textContent = plugin.errorText?.(e) || e.message || String(e);
          ok.disabled = false;
        }
      });
      Object.values(inputs)[0]?.focus();
    }
    onClose() {
      this.contentEl.empty();
    }
  }
  const modal = new EditForm(plugin.app);
  modal.open();
  return modal;
}
export function pickPath(plugin, kind, accept) {
  class VaultPicker extends FuzzySuggestModal {
    getItems() {
      return this.app.vault
        .getAllLoadedFiles()
        .filter(
          (f) =>
            (visiblePath(f.path) || (kind === "folder" && f.isRoot?.())) &&
            ((kind !== "file" && f instanceof TFolder) ||
              (kind !== "folder" &&
                f instanceof TFile &&
                f.extension === "md")),
        );
    }
    getItemText(item) {
      return item.isRoot?.()
        ? plugin.t("Vault root", "笔记库根目录")
        : item.path;
    }
    onChooseItem(item) {
      Promise.resolve(accept(item.path)).catch((error) => plugin.fail(error));
    }
  }
  const picker = new VaultPicker(plugin.app);
  picker.setPlaceholder(
    kind === "folder"
      ? plugin.t("Choose a vault folder", "选择库内目录")
      : plugin.t("Choose a vault source", "选择库内来源"),
  );
  picker.open();
}
export function row(parent, label, detail = "") {
  const entry = el(parent, "div", "", "dd-setting");
  const info = el(entry, "div", "", "dd-setting-info");
  el(info, "strong", label);
  if (detail) el(info, "small", detail, "dd-muted");
  return el(entry, "div", "", "dd-setting-actions");
}
export function section(parent, title, description = "") {
  const box = el(parent, "section", "", "dd-group");
  el(box, "h3", title);
  if (description) el(box, "p", description, "dd-muted");
  return box;
}
export function toggle(parent, label, value, change) {
  const input = el(parent, "input");
  input.type = "checkbox";
  input.checked = value;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", async () => {
    input.disabled = true;
    try {
      await change(input.checked);
    } catch (e) {
      input.checked = !input.checked;
      new Notice(e.message);
    } finally {
      input.disabled = false;
    }
  });
  return input;
}
