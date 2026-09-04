import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
/**
 * Gateway multi-session headroom (#496 PE1).
 * Spins many concurrent session-shaped HTTP probes against a real serve().
 */
import { tempDir } from "@centraid/test-kit/temp-dir";

import { serve } from "../../packages/server/src/serve/serve.js";
import type { GatewayServeHandle } from "../../packages/server/src/serve/serve.js";
import { rigBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/gateway-sessions.scale.test.ts";
const SESSIONS = 40;
const BUDGET_MS = rigBudgetMs(OWNER);

let dataDir: string;
let handle: GatewayServeHandle;

describe("gateway-sessions.scale scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gw-scale-${crypto.randomUUID()}-`);
    handle = await serve({
      // A fresh vaultDir auto-founds Personal at construction (#603),
      // which is all the fixture needs — no named init vault any more.
      paths: { vaultDir: path.join(dataDir, "vault") },
      token: "scale-admin-token",
    });
  });

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("concurrent session probes complete under headroom budget", async () => {
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: SESSIONS }, async () => {
        const res = await fetch(`${handle.url}/centraid/_apps`, {
          headers: { Authorization: "Bearer scale-admin-token" },
        });
        return res.status;
      })
    );
    const durationMs = performance.now() - started;
    const ok = results.every((s) => s !== 401 && s !== 403 && s < 500);
    const passed = ok && durationMs < BUDGET_MS;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Gateway ${SESSIONS} concurrent session probes`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          budget: BUDGET_MS,
        },
        { name: "sessions", value: SESSIONS, unit: "count" },
      ],
    });
    expect(ok).toBe(true);
    expect(durationMs).toBeLessThan(BUDGET_MS);
  });
});
