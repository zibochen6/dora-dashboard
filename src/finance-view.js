import { dayKey, validDay } from "./model.ts";
import {
  flowBlock,
  legacyCurrency,
  UnsupportedCurrency,
  moneyInput,
  readFlow,
  readSnapshot,
  snapshotBlock,
  writeFlow,
  writeSnapshot,
} from "./finance.ts";
import { join, resolveSources } from "./storage.js";
import { button, el, form } from "./ui.js";

const historyLimit = 12;

function decimal(cents) {
  const value = Math.abs(cents);
  return (
    (cents < 0 ? "-" : "") +
    Math.floor(value / 100) +
    "." +
    String(value % 100).padStart(2, "0")
  );
}

function parseAmount(t, text) {
  try {
    return moneyInput(text);
  } catch {
    throw new Error(
      t(
        "Enter a nonnegative amount with up to two decimal places.",
        "请输入非负金额，最多两位小数。",
      ),
    );
  }
}

function currentSource(plugin, folder) {
  return (
    plugin.cfg.modules.finance && resolveSources(plugin.cfg).finance === folder
  );
}

async function ledger(plugin, folder, currency) {
  const snapshots = [],
    flows = [],
    issues = [],
    otherCurrencies = new Map();
  function collect(path, raw, read, rows) {
    try {
      const record = read(raw);
      const unit = record.currency ?? legacyCurrency;
      if (unit === currency) rows.push({ ...record, path, raw });
      else
        otherCurrencies.set(path + ":" + unit, { path, unit, unknown: false });
    } catch (error) {
      if (error instanceof UnsupportedCurrency) {
        otherCurrencies.set(path + ":" + error.label, {
          path,
          unit: error.label,
          unknown: true,
        });
      } else issues.push(path);
    }
  }
  let skipped = 0;
  const files = plugin.notes.noteList(folder);
  for (const file of files) {
    if (!currentSource(plugin, folder) || plugin.cfg.currency !== currency)
      break;
    try {
      const raw = await plugin.notes.readOptional(file.path);
      if (raw === null) {
        issues.push(file.path);
        continue;
      }
      const snapshot = raw.includes("<!-- dora:" + snapshotBlock + " -->");
      const flow = raw.includes("<!-- dora:" + flowBlock + " -->");
      if (!snapshot && !flow) {
        skipped++;
        continue;
      }
      if (snapshot) collect(file.path, raw, readSnapshot, snapshots);
      if (flow) collect(file.path, raw, readFlow, flows);
    } catch {
      issues.push(file.path);
    }
  }
  snapshots.sort((a, b) => b.day.localeCompare(a.day));
  flows.sort((a, b) => b.month.localeCompare(a.month));
  // Duplicate periods have no single authoritative balance. Keep their notes accessible.
  function distinct(rows, field) {
    return rows.filter((row, index) => {
      const duplicate =
        rows[index - 1]?.[field] === row[field] ||
        rows[index + 1]?.[field] === row[field];
      if (duplicate) issues.push(row.path);
      return !duplicate;
    });
  }
  return {
    snapshots: distinct(snapshots, "day"),
    flows: distinct(flows, "month"),
    days: new Set(snapshots.map((row) => row.day)),
    months: new Set(flows.map((row) => row.month)),
    issues: [...new Set(issues)],
    otherCurrencies: [...otherCurrencies.values()],
    skipped,
  };
}

function assertSource(plugin, folder, t) {
  if (!currentSource(plugin, folder))
    throw new Error(
      t(
        "The finance source changed. Reopen this form from the current ledger.",
        "财务来源已变化，请从当前财务页重新打开表单。",
      ),
    );
}

