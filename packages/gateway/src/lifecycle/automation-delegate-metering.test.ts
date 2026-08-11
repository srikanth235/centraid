/*
 * Metering at the one door (issue #743).
 *
 * `ctx.delegate` used to reach a harness through its own fork, which meant an
 * unattended fire was the ONE turn the gateway never measured. It now runs on
 * the injected `accountRunTurn`-wrapped driver — literally the same seam chat,
 * headless compile, and interactive steering are handed — so this boots a real
 * gateway with that driver stubbed and pins three things end to end: the fire's
 * model turn arrives at the injected seam (not at a self-resolved harness), the
 * run is counted in the gateway's resource actuals (#528 Phase C), and the
 * `delegate` ledger item is priced from the turn's own usage.
 *
 * The second fire is the hydration half: it resumes the automation's
 * conversation, so its turn carries the hydration tokens the fold cost — the
 * accounting chat has always had and this path did not.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RunTurnFn, TurnInput } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "../serve/serve.ts";
import type { GatewayServeHandle } from "../serve/serve.ts";

let dataDir: string;
let handle: GatewayServeHandle;
let turns: TurnInput[] = [];
/** Whether the stubbed harness hands back a resumable session id. */
let mintsSessionId = true;

/**
 * The host's turn driver, stubbed. The gateway wraps whatever it is handed in
 * `accountRunTurn`, so a call recorded here is a call the resource accounting
 * also saw — which is the property under test.
 */
const runTurn: RunTurnFn = (input, config) => {
  turns.push(input);
  input.onEvent({
    type: "usage",
    model: "claude-haiku-4-5",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  input.onEvent({ type: "final", text: '{"summary":"delegated"}' });
  return Promise.resolve({
    harnessKind: config.prefs.kind,
    ...(mintsSessionId ? { sessionId: "acp-session-1" } : {}),
    // A real harness reports back whether it actually consumed the fold it
    // was handed; that report is what the turn's hydration tokens are billed
    // against.
    ...(input.hydrationContext
      ? { hydrated: true, hydrationKind: "handoff" as const }
      : {}),
  });
};

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}`, ...extra };
}

async function journalDbPath(): Promise<string> {
  const vaultId = handle.vaults.defaultVaultId();
  const entries = await fs.readdir(dataDir, { recursive: true });
  const relative = entries.find(
    (entry) => entry.endsWith("journal.db") && entry.includes(vaultId)
  );
  if (!relative) throw new Error(`journal.db for vault ${vaultId} is missing`);
  return path.join(dataDir, relative);
}

/** Publish an automation whose handler's only work is one `ctx.delegate` call. */
async function publishDelegatingAutomation(appId: string): Promise<string> {
  const created = await fetch(`${handle.url}/centraid/_automations`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: appId,
      name: appId,
      prompt: "delegate one judgement call",
      triggers: [],
      publish: true,
    }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { row?: { ref: string } };
  const ref = body.row?.ref;
  expect(ref).toBeTruthy();

  const sessionId = `edit-${appId}`;
  const opened = await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ sessionId }),
  });
  expect(opened.status).toBe(201);
  const put = await fetch(
    `${handle.url}/centraid/_apps/${appId}/files/automations/${appId}/handler.js?sessionId=${sessionId}`,
    {
      method: "PUT",
      headers: auth(),
      body:
        "export default async ({ ctx }) => {\n" +
        "  const answer = await ctx.delegate({ prompt: 'summarise', json: { type: 'object' } });\n" +
        "  return { summary: answer.summary };\n" +
        "};\n",
    }
  );
  expect(put.status).toBe(200);
  const published = await fetch(
    `${handle.url}/centraid/_apps/${appId}/publish`,
    {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId, message: "delegating handler" }),
    }
  );
  expect(published.status).toBe(201);
  return ref!;
}

async function fireAndSettle(
  ref: string,
  expectedTurns: number
): Promise<void> {
  const fired = await fetch(
    `${handle.url}/centraid/_automations/turn-now?ref=${encodeURIComponent(ref)}`,
    { method: "POST", headers: auth() }
  );
  expect(fired.status).toBe(202);
  await vi.waitFor(
    async () => {
      const feed = await fetch(
        `${handle.url}/centraid/_automations/turns?ref=${encodeURIComponent(ref)}`,
        { headers: auth() }
      );
      const payload = (await feed.json()) as {
        turns: Array<{ endedAt?: number; ok?: boolean }>;
      };
      const settled = payload.turns.filter(
        (turn) => turn.endedAt !== undefined
      );
      expect(settled).toHaveLength(expectedTurns);
      expect(settled.every((turn) => turn.ok)).toBe(true);
    },
    { timeout: 20_000, interval: 50 }
  );
}

describe("automation-delegate-metering scenarios", () => {
  beforeEach(async () => {
    turns = [];
    mintsSessionId = true;
    dataDir = await tempDir(`gw-delegate-metering-${crypto.randomUUID()}-`);
    handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") } satisfies GatewayPaths,
      runTurn,
    });
  }, 60_000);

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  test("a ctx.delegate fire is driven by the accounted seam, counted, and priced", async () => {
    const before = await handle.health.snapshot();
    const runsBefore =
      before.metrics.resourceUsage?.subsystems.agentRuns.runs ?? 0;
    const ref = await publishDelegatingAutomation("delegating");

    await fireAndSettle(ref, 1);

    // One door: the fire's model turn arrived at the INJECTED driver. A
    // dispatch that resolved its own harness would leave this empty while the
    // turn still succeeded — which is precisely how the fork stayed unmetered.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toBe("summarise");
    // Unattended turns take the deny posture: no one is there to answer a
    // permission request (#484).
    expect(turns[0]?.permissionPolicy).toBe("deny");

    const after = await handle.health.snapshot();
    expect(
      after.metrics.resourceUsage?.subsystems.agentRuns.runs ?? 0
    ).toBeGreaterThan(runsBefore);

    const db = new DatabaseSync(await journalDbPath(), { readOnly: true });
    try {
      const item = db
        .prepare(
          `SELECT model, cost_usd, cost_source, input_tokens
             FROM items WHERE kind = 'delegate'`
        )
        .get() as
        | {
            model: string | null;
            cost_usd: number | null;
            cost_source: string | null;
            input_tokens: number | null;
          }
        | undefined;
      expect(item?.model).toBe("claude-haiku-4-5");
      expect(item?.input_tokens).toBe(1_000_000);
      // Priced from the turn's own usage through the same `resolveItemCost`
      // seam a chat turn is priced by — an unmetered turn is now unwritable.
      expect(item?.cost_source).toBe("estimated");
      expect(item?.cost_usd).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 90_000);

  test("a cold second fire records the hydration tokens its fold cost", async () => {
    // A harness that mints no resumable session id starts every fire cold, so
    // the second one must carry the first turn forward as context.
    mintsSessionId = false;
    const ref = await publishDelegatingAutomation("hydrating");
    await fireAndSettle(ref, 1);
    await fireAndSettle(ref, 2);

    expect(turns).toHaveLength(2);
    // The second fire folds the first turn forward under the fire posture's
    // budget, and the ledger books what that fold cost.
    expect(turns[1]?.hydrationContext).toBeTruthy();
    const db = new DatabaseSync(await journalDbPath(), { readOnly: true });
    try {
      const hydrated = db
        .prepare(
          `SELECT hydration_tokens FROM turns
            WHERE hydration_tokens IS NOT NULL`
        )
        .all() as Array<{ hydration_tokens: number }>;
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0]!.hydration_tokens).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 120_000);
});
