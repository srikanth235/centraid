/*
 * THE WAVE F EXIT (#1014): one poisoned asset, one failing handler and one bad
 * provider page each leave the rest of the pipeline moving, with the failure
 * visible in health.
 *
 * Every part of this ran against real code before #1014 and did the opposite.
 * A detector that threw failed the whole turn, and because a recognition walk
 * is `asset_id`-ordered every later tick died on the same row while health
 * reported `ok`. A trigger element whose handler failed was ACKNOWLEDGED and
 * never seen again. A Gmail listing that could not be drained in one fire
 * restarted from the top on the next one, forever.
 *
 * Three seams, one file, because the property is one property: a unit of work
 * that cannot be done is RECORDED and stepped over, never swallowed and never
 * allowed to stop the queue behind it.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { fixtureSha } from "@centraid/test-kit/fixture-sha";
import {
  bootstrapVault,
  declinedEnrichTargets,
  enrichTargetFailureSummary,
  enrichWalkProgress,
  openVaultDb,
  recordEnrichTargetFailure,
} from "@centraid/vault";

import {
  TRIGGER_MAX_ATTEMPTS,
  VaultCursorEngine,
} from "../automation/fire/cursor-engine.js";
import type {
  TriggerDeadLetter,
  VaultCursorEngineOptions,
} from "../automation/fire/cursor-engine.js";
import { MemoryCursorStore } from "../automation/fire/memory-cursor-store.js";
import type { Manifest } from "../automation/manifest/manifest.js";
import type { Row } from "../automation/scaffold/app.js";
import { createEnrichmentHealthProbe } from "./enrichment-health.js";

function seedAsset(
  vault: ReturnType<typeof openVaultDb>["vault"],
  assetId: string
): void {
  const contentId = `content-${assetId}`;
  vault
    .prepare(
      `INSERT OR IGNORE INTO core_content_item
         (content_id, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'file:///x', ?, 1, '2026-01-01T00:00:00.000Z')`
    )
    .run(contentId, fixtureSha(assetId));
  vault
    .prepare(
      `INSERT OR IGNORE INTO media_asset (asset_id, content_id, kind, captured_at)
       VALUES (?, ?, 'photo', '2026-01-01T00:00:00.000Z')`
    )
    .run(assetId, contentId);
}

describe("one poisoned asset leaves the library moving, and shows up in health", () => {
  it("declines the target after the cap and reports a frozen walk as degraded", async () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    for (const id of ["a1", "a2-poison", "a3"]) seedAsset(db.vault, id);

    // THE POISON. Three ticks, three failures on the same asset — the shape
    // that used to repeat forever.
    const verdicts = [1, 2, 3].map(() =>
      recordEnrichTargetFailure(db.vault, {
        capability: "faces",
        targetType: "media.asset",
        targetId: "a2-poison",
        error: "face detector returned no result",
      })
    );
    expect(verdicts.map((v) => v.declined)).toStrictEqual([false, false, true]);

    // Recorded, not swallowed: the register names the asset and the reason.
    expect(
      declinedEnrichTargets(db.vault).map((entry) => entry.targetId)
    ).toContain("a2-poison");
    expect(enrichTargetFailureSummary(db.vault)).toStrictEqual([
      { capability: "faces", declined: 1, failing: 0 },
    ]);

    // …and health says so, on a recipe whose every fire SUCCEEDED. Nothing
    // below this line reads the failure register except through the probe.
    const progress = enrichWalkProgress(db.vault, "faces");
    expect(progress).toMatchObject({ done: 0, total: 3 });
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: "vault-poison",
          listAutomations: async () => [
            { id: "faces", enabled: true, ref: "faces/faces" },
          ],
          recentRuns: () => [{ ok: true, endedAt: Date.now() }],
          progress: (id) => enrichWalkProgress(db.vault, id),
          targetFailures: () => enrichTargetFailureSummary(db.vault),
        },
      ],
    });
    const health = await probe();
    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("1 declined, 0 retrying");
    db.close();
  });
});

function row(ref: string, triggers: Manifest["triggers"]): Row {
  const [ownerApp, id] = ref.split("/") as [string, string];
  return {
    id,
    ownerApp,
    ref,
    name: id,
    dir: `/tmp/${id}`,
    enabled: true,
    triggers,
    manifest: {
      name: id,
      version: "0.1.0",
      enabled: true,
      prompt: "test",
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: "test", at: "2026-09-10T00:00:00.000Z" },
    },
  };
}

describe("one failing handler leaves the rest of the batch moving", () => {
  it("delivers every healthy element, then dead-letters the one that cannot run", async () => {
    const cursors = new MemoryCursorStore();
    const delivered: string[] = [];
    const deadLetters: TriggerDeadLetter[] = [];
    let clock = Date.parse("2026-09-10T00:00:00.000Z");
    const engine = new VaultCursorEngine({
      store: cursors,
      now: () => new Date(clock),
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [
          { position: "msg-1", occurredAt: 1 },
          { position: "msg-poison", occurredAt: 2 },
          { position: "msg-3", occurredAt: 3 },
        ],
        positionJson: "msg-3",
      }),
      onError: () => undefined,
      onDeadLetter: (entry) => void deadLetters.push(entry),
      fireCursor: ({ element }) => {
        if (element.position === "msg-poison")
          throw new Error("handler exploded");
        delivered.push(element.position);
      },
    });
    const webhook = {
      kind: "webhook" as const,
      id: "hook-id",
      secretHash: "a".repeat(64),
    };

    await engine.reconcile([row("hooks/mail", [webhook])]);
    // The healthy pair ran on the FIRST pass, not after the poison cleared.
    expect(delivered).toStrictEqual(["msg-1", "msg-3"]);
    // …and the batch is still owed, so nothing was skipped.
    expect(cursors.getCursor("hooks/mail", 0)?.positionJson).toBeUndefined();

    const retryPastBackoff = async (left: number): Promise<void> => {
      if (left === 0) return;
      clock += 60 * 60_000;
      engine.nudgeIngress("hook-id");
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      return retryPastBackoff(left - 1);
    };
    await retryPastBackoff(TRIGGER_MAX_ATTEMPTS - 1);

    // Never silently acked: the element is reported and durably recorded
    // before the batch is allowed to settle past it.
    expect(deadLetters.map((entry) => entry.position)).toStrictEqual([
      "msg-poison",
    ]);
    expect(deadLetters[0]?.error).toBe("handler exploded");
    expect(cursors.getCursor("hooks/mail", 0)?.positionJson).toBe("msg-3");
    expect(cursors.getCursor("hooks/mail", 0)?.pendingJson).toBeUndefined();
    // The healthy elements were delivered ONCE, not re-run by the retries.
    expect(delivered).toStrictEqual(["msg-1", "msg-3"]);
  });
});

const BLUEPRINTS_ROOT = path.dirname(
  createRequire(import.meta.url).resolve("@centraid/blueprints/package.json")
);

interface PullSpec {
  principal: (args: { ctx: Record<string, unknown> }) => Promise<string>;
  pull: (args: {
    ctx: Record<string, unknown>;
    log: { info: (m: string) => void; warn: (m: string) => void };
    cursor: {
      provider: (key: string) => {
        readonly current: unknown;
        set: (value: unknown) => void;
        clear: () => void;
      };
    };
  }) => Promise<{ rows: unknown[]; summary: string }>;
}

function cursorRails(initial: Record<string, unknown>): {
  cursor: Parameters<PullSpec["pull"]>[0]["cursor"];
  updates: Map<string, unknown>;
} {
  const updates = new Map<string, unknown>();
  return {
    updates,
    cursor: {
      provider(key: string) {
        let value = initial[key];
        return {
          get current(): unknown {
            return value;
          },
          set(next: unknown): void {
            value = next;
            updates.set(key, next);
          },
          clear(): void {
            value = null;
            updates.set(key, null);
          },
        };
      },
    },
  };
}

describe("one bad provider page leaves the mailbox converging", () => {
  it("keeps the page token, holds the watermark, and records an expired cursor as a gap", async () => {
    const spec = (
      (await import(
        pathToFileURL(
          path.join(
            BLUEPRINTS_ROOT,
            "automations/google-gmail-pull/automations/google-gmail-pull/handler.js"
          )
        ).href
      )) as { default: PullSpec }
    ).default;

    // A mailbox whose history cursor has expired AND whose window listing is
    // longer than one fire can drain: the two failures the old handler turned
    // into "start again from the top, forever".
    const warnings: string[] = [];
    let listings = 0;
    const ctx: Record<string, unknown> = {
      now: "2026-09-10T00:00:00.000Z",
      fetch: (call: { url: string }) => {
        if (call.url.endsWith("/profile"))
          return Promise.resolve({
            status: 200,
            headers: {},
            text: JSON.stringify({
              emailAddress: "owner@example.com",
              historyId: "9000",
            }),
          });
        if (call.url.includes("/history?"))
          return Promise.resolve({ status: 404, headers: {}, text: "gone" });
        listings += 1;
        return Promise.resolve({
          status: 200,
          headers: {},
          text: JSON.stringify({
            messages: [],
            nextPageToken: `page-${listings}`,
          }),
        });
      },
    };
    const rails = cursorRails({ "gmail.historyId": "5" });

    await spec.principal({ ctx });
    const result = await spec.pull({
      ctx,
      cursor: rails.cursor,
      log: { info: () => undefined, warn: (m) => warnings.push(m) },
    });

    // BOUNDED: the fire stopped, rather than paging until it was killed.
    expect(listings).toBe(8);
    // HONEST: the watermark did not jump over pages nobody read…
    expect(rails.updates.has("gmail.historyId")).toBe(false);
    // …and the next fire resumes instead of restarting.
    expect(rails.updates.get("gmail.pageToken")).toBe("page-8");
    // VISIBLE: the expired cursor is a recorded gap, not a silent window.
    expect(warnings.join(" ")).toContain("expired upstream");
    expect(result.summary).toContain("more pages pending");
  });
});