function editRecord(view, folder, currency, kind, existing, knownPeriods) {
  const plugin = view.plugin,
    t = (en, zh) => view.t(en, zh);
  const balance = kind === "balance";
  const assertLedger = () => {
    assertSource(plugin, folder, t);
    if (
      plugin.cfg.currency !== currency ||
      (existing && (existing.currency ?? legacyCurrency) !== currency)
    ) {
      throw new Error(
        t(
          "The ledger currency changed. Reopen the form before saving.",
          "账本币种已更改，请重新打开表单后保存。",
        ),
      );
    }
  };
  assertLedger();
  const period = balance ? "day" : "month";
  const label = balance
    ? t("Balance snapshot", "资产负债快照")
    : t("Monthly cash flow", "月收支");
  const fields = [];
  if (!existing)
    fields.push({
      key: period,
      label: balance ? t("Date", "日期") : t("Month", "月份"),
      type: balance ? "date" : "month",
      value: dayKey().slice(0, balance ? 10 : 7),
      required: true,
    });
  const amounts = balance
    ? [
        ["assets", t("Assets", "资产")],
        ["liabilities", t("Liabilities", "负债")],
      ]
    : [
        ["income", t("Income", "收入")],
        ["expense", t("Expenses", "支出")],
      ];
  for (const [key, name] of amounts) {
    fields.push({
      key,
      label: name + " (" + currency + ")",
      required: true,
      value: existing ? decimal(existing[key]) : "",
    });
  }
  form(
    plugin,
    existing ? label + " · " + existing[period] : label,
    fields,
    async (values) => {
      assertLedger();
      const date = existing?.[period] ?? values[period].trim();
      if (!validDay(balance ? date : date + "-01")) {
        throw new Error(t("Enter a valid calendar date.", "请输入有效日期。"));
      }
      if (!existing && knownPeriods.has(date)) {
        throw new Error(
          t(
            "This period already has a record. Open its existing note to edit it.",
            "这段时间已有记录，请打开已有记录编辑。",
          ),
        );
      }
      const data = { [period]: date, currency };
      for (const [key] of amounts) data[key] = parseAmount(t, values[key]);
      const destination =
        currency === legacyCurrency ? folder : join(folder, currency);
      const path = existing?.path ?? join(destination, date + ".md");
      await plugin.notes.updateDocument(path, (raw) => {
        assertLedger();
        if (raw !== (existing?.raw ?? null))
          throw new Error(
            t(
              "The source changed or the filename is in use. Keep your draft and check the note.",
              "原文已修改或文件名已被使用，请保留当前输入并检查笔记。",
            ),
          );
        return balance ? writeSnapshot(raw, data) : writeFlow(raw, data);
      });
      await view.refresh();
    },
  );
}

function editGoal(view, folder) {
  const plugin = view.plugin,
    t = (en, zh) => view.t(en, zh);
  const { currency } = plugin.cfg;
  const financeGoal = plugin.cfg.financeGoals[currency] ?? "";
  form(
    plugin,
    t("Net worth goal", "净资产目标"),
    [
      {
        key: "goal",
        label: t("Goal amount (clear to remove)", "目标金额（留空可移除）"),
        value: financeGoal,
      },
    ],
    async (values) => {
      assertSource(plugin, folder, t);
      const input = values.goal.trim();
      const cents = input ? parseAmount(t, input) : null;
      if (cents === 0)
        throw new Error(
          t(
            "Enter a positive goal or clear the field.",
            "请输入正数目标，或留空移除目标。",
          ),
        );
      await plugin.update((cfg) => {
        if ((cfg.financeGoals[currency] ?? "") !== financeGoal || cfg.currency !== currency)
          throw new Error(
            t(
              "These settings changed elsewhere. Reopen the goal to edit it.",
              "设置已在别处修改，请重新打开目标后编辑。",
            ),
          );
        if (cents === null) delete cfg.financeGoals[currency];
        else cfg.financeGoals[currency] = decimal(cents);
      });
      await view.refresh();
    },
  );
}

function section(parent, name) {
  const area = el(parent, "section", "", "dd-card");
  el(area, "h2", name);
  return area;
}

function history(view, parent, rows, field, folder, currency, kind, money) {
  const t = (en, zh) => view.t(en, zh);
  if (!rows.length) return;
  const details = el(parent, "details");
  el(details, "summary", t("History", "历史记录") + " · " + rows.length);
  for (const row of rows.slice(0, historyLimit)) {
    const item = el(details, "div", "", "dd-row");
    button(item, row[field], () => view.plugin.openNote(row.path), {
      icon: "file-text",
    });
    el(
      item,
      "span",
      money(kind === "balance" ? row.net : row.income - row.expense),
    );
    button(
      item,
      t("Edit", "编辑"),
      () => editRecord(view, folder, currency, kind, row),
      { icon: "pencil" },
    );
  }
  if (rows.length > historyLimit)
    el(
      details,
      "small",
      t("Showing the latest 12 periods.", "显示最近 12 期。"),
    );
}

