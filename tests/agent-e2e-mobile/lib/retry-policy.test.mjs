// Unit pins for the classified retry (#890 W6).
//
// This module's entire value is what it REFUSES, so the refusals are what is
// pinned. A regression that made `decideRetry` permissive would not fail any
// device lane — it would make the lanes quieter, which is exactly why it has to
// fail here.

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
    // The load-bearing refusal: an assertVisible timeout is the exact shape a
    // real regression takes, so retrying it is how a suite forgives itself.
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
    // A retry decided on absent evidence is a retry decided on nothing.
    const verdict = decideRetry({ record: null, alreadyRetried: false });
    expect(verdict.retry).toBe(false);
    expect(verdict.reason).toMatch(/unknown/u);
  });

  test("the retry is capped at one, even for infrastructure", () => {
    // "Retry until green" is the thing being forbidden. A flow that needs two
    // attempts is not flaky, it is broken, and the cap is what makes that visible.
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
    // Seeded, per docs/coding-standards.md's test seams: an unseeded draw makes
    // a failure unreproducible from the failing run's own output. The value only
    // has to make the scratch filename unique within this file.
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
    // The ledger is instrumentation; it must never be able to fail a suite, and
    // it must never be able to buy one a retry it did not earn.
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
