import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import {
  MAX_RECORDS_PER_KEY,
  appendRunRecord,
  boundedAppend,
  ledgerPathFromEnv,
  percentile,
  summarize,
} from "./run-ledger.mjs";

let ledgerSeq = 0;
function scratchLedgerPath() {
  ledgerSeq += 1;
  return path.join(
    tmpdir(),
    `centraid-mobile-ledger-${process.pid}-${ledgerSeq}.json`
  );
}

function record(overrides = {}) {
  return {
    flow: "tests/agent-e2e-mobile/flows/home-loads.mjs",
    slug: "home-loads",
    platform: "ios",
    device: "1234-ABCD",
    startedAt: "2026-08-30T01:02:03.000Z",
    durationMs: 19_000,
    pass: true,
    failureClass: null,
    failureReason: "",
    lane: "nightly",
    runId: "home-loads-2026-08-30T01-02-03-abcdef",
    commit: "0123456789abcdef",
    ...overrides,
  };
}

test("appendRunRecord round-trips a record through the file", async () => {
  const ledgerPath = scratchLedgerPath();
  try {
    await appendRunRecord(record(), { ledgerPath });
    const written = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    expect(written.version).toBe(1);
    expect(written.records.length).toBe(1);
    expect(written.records[0].slug).toBe("home-loads");
  } finally {
    await fs.rm(ledgerPath, { force: true });
  }
});

test("appendRunRecord bounds the window per flow×platform", () => {
  let ledger = { version: 1, records: [] };
  for (let i = 0; i < MAX_RECORDS_PER_KEY + 25; i += 1) {
    ledger = boundedAppend(ledger, record({ durationMs: i }));
  }
  expect(ledger.records.length).toBe(MAX_RECORDS_PER_KEY);
  expect(ledger.records[0].durationMs).toBe(25);
  expect(ledger.records.at(-1).durationMs).toBe(MAX_RECORDS_PER_KEY + 24);
});

test("the window is per key, so a second platform does not evict the first", () => {
  let ledger = { version: 1, records: [] };
  for (let i = 0; i < MAX_RECORDS_PER_KEY; i += 1) {
    ledger = boundedAppend(ledger, record({ platform: "ios", durationMs: i }));
  }
  ledger = boundedAppend(ledger, record({ platform: "android" }));
  expect(ledger.records.length).toBe(MAX_RECORDS_PER_KEY + 1);
});

test("records are grouped by a stable key sort so a merge conflict is local", () => {
  let ledger = { version: 1, records: [] };
  ledger = boundedAppend(ledger, record({ platform: "ios" }));
  ledger = boundedAppend(ledger, record({ platform: "android" }));
  ledger = boundedAppend(ledger, record({ platform: "ios", durationMs: 2 }));
  expect(ledger.records.map((entry) => entry.platform)).toEqual([
    "android",
    "ios",
    "ios",
  ]);
});

test("percentile is exact on a known sample", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(percentile(oneToHundred, 95)).toBe(95);
  expect(percentile(oneToHundred, 50)).toBe(50);
  expect(percentile(oneToHundred, 100)).toBe(100);
  expect(percentile(oneToHundred, 1)).toBe(1);
});

test("percentile does not depend on input order and has no opinion when empty", () => {
  expect(percentile([30, 10, 20], 50)).toBe(20);
  expect(percentile([], 95)).toBe(null);
});

test("summarize groups by flow×platform", () => {
  const ledger = {
    version: 1,
    records: [
      record({ platform: "ios", durationMs: 10 }),
      record({ platform: "ios", durationMs: 20 }),
      record({ platform: "android", durationMs: 90 }),
    ],
  };
  const summary = summarize(ledger);
  expect(Object.keys(summary)).toEqual([
    "tests/agent-e2e-mobile/flows/home-loads.mjs::android",
    "tests/agent-e2e-mobile/flows/home-loads.mjs::ios",
  ]);
  const ios = summary["tests/agent-e2e-mobile/flows/home-loads.mjs::ios"];
  expect(ios.runs).toBe(2);
  expect(ios.maxMs).toBe(20);
  expect(ios.failureRate).toBe(0);
});

test("summarize separates the infra failure rate from the total", () => {
  const ledger = {
    version: 1,
    records: [
      record({ pass: true }),
      record({ pass: false, failureClass: "product" }),
      record({ pass: false, failureClass: "infrastructure" }),
      record({ pass: false, failureClass: "infrastructure" }),
    ],
  };
  const summary = summarize(ledger);
  const ios = summary["tests/agent-e2e-mobile/flows/home-loads.mjs::ios"];
  expect(ios.failureRate).toBe(0.75);
  expect(ios.infraFailureRate).toBe(0.5);
});

test("summarize has nothing to say about an empty ledger", () => {
  expect(summarize({ version: 1, records: [] })).toEqual({});
  expect(summarize(null)).toEqual({});
});

test("a record missing a required field throws naming that field", async () => {
  const incomplete = record();
  delete incomplete.commit;
  await expect(() =>
    appendRunRecord(incomplete, { ledgerPath: scratchLedgerPath() })
  ).rejects.toThrow(/commit/u);
});

test("a record with an empty flow is refused — it is the window key", async () => {
  await expect(() =>
    appendRunRecord(record({ flow: "" }), {
      ledgerPath: scratchLedgerPath(),
    })
  ).rejects.toThrow(/window key/u);
});

test("CENTRAID_MOBILE_LEDGER overrides the committed path", () => {
  expect(
    ledgerPathFromEnv({ CENTRAID_MOBILE_LEDGER: "/tmp/elsewhere.json" })
  ).toBe("/tmp/elsewhere.json");
  expect(ledgerPathFromEnv({ CENTRAID_MOBILE_LEDGER: "  " })).toMatch(
    /durations\.json$/u
  );
});
