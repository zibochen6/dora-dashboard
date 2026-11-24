import {
  documentJson,
  makeBlock,
  object,
  readDocumentJson,
  replaceBlock,
} from "./documents.ts";
import { validDay } from "./model.ts";

export const snapshotBlock = "finance-snapshot";
export const flowBlock = "finance-flow";

export const legacyCurrency = "CNY";
const currencies = new Set(Intl.supportedValuesOf("currency"));

export function isCurrency(value: unknown): value is string {
  return typeof value === "string" && currencies.has(value);
}
export class UnsupportedCurrency extends Error {
  readonly label: string;
  constructor(value: unknown) {
    super("Unrecognized ledger currency.");
    this.label = typeof value === "string" ? value.slice(0, 12) : "";
  }
}
function recordCurrency(value: unknown) {
  if (value === undefined) return undefined;
  if (!isCurrency(value)) throw new UnsupportedCurrency(value);
  return value;
}
function currencyForWrite(
  existing: { currency?: string } | null,
  requested?: string,
) {
  const currency = recordCurrency(requested);
  if (
    existing &&
    currency !== undefined &&
    currency !== (existing.currency ?? legacyCurrency)
  ) {
    throw new Error("The currency of an existing record cannot change.");
  }
  return currency ?? existing?.currency;
}

export interface Snapshot {
  currency?: string;
  day: string;
  assets: number;
  liabilities: number;
  net: number;
}

export interface Flow {
  currency?: string;
  month: string;
  income: number;
  expense: number;
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function moneyInput(raw: string): number {
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match)
    throw new Error(
      "Enter a nonnegative amount with up to two decimal places.",
    );
  const value = Number(
    match[1].replaceAll(",", "") + (match[2] ?? "").padEnd(2, "0"),
  );
  if (!amount(value)) throw new Error("Amount exceeds the supported range.");
  return value;
}

function validMonth(value: unknown): value is string {
  return typeof value === "string" && validDay(value + "-01");
}

export function readSnapshot(raw: string): Snapshot {
  const value = readDocumentJson(raw, snapshotBlock);
  if (
    !object(value) ||
    value.version !== 1 ||
    !validDay(value.day) ||
    !amount(value.assetsCents) ||
    !amount(value.liabilitiesCents) ||
    value.netCents !== value.assetsCents - value.liabilitiesCents
  ) {
    throw new Error(
      "Invalid balance snapshot. Check the date, amounts, and net balance.",
    );
  }
  const currency = recordCurrency(value.currency);
  return {
    day: value.day,
    assets: value.assetsCents,
    liabilities: value.liabilitiesCents,
    net: value.netCents,
    ...(currency ? { currency } : {}),
  };
}

export function writeSnapshot(
  old: string | null,
  { day, assets, liabilities, currency }: Omit<Snapshot, "net">,
): string {
  if (!validDay(day) || !amount(assets) || !amount(liabilities)) {
    throw new Error("Invalid snapshot date or amounts.");
  }
  const existing = old === null ? null : readSnapshot(old);
  if (existing && existing.day !== day)
    throw new Error("This note belongs to a different snapshot date.");
  const unit = currencyForWrite(existing, currency);
  const body = documentJson({
    version: 1,
    day,
    ...(unit ? { currency: unit } : {}),
    assetsCents: assets,
    liabilitiesCents: liabilities,
    netCents: assets - liabilities,
  });
  if (old === null)
    return "# " + day + "\n\n" + makeBlock(snapshotBlock, body) + "\n";
  return replaceBlock(old, snapshotBlock, body);
}

export function readFlow(raw: string): Flow {
  const value = readDocumentJson(raw, flowBlock);
  if (
    !object(value) ||
    value.version !== 1 ||
    !validMonth(value.month) ||
    !amount(value.incomeCents) ||
    !amount(value.expenseCents)
  ) {
    throw new Error("Invalid cash flow. Check the month and amounts.");
  }
  const currency = recordCurrency(value.currency);
  return {
    month: value.month,
    income: value.incomeCents,
    expense: value.expenseCents,
    ...(currency ? { currency } : {}),
  };
}

export function writeFlow(
  old: string | null,
  { month, income, expense, currency }: Flow,
): string {
  if (!validMonth(month) || !amount(income) || !amount(expense)) {
    throw new Error("Invalid cash flow month or amounts.");
  }
  const existing = old === null ? null : readFlow(old);
  if (existing && existing.month !== month)
    throw new Error("This note belongs to a different cash flow month.");
  const unit = currencyForWrite(existing, currency);
  const body = documentJson({
    version: 1,
    month,
    ...(unit ? { currency: unit } : {}),
    incomeCents: income,
    expenseCents: expense,
  });
  if (old === null)
    return "# " + month + "\n\n" + makeBlock(flowBlock, body) + "\n";
  return replaceBlock(old, flowBlock, body);
}
