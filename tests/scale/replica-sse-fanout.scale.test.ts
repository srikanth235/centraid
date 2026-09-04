import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { notifyReplicaCommit } from "@centraid/vault";

import { unrefTimer } from "../../packages/server/src/lib/unref-timer.js";
import { replicaProjectionHub } from "../../packages/server/src/routes/replica-fanout.js";
import type { ReplicaProjectedPage } from "../../packages/server/src/routes/replica-projection.js";
import { serve } from "../../packages/server/src/serve/serve.js";
import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

/**
 * REPLICA SSE FAN-OUT (issue #883 — the before-instrument for C1, the gate
 * for C2).
 *
 * BEFORE (#883 C1). Every replica change stream in
 * `packages/server/src/routes/replica-routes.ts` owned a private
 * `streamChanges` loop: one `subscribeReplicaCommits` registration, and one
 * `projectReplicaPage` call per subscriber per commit signal. Nothing was
 * shared between subscribers and nothing capped how many of them a single
 * commit could wake, so the gateway's per-commit cost was `O(subscribers)`
 * projections over the same change rows — the household's phone, laptop,
 * tablet and every open web tab each paying to re-derive the identical page.
 *
 * AFTER (#883 C2). `routes/replica-fanout.ts` holds one commit registration
 * and one memoised projection per (authorization x cursor) per commit
 * GENERATION, and both replica SSE routes admit through `SseSubscriberCap`.
 * Sixteen subscribers at one cursor now cost one projection between them.
 *
 * This rig opens N real SSE subscriptions against a real `serve()` gateway,
 * commits M writes one at a time, and waits for every subscriber to observe
 * every commit before the next one is written. Serial-by-commit is the point —
 * letting several commits pile up would let the hub's coalescing flatter the
 * result and hide the per-commit cost this exists to measure.
 *
 * What it publishes, and why each number is here:
 *   - `fan-out wall clock` — the headline. Total time to push M commits to N
 *     subscribers, gated by the registry's `budgetMs`.
 *   - `per-commit fan-out p95` — the owner-facing shape of the same cost: how
 *     long the slowest commit took to reach the last subscriber.
 *   - `vault statements per commit` — prepared statements executed on the
 *     vault handle during the fan-out window, divided by commits. This is
 *     gated, but as a MECHANISM assertion rather than a cost budget: see
 *     SHARED_PROJECTION_STATEMENTS_CEILING below for why that distinction
 *     matters and why it survives the #873 caution about statement counts.
 */
const OWNER = "tests/scale/replica-sse-fanout.scale.test.ts";
/** Concurrent replica change streams. A year-3 household: phones, laptops, tabs. */
const SUBSCRIBERS = 16;
/** Commits pushed through the fan-out, one at a time. */
const COMMITS = 50;
/** Rows already in the replicated table, so each projection reads a real vault. */
const BASELINE_ROWS = 2_000;
/** Upper bound on ONE commit reaching every subscriber. A watchdog, not a wait. */
const FRAME_DEADLINE_MS = 30_000;
/**
 * THE MECHANISM WITNESS (#883 C2), and deliberately not a cost budget.
 *
 * #873 retired the statement count as a proxy for scan COST — a screen whose
 * scanned bytes double while its statement count holds reads as unchanged, and
 * `tests/journeys.json` says so at length. That
 * caution is about using a statement count to bound how EXPENSIVE work is.
 * This ceiling asks a different question, which a statement count answers
 * exactly: does the projection happen ONCE per commit, or once per subscriber?
 * A shared projection and sixteen private ones differ by 16x in this number
 * whatever each one scans.
 *
 * The number: three runs on a shared 4-vCPU linux container measured 658
 * statements per commit, identically, against 10,784-11,904 before the hub —
 * one projection per commit rather than sixteen. 1,200 is 1.8x that (headroom
 * for an extra pass on a heartbeat or a mid-window wake) and still below TWO
 * projections per commit, so any return to per-subscriber projection fails
 * here rather than only showing up as a slower wall clock. Tighten-only.
 */
const SHARED_PROJECTION_STATEMENTS_CEILING = 1_200;
/**
 * Commits behind the projections-per-commit GAUGE below (#922 F5/B6). Short:
 * the gauge asks how many projections one commit costs a household, and that
 * answer does not need fifty commits to be stable.
 */
const GAUGE_COMMITS = 10;

