import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { decrypt, encrypt } from "@centraid/backup";
import { recordQualityResult } from "@centraid/test-kit/quality-result";

const OWNER = "tests/perf/backup-throughput.perf.test.ts";
const BYTES = 32 * 1024 * 1024;

describe("backup-throughput.perf", () => {
  test("encrypts and verifies a representative backup chunk", async () => {
    const key = randomBytes(32);
    const input = randomBytes(BYTES);
    const started = performance.now();
    const sealed = encrypt(key, input);
    const opened = decrypt(key, sealed);
    const durationMs = performance.now() - started;
    // Published, not gated (#927): the paired candidate/PR run compares two
    // trees; a threshold on one sample here would fence the runner.
    const passed = true;
    expect(Buffer.compare(Buffer.from(opened), input)).toBe(0);

    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "Backup encrypt + verify throughput",
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
        },
        {
          name: "throughput",
          value: BYTES / 1024 / 1024 / (durationMs / 1_000),
          unit: "MiB/s",
        },
      ],
    });
    expect(passed).toBe(true);
  });
});