export async function financeView(view, parent) {
  const plugin = view.plugin,
    t = (en, zh) => view.t(en, zh);
  const folder = resolveSources(plugin.cfg).finance;
  if (!currentSource(plugin, folder)) return;
  const currency = plugin.cfg.currency;
  const { snapshots, flows, days, months, issues, otherCurrencies, skipped } =
    await ledger(plugin, folder, currency);
  if (!currentSource(plugin, folder) || plugin.cfg.currency !== currency)
    return;
  const units = el(parent, "label", "", "dd-row");
  el(units, "span", t("Ledger currency", "账本币种"));
  const select = el(units, "select");
  const display = new Intl.DisplayNames([plugin.uiLanguage()], { type: "currency" });
  for (const code of Intl.supportedValuesOf("currency"))
    el(select, "option", code + " · " + display.of(code)).value = code;
  select.value = currency;
  select.onchange = () => {
    const code = select.value;
    plugin.update(cfg => { cfg.currency = code; }).catch(e => plugin.fail(e));
  };
  const format = new Intl.NumberFormat(t("en", "zh-CN"), {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const money = (cents) => format.format(decimal(cents));
  const balance = section(parent, t("Balance snapshot", "资产负债快照"));
  const latest = snapshots[0];
  if (latest) {
    el(balance, "small", latest.day);
    el(balance, "h3", t("Net worth", "净资产") + " · " + money(latest.net));
    el(
      balance,
      "p",
      t("Assets", "资产") +
        " " +
        money(latest.assets) +
        " · " +
        t("Liabilities", "负债") +
        " " +
        money(latest.liabilities),
    );
  }
  button(
    balance,
    snapshots.length
      ? t("Add snapshot", "添加快照")
      : t("Record your first snapshot", "记录第一份资产快照"),
    () => editRecord(view, folder, currency, "balance", null, days),
    { icon: "plus" },
  );
  history(view, balance, snapshots, "day", folder, currency, "balance", money);

  const monthly = section(parent, t("Monthly cash flow", "月收支"));
  const recent = flows[0];
  if (recent) {
    el(monthly, "small", recent.month);
    el(
      monthly,
      "h3",
      t("Net cash flow", "净收支") +
        " · " +
        money(recent.income - recent.expense),
    );
    el(
      monthly,
      "p",
      t("Income", "收入") +
        " " +
        money(recent.income) +
        " · " +
        t("Expenses", "支出") +
        " " +
        money(recent.expense),
    );
  }
  button(
    monthly,
    t("Record cash flow", "记录收支"),
    () => editRecord(view, folder, currency, "flow", null, months),
    { icon: "plus" },
  );
  history(view, monthly, flows, "month", folder, currency, "flow", money);

  const goal = section(parent, t("Net worth goal", "净资产目标"));
  if (plugin.cfg.financeGoals[currency]) {
    try {
      const target = moneyInput(plugin.cfg.financeGoals[currency]);
      el(goal, "p", money(target));
      if (target > 0 && latest) {
        const progress = el(goal, "progress");
        progress.max = 100;
        progress.value = Math.max(
          0,
          Math.min(100, (latest.net / target) * 100),
        );
        progress.setAttribute(
          "aria-label",
          t("Progress toward net worth goal", "净资产目标进度"),
        );
        el(goal, "span", Math.round(progress.value) + "%");
      }
    } catch {
      el(
        goal,
        "p",
        t(
          "Invalid goal amount. Edit the goal to correct it.",
          "目标金额格式有误，请重新设置。",
        ),
      );
    }
  }
  button(
    goal,
    plugin.cfg.financeGoals[currency]
      ? t("Edit goal", "编辑目标")
      : t("Set a goal", "设定目标"),
    () => editGoal(view, folder),
    { icon: "target" },
  );
  if (otherCurrencies.length) {
    const details = el(parent, "details");
    el(
      details,
      "summary",
      t(
        "Records in other or unrecognized currencies",
        "其他币种或币种无法识别的记录",
      ) +
        " · " +
        otherCurrencies.length,
    );
    for (const { path, unit, unknown } of otherCurrencies) {
      const label = unknown
        ? t("Unrecognized currency", "币种无法识别") +
          (unit ? " (" + unit + ")" : "")
        : unit;
      button(details, label + " · " + path, () => plugin.openNote(path), {
        icon: "file-text",
      });
    }
  }
  if (issues.length) {
    const details = el(parent, "details");
    el(
      details,
      "summary",
      t("Unreadable or overlapping records", "无法读取或日期重复的记录") +
        " · " +
        issues.length,
    );
    for (const path of issues.slice(0, historyLimit))
      button(details, path, () => plugin.openNote(path), { icon: "file-text" });
  }
  if (skipped)
    el(
      parent,
      "small",
      t("Notes without financial records", "未含财务记录的笔记") +
        " · " +
        skipped,
    );
}
