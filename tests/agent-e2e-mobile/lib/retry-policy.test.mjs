import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { seededRandom } from "@centraid/test-kit/random";

import { decideRetry, lastRecord, shouldRetry } from "./retry-policy.mjs";

const scratch = seededRandom(890);

const record = (over = {}) => ({
  flow: "tests/agent-e2e-mobile/flows/cold-start.mjs",
  slug: "cold-start",
  platform: "android",
  failureClass: "product",
  failureReason: "assertion",
  ...over,
});

describe("decideRetry", () => {
  test("an infrastructure failure earns exactly one retry", () => {
    const verdict = decideRetry({
      record: record({
        failureClass: "infrastructure",
        failureReason: "maestro driver disconnected",
      }),
      alreadyRetried: false,
    });
    expect(verdict.retry).toBe(true);
    expect(verdict.reason).toMatch(/infrastructure/u);
  });

  test("a product failure is NEVER retried", () => {
    const verdict = decideRetry({
      record: record({ failureClass: "product" }),
      alreadyRetried: false,
    });
    expect(verdict.retry).toBe(false);
    expect(verdict.reason).toMatch(/never retried/u);
  });

  test("an unknown class is treated as product, never as infrastructure", () => {
    expect(
      decideRetry({
        record: record({ failureClass: undefined }),
        alreadyRetried: false,
      }).retry
    ).toBe(false);
  });

  test("a missing record is treated as product", () => {
    const verdict = decideRetry({ record: null, alreadyRetried: false });
    expect(verdict.retry).toBe(false);
    expect(verdict.reason).toMatch(/unknown/u);
  });

  test("the retry is capped at one, even for infrastructure", () => {
    const verdict = decideRetry({
      record: record({ failureClass: "infrastructure" }),
      alreadyRetried: true,
    });
    expect(verdict.retry).toBe(false);
    expect(verdict.reason).toMatch(/already retried/u);
  });

  test("every refusal carries a reason a reader can act on", () => {
    for (const input of [
      { record: null, alreadyRetried: false },
      { record: record(), alreadyRetried: false },
      {
        record: record({ failureClass: "infrastructure" }),
        alreadyRetried: true,
      },
    ]) {
      expect(decideRetry(input).reason.length).toBeGreaterThan(30);
    }
  });
});

describe("lastRecord", () => {
  async function withLedger(records, run) {
    const file = path.join(
      tmpdir(),
      `centraid-retry-${process.pid}-${scratch.token()}.json`
    );
    await fs.writeFile(file, JSON.stringify({ version: 1, records }));
    try {
      return await run(file);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  test("reads the most recent record for that flow on that platform", async () => {
    const found = await withLedger(
      [
        record({ failureClass: "product" }),
        record({ platform: "ios", failureClass: "infrastructure" }),
        record({ failureClass: "infrastructure", failureReason: "newest" }),
      ],
      (file) => lastRecord("cold-start.mjs", "android", file)
    );
    expect(found.failureReason).toBe("newest");
  });

  test("does not read another flow's record", async () => {
    const found = await withLedger(
      [record({ slug: "notes-library", flow: "flows/notes-library.mjs" })],
      (file) => lastRecord("cold-start.mjs", "android", file)
    );
    expect(found).toBe(null);
  });

  test("an absent or corrupt ledger yields null, and therefore no retry", async () => {
    expect(await lastRecord("cold-start.mjs", "android", "/nonexistent")).toBe(
      null
    );
    const file = path.join(
      tmpdir(),
      `centraid-retry-corrupt-${process.pid}.json`
    );
    await fs.writeFile(file, "{ not json");
    try {
      expect(await lastRecord("cold-start.mjs", "android", file)).toBe(null);
      expect(
        (await shouldRetry("cold-start.mjs", "android", false, file)).retry
      ).toBe(false);
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});
