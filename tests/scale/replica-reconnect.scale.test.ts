import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { notifyReplicaCommit } from "@centraid/vault";

import { unrefTimer } from "../../packages/server/src/lib/unref-timer.js";
import { serve } from "../../packages/server/src/serve/serve.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/replica-reconnect.scale.test.ts";
const REPLICA_ROWS = 50_000;
const WINDOW = 20_000;
const OFFLINE_COMMITS = 25;
const FRAME_DEADLINE_MS = 60_000;

interface CeilingFile {
  metrics: { reconnectToFresh: { ceilingMs: number } };
}

interface ChangeFrame {
  atMs: number;
  rowIds: string[];
}

interface Stream {
  waitForAll: (rowIds: readonly string[]) => Promise<ChangeFrame>;
  firstChangeMs: () => number | undefined;
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

async function openStream(
  base: string,
  token: string,
  since: string,
  started: number
): Promise<Stream> {
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
  expect(response.status, "change stream status").toBe(200);
  const body = response.body;
  if (!body) throw new Error("change stream carried no body");
  const seen = new Set<string>();
  let firstChangeMs: number | undefined;
  let lastFrame: ChangeFrame | undefined;
  let onFrame: (() => void) | undefined;
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
        if (!parsed || parsed.event !== "change") continue;
        const atMs = performance.now() - started;
        firstChangeMs ??= atMs;
        const rowIds = (
          (parsed.data as { changes?: { rowId?: string }[] }).changes ?? []
        )
          .map((change) => change.rowId)
          .filter((rowId): rowId is string => typeof rowId === "string");
        for (const rowId of rowIds) seen.add(rowId);
        lastFrame = { atMs, rowIds };
        onFrame?.();
      }
    }
  };
  void pump().catch(() => undefined);
  return {
    firstChangeMs: () => firstChangeMs,
    waitForAll: (rowIds) =>
      new Promise<ChangeFrame>((resolve, reject) => {
        const settleIfComplete = (): boolean => {
          if (!rowIds.every((rowId) => seen.has(rowId))) return false;
          clearTimeout(timer);
          onFrame = undefined;
          resolve(
            lastFrame ?? { atMs: performance.now() - started, rowIds: [] }
          );
          return true;
        };
        const deadline = FRAME_DEADLINE_MS;
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `the change stream did not deliver ${rowIds.length} row ids within ${deadline} ms`
              )
            ),
          deadline
        );
        unrefTimer(timer);
        onFrame = () => void settleIfComplete();
        settleIfComplete();
      }),
    close: () => {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}

describe("replica-reconnect.scale", () => {
  test("a stale cursor catches up inside the reconnect-to-fresh ceiling at 50k rows", async () => {
    const ceilings = JSON.parse(
      await fs.readFile(
        path.resolve("tests/experience-budgets/gateway.json"),
        "utf8"
      )
    ) as CeilingFile;
    const ceilingMs = ceilings.metrics.reconnectToFresh.ceilingMs;
    const dataDir = await tempDir("replica-reconnect-");
    const token = "replica-reconnect-token";
    const handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") },
      token,
    });
    const streams: Stream[] = [];
    onTestFinished(async () => {
      for (const stream of streams) stream.close();
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
    const seedStarted = performance.now();
    plane.db.vault.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < REPLICA_ROWS; index += 1) {
        insert.run(
          `year3-${index.toString().padStart(6, "0")}`,
          plane.boot.ownerPartyId,
          `Year 3 task ${index}`
        );
      }
      plane.db.vault.exec("COMMIT");
    } catch (error) {
      plane.db.vault.exec("ROLLBACK");
      throw error;
    }
    const seedMs = performance.now() - seedStarted;

    const commit = (rowId: string): void => {
      plane.db.vault.exec("BEGIN IMMEDIATE");
      try {
        insert.run(rowId, plane.boot.ownerPartyId, `Offline ${rowId}`);
        plane.db.vault.exec("COMMIT");
      } catch (error) {
        plane.db.vault.exec("ROLLBACK");
        throw error;
      }
      notifyReplicaCommit(plane.db.vault);
    };

    const bootstrapStarted = performance.now();
    let query = `?window=${WINDOW}&app=agenda`;
    let rows = 0;
    let pages = 0;
    let resumeCursor: string | undefined;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(
        `${handle.url}/centraid/_vault/replica/bootstrap${query}`,
        { headers: { authorization: `Bearer ${token}` } }
      );
      expect(response.status).toBe(200);
      // oxlint-disable-next-line no-await-in-loop
      const page = (await response.json()) as {
        rows: { entity: string; rowId: string }[];
        cursor: { epoch: string; seq: number };
        complete: boolean;
        next?: string;
      };
      pages += 1;
      rows += page.rows.filter((row) => row.entity === "schedule.task").length;
      resumeCursor ??= `${page.cursor.epoch}:${page.cursor.seq}`;
      if (page.complete) break;
      expect(page.next).toBeTruthy();
      query = `?window=${WINDOW}&app=agenda&after=${encodeURIComponent(page.next!)}`;
    }
    const bootstrapMs = performance.now() - bootstrapStarted;
    expect(rows).toBe(REPLICA_ROWS);
    const cursor = resumeCursor!;

    const live = await openStream(handle.url, token, cursor, performance.now());
    streams.push(live);
    commit("reconnect-sentinel");
    await live.waitForAll(["reconnect-sentinel"]);

    live.close();
    const missed = Array.from(
      { length: OFFLINE_COMMITS },
      (_, index) => `offline-${index.toString().padStart(4, "0")}`
    );
    for (const rowId of missed) commit(rowId);

    const reconnectStarted = performance.now();
    const resumed = await openStream(
      handle.url,
      token,
      cursor,
      reconnectStarted
    );
    streams.push(resumed);
    const frame = await resumed.waitForAll(missed);
    const reconnectToFreshMs = frame.atMs;
    const firstFrameMs = resumed.firstChangeMs() ?? reconnectToFreshMs;

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed = reconnectToFreshMs < ceilingMs;
    const withinDrift = drift === null || reconnectToFreshMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Replica reconnect to fresh at ${REPLICA_ROWS} rows`,
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "reconnect to fresh",
          value: reconnectToFreshMs,
          unit: "ms",
          budget: ceilingMs,
        },
        { name: "first change frame", value: firstFrameMs, unit: "ms" },
        {
          name: "missed commits replayed",
          value: missed.length,
          unit: "count",
        },
        { name: "bootstrap walk", value: bootstrapMs, unit: "ms" },
        { name: "bootstrap pages", value: pages, unit: "count" },
        { name: "seed", value: seedMs, unit: "ms" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${reconnectToFreshMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(reconnectToFreshMs).toBeLessThan(ceilingMs);
  });
});
