import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  moneyInput,
  readFlow,
  readSnapshot,
  writeFlow,
  writeSnapshot,
} from "../src/finance.ts";

const snapshot = { day: "2024-02-29", assets: 1234, liabilities: 5078 };
const flow = { month: "2024-02", income: 0, expense: 100 };

test("convert decimal input to safe integer cents without rounding", () => {
  assert.equal(moneyInput(" 0 "), 0);
  assert.equal(moneyInput("100.1"), 10010);
  assert.equal(moneyInput("1,002.01"), 100201);
  assert.equal(moneyInput("90,071,992,547,409.91"), Number.MAX_SAFE_INTEGER);
  for (const invalid of [
    "-0.01",
    "1,02",
    "0.003",
    "1e9",
    "Infinity",
    "90071992547409.92",
    "",
  ]) {
    assert.throws(() => moneyInput(invalid));
  }
});

test("balance snapshot checks the calendar and both positive and negative net amounts", () => {
  const raw = writeSnapshot(null, snapshot);
  assert.deepEqual(readSnapshot(raw), { ...snapshot, net: -3844 });
  const latest = { ...snapshot, assets: 7000 };
  assert.deepEqual(readSnapshot(writeSnapshot(raw, latest)), {
    ...latest,
    net: 1922,
  });
  assert.throws(() => writeSnapshot(null, { ...snapshot, day: "2025-02-29" }));
  assert.throws(() => writeSnapshot(null, { ...snapshot, liabilities: NaN }));
  assert.throws(() => readSnapshot(raw.replace("-3844", "-4000")));
  assert.throws(() => writeSnapshot(raw.replace("-3844", "-4000"), snapshot));
  assert.throws(() => writeSnapshot(raw, { ...snapshot, day: "2024-03-01" }));
});

test("cash flow handles zero income, overspending, and refuses malformed records", () => {
  const raw = writeFlow(null, flow);
  assert.deepEqual(readFlow(raw), flow);
  assert.throws(() => writeFlow(null, { ...flow, month: "2024-13" }));
  assert.throws(() => writeFlow(null, { ...flow, income: 0.5 }));
  assert.throws(() =>
    readFlow(raw.replace('"expenseCents": 100', '"expenseCents": -100')),
  );
  assert.throws(() => writeFlow(raw, { ...flow, month: "2024-10" }));
});

test("write only the owned block and retain adjacent Markdown and CRLF", () => {
  const original = writeFlow(null, flow);
  const around = ("Notes before\n" + original + "\n笔记补充\n").replaceAll(
    "\n",
    "\r\n",
  );
  const next = writeFlow(around, { ...flow, expense: 200 });
  assert.equal(
    next,
    around.replace('"expenseCents": 100', '"expenseCents": 200'),
  );
  assert.deepEqual(readFlow(next), { ...flow, expense: 200 });
  assert.throws(() => writeSnapshot("# Personal note", snapshot));
  assert.throws(() => writeFlow("", flow));
  assert.throws(() => writeFlow(original + original, flow));
  assert.throws(() => writeFlow(writeSnapshot(null, snapshot), flow));
});