interface Subscriber {
  readonly index: number;
  /** Resolves once every listed row id has arrived on this stream. */
  waitFor: (rowId: string) => Promise<void>;
  readonly frames: () => number;
  close: () => void;
}

/** Parse one SSE wire frame into its event name and JSON payload. */
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

/**
 * Open one real SSE subscription and index the row ids it delivers. The reader
 * runs detached; `waitFor` is event-driven and settles the instant the row id
 * lands (or has already landed), never on a clock.
 */
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
      // Sequential by construction: one chunk at a time off one socket.
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

/** Nearest-rank percentile over an unsorted sample array. */
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

    // A vault the projection actually has to read. Written in one transaction
    // so the baseline costs one commit signal, not BASELINE_ROWS of them.
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
      // Sequential by construction: each stream is opened and proved attached
      // before the next, so a failure names the subscriber that failed.
      // oxlint-disable-next-line no-await-in-loop
      subscribers.push(await openSubscriber(handle.url, token, since, index));
    }

    /** Commit one task row and ring the replica doorbell, exactly as the
     *  journalled write path does after its transaction commits. */
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

    // Attachment proof: every stream must observe one sentinel commit before
    // the measured window opens, so the measurement never includes a
    // subscriber that had not finished attaching.
    commit("fanout-sentinel");
    await Promise.all(
      subscribers.map((subscriber) => subscriber.waitFor("fanout-sentinel"))
    );

    // Count prepared statements on the vault handle across the measured
    // window. Every projection pass re-prepares its reads, so this is the
    // mechanism witness for "N subscribers each project the same page".
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
      // Serial by construction: the next commit is not written until this one
      // has reached every subscriber, so each measured interval is one full
      // fan-out rather than a coalesced batch.
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

    // ── #922 F5 / B6 gauge: household projections per commit ───────────────
    // Read from the hub's OWN counters — `currentGeneration()` is the commit
    // counter, bumped once per replica commit, and `subscriberCount()` is the
    // household actually attached — plus the property the hub exists for: the
    // page it hands back is SHARED, so DISTINCT page objects across a household
    // reading at one cursor IS the projection count. Nothing is added to
    // `routes/replica-fanout.ts` to measure it. No budget: the mechanism is
    // already gated by the statements ceiling above; this is the number #927
    // wave 2's ledger records for the household row.
    const hub = replicaProjectionHub(plane.db.vault);
    const householdAccess = {
      canWrite: true,
      rememberDevice: true,
      appId: "agenda",
    };
    const householdSubscribers = hub.subscriberCount();
    const generationBefore = hub.currentGeneration();
    const distinctPages = new Set<ReplicaProjectedPage>();
    for (let index = 0; index < GAUGE_COMMITS; index += 1) {
      commit(`gauge-${index.toString().padStart(4, "0")}`);
      for (let reader = 0; reader < SUBSCRIBERS; reader += 1) {
        distinctPages.add(hub.project(householdAccess, opening.cursor, 500));
      }
    }
    const generations = hub.currentGeneration() - generationBefore;
    const projectionsPerCommit = distinctPages.size / generations;

    // #659 R4 — sustained-drift gate over this rig's own 30-sample nightly
    // history. Null until the history is deep enough; a null is "no opinion
    // yet", never a pass.
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
        {
          name: "household projections per commit",
          value: projectionsPerCommit,
          unit: "projections",
        },
        {
          name: "hub subscribers",
          value: householdSubscribers,
          unit: "count",
        },
        {
          name: "hub generations per commit",
          value: generations / GAUGE_COMMITS,
          unit: "generations",
        },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(everyoneHeard).toBe(true);
    // The mechanism, asserted: one projection per commit for the whole
    // household, not one per subscriber.
    expect(
      statementsPerCommit,
      `shared projection: ${statementsPerCommit} vault statements per commit across ${SUBSCRIBERS} subscribers — above ${SHARED_PROJECTION_STATEMENTS_CEILING} means the projection is being re-derived per subscriber again (routes/replica-fanout.ts)`
    ).toBeLessThan(SHARED_PROJECTION_STATEMENTS_CEILING);
    expect(durationMs).toBeLessThan(budgetMs);
    // The gauge carries no ceiling, but an instrument that saw no commit is
    // reporting a number about nothing: one generation per commit is the
    // reading the projection count is divided by.
    expect(generations).toBe(GAUGE_COMMITS);
  });
});
