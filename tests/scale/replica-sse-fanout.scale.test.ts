import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { notifyReplicaCommit } from "@centraid/vault";

import { unrefTimer } from "../../packages/server/src/lib/unref-timer.js";
import { serve } from "../../packages/server/src/serve/serve.js";
import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/replica-sse-fanout.scale.test.ts";
const SUBSCRIBERS = 16;
const COMMITS = 50;
const BASELINE_ROWS = 2_000;
const FRAME_DEADLINE_MS = 30_000;
const SHARED_PROJECTION_STATEMENTS_CEILING = 1_200;

interface Subscriber {
  readonly index: number;
  waitFor: (rowId: string) => Promise<void>;
  readonly frames: () => number;
  close: () => void;
}

function parseFrame(raw: string): { event: string; data: unknown } | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return undefined;
  }
}

async function openSubscriber(
  base: string,
  token: string,
  since: string,
  index: number
): Promise<Subscriber> {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/centraid/_vault/changes?since=${encodeURIComponent(since)}&stream=1&app=agenda`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      },
      signal: controller.signal,
    }
  );
  expect(response.status, `subscriber ${index} stream status`).toBe(200);
  const body = response.body;
  if (!body) throw new Error(`subscriber ${index} received no stream body`);
  const seen = new Set<string>();
  const waiters = new Map<string, () => void>();
  let frames = 0;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = async (): Promise<void> => {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const parsed = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
        if (!parsed) continue;
        frames += 1;
        if (parsed.event !== "change") continue;
        const changes = (parsed.data as { changes?: { rowId?: string }[] })
          .changes;
        for (const change of changes ?? []) {
          if (typeof change.rowId !== "string") continue;
          seen.add(change.rowId);
          waiters.get(change.rowId)?.();
          waiters.delete(change.rowId);
        }
      }
    }
  };
  void pump().catch(() => undefined);
  return {
    index,
    frames: () => frames,
    waitFor: (rowId) =>
      new Promise<void>((resolve, reject) => {
        if (seen.has(rowId)) {
          resolve();
          return;
        }
        const deadline = FRAME_DEADLINE_MS;
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `subscriber ${index} never received ${rowId} within ${deadline} ms`
              )
            ),
          deadline
        );
        unrefTimer(timer);
        waiters.set(rowId, () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    close: () => {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index] ?? Number.NaN;
}

describe("replica-sse-fanout.scale", () => {
  test("one commit reaches every concurrent replica subscriber inside budget", async () => {
    const dataDir = await tempDir("replica-sse-fanout-");
    const token = "sse-fanout-token";
    const handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") },
      token,
    });
    const subscribers: Subscriber[] = [];
    onTestFinished(async () => {
      for (const subscriber of subscribers) subscriber.close();
      await handle.close().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const plane = handle.vaults.get(handle.vaults.defaultVaultId());
    if (!plane)
      throw new Error("the auto-founded Personal vault is not mounted");
    plane.approveGrant("agenda", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });

    const insert = plane.db.vault.prepare(
      `INSERT INTO schedule_task (task_id, owner_party_id, title, status, priority)
       VALUES (?, ?, ?, 'needs-action', 0)`
    );
    plane.db.vault.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < BASELINE_ROWS; index += 1) {
        insert.run(
          `baseline-${index.toString().padStart(6, "0")}`,
          plane.boot.ownerPartyId,
          `Baseline task ${index}`
        );
      }
      plane.db.vault.exec("COMMIT");
    } catch (error) {
      plane.db.vault.exec("ROLLBACK");
      throw error;
    }

    const bootstrap = await fetch(
      `${handle.url}/centraid/_vault/replica/bootstrap?window=500&app=agenda`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(bootstrap.status).toBe(200);
    const opening = (await bootstrap.json()) as {
      cursor: { epoch: string; seq: number };
    };
    const since = `${opening.cursor.epoch}:${opening.cursor.seq}`;

    for (let index = 0; index < SUBSCRIBERS; index += 1) {
      // oxlint-disable-next-line no-await-in-loop
      subscribers.push(await openSubscriber(handle.url, token, since, index));
    }

    const commit = (rowId: string): void => {
      plane.db.vault.exec("BEGIN IMMEDIATE");
      try {
        insert.run(rowId, plane.boot.ownerPartyId, `Fan-out ${rowId}`);
        plane.db.vault.exec("COMMIT");
      } catch (error) {
        plane.db.vault.exec("ROLLBACK");
        throw error;
      }
      notifyReplicaCommit(plane.db.vault);
    };

    commit("fanout-sentinel");
    await Promise.all(
      subscribers.map((subscriber) => subscriber.waitFor("fanout-sentinel"))
    );

    const originalPrepare = plane.db.vault.prepare.bind(plane.db.vault);
    let statements = 0;
    Object.defineProperty(plane.db.vault, "prepare", {
      configurable: true,
      value: ((sql: string) => {
        statements += 1;
        return originalPrepare(sql);
      }) as typeof plane.db.vault.prepare,
    });
    onTestFinished(() => {
      Object.defineProperty(plane.db.vault, "prepare", {
        configurable: true,
        value: originalPrepare,
      });
    });

    const perCommitMs: number[] = [];
    const started = performance.now();
    for (let index = 0; index < COMMITS; index += 1) {
      const rowId = `fanout-${index.toString().padStart(4, "0")}`;
      const commitStarted = performance.now();
      commit(rowId);
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all(
        subscribers.map((subscriber) => subscriber.waitFor(rowId))
      );
      perCommitMs.push(performance.now() - commitStarted);
    }
    const durationMs = performance.now() - started;
    const statementsPerCommit = statements / COMMITS;
    const p95CommitMs = percentile(perCommitMs, 0.95);
    const budgetMs = rigBudgetMs(OWNER);

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const everyoneHeard = subscribers.every(
      (subscriber) => subscriber.frames() > 0
    );
    const sharedProjection =
      statementsPerCommit < SHARED_PROJECTION_STATEMENTS_CEILING;
    const passed = everyoneHeard && sharedProjection && durationMs < budgetMs;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Replica SSE fan-out: ${COMMITS} commits x ${SUBSCRIBERS} subscribers`,
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "fan-out wall clock",
          value: durationMs,
          unit: "ms",
          budget: budgetMs,
        },
        { name: "per-commit fan-out p95", value: p95CommitMs, unit: "ms" },
        {
          name: "per-commit fan-out median",
          value: percentile(perCommitMs, 0.5),
          unit: "ms",
        },
        { name: "subscribers", value: SUBSCRIBERS, unit: "count" },
        { name: "commits", value: COMMITS, unit: "count" },
        {
          name: "vault statements per commit",
          value: statementsPerCommit,
          unit: "statements",
          budget: SHARED_PROJECTION_STATEMENTS_CEILING,
        },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(everyoneHeard).toBe(true);
    expect(
      statementsPerCommit,
      `shared projection: ${statementsPerCommit} vault statements per commit across ${SUBSCRIBERS} subscribers — above ${SHARED_PROJECTION_STATEMENTS_CEILING} means the projection is being re-derived per subscriber again (routes/replica-fanout.ts)`
    ).toBeLessThan(SHARED_PROJECTION_STATEMENTS_CEILING);
    expect(durationMs).toBeLessThan(budgetMs);
  });
});
