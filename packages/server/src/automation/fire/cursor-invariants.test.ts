/*
 * The cursor invariants themselves (#541 review): a committed position
 * never runs ahead of a delivered element, a disable never destroys a
 * watermark, a failed batch never swallows a doorbell, and a quiet minute
 * never costs a write. Cron enumeration and gap collapse belong to
 * cron-cursor.test.ts; the one-registration-per-automation collapse belongs to
 * cursor-engine-support.test.ts.
 */

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AutomationTriggerStore,
  makeJournalDbProvider,
} from "@centraid/server/engine";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import type { Manifest } from "../manifest/manifest.js";
import type { Row } from "../scaffold/app.js";
import { VaultCursorEngine } from "./cursor-engine.js";
import type { VaultCursorEngineOptions } from "./cursor-engine.js";

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
      history: { keep: "all" },
      generated: { by: "test", at: "2026-01-01T00:00:00.000Z" },
    },
  };
}

function store(): AutomationTriggerStore {
  return new AutomationTriggerStore(
    makeJournalDbProvider(
      path.join(tempDirSync("centraid-cursor-invariants-"), "journal.db")
    )
  );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("VaultCursorEngine cursor invariants", () => {
  it("never commits past the last element a truncated batch delivered", async () => {
    const cursors = store();
    const fired: string[] = [];
    const reads: Array<string | undefined> = [];
    const backlog = ["1", "2", "3", "4"];
    const engine = new VaultCursorEngine({
      store: cursors,
      catchUpCap: 2,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      // A reader that ignores `limit` — the engine must still not advance the
      // committed position past what it actually delivered.
      readCursor: async ({ cursor }) => {
        reads.push(cursor?.positionJson);
        const after =
          backlog.indexOf(JSON.parse(cursor?.positionJson ?? '"0"') as string) +
          1;
        return {
          elements: backlog.slice(after).map((position) => ({
            position,
            occurredAt: Number(position),
            positionJson: JSON.stringify(position),
          })),
          positionJson: JSON.stringify(backlog.at(-1)),
        };
      },
      fireCursor: ({ element }) => void fired.push(element.position),
    });

    await engine.reconcile([
      row("mail/backlog", [{ kind: "data", entities: ["core.party"] }]),
    ]);

    expect(fired).toStrictEqual(["1", "2"]);
    expect(cursors.getCursor("mail/backlog", 0)).toMatchObject({
      positionJson: '"2"',
      // Cap overflow is durable data waiting its turn, never a gap.
      skipped: 0,
    });
    expect(cursors.getCursor("mail/backlog", 0)?.gapReason).toBeUndefined();

    engine.nudge();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(fired).toStrictEqual(["1", "2", "3", "4"]);
    expect(cursors.getCursor("mail/backlog", 0)?.positionJson).toBe('"4"');
  });

  it("holds the committed position when an over-returning reader offers no element watermark", async () => {
    const cursors = store();
    const fired: string[] = [];
    const engine = new VaultCursorEngine({
      store: cursors,
      catchUpCap: 1,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [
          { position: "a", occurredAt: 1 },
          { position: "b", occurredAt: 2 },
        ],
        positionJson: '"b"',
      }),
      fireCursor: ({ element }) => void fired.push(element.position),
    });

    await engine.reconcile([
      row("mail/opaque", [{ kind: "data", entities: ["core.party"] }]),
    ]);

    expect(fired).toStrictEqual(["a"]);
    // `b` was never delivered, and nothing says where `a` ends — the honest
    // answer is to stay put rather than skip `b`.
    expect(cursors.getCursor("mail/opaque", 0)?.positionJson).toBeUndefined();
  });

  it("keeps cursors across a disable and prunes only orphaned trigger slots", async () => {
    const cursors = store();
    const engine = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async ({ triggerIndex }) => ({
        elements: [],
        positionJson: JSON.stringify(`p${triggerIndex}`),
      }),
      fireCursor: vi.fn<NonNullable<VaultCursorEngineOptions["fireCursor"]>>(),
    });
    const triggers: Manifest["triggers"] = [
      { kind: "data", entities: ["core.party"] },
      { kind: "data", entities: ["core.event"] },
    ];
    await engine.reconcile([row("watch/pair", triggers)]);
    expect(cursors.getCursor("watch/pair", 1)?.positionJson).toBe('"p1"');

    // Disabled is not deleted: the watermark has to survive so re-enabling
    // resumes instead of silently skipping the off period.
    await engine.reconcile([
      { ...row("watch/pair", triggers), enabled: false },
    ]);
    await expect(engine.list()).resolves.toStrictEqual([]);
    expect(cursors.getCursor("watch/pair", 0)?.positionJson).toBe('"p0"');
    expect(cursors.getCursor("watch/pair", 1)?.positionJson).toBe('"p1"');

    // A transient empty listing must never wipe the vault's cursors.
    await engine.reconcile([]);
    expect(cursors.getCursor("watch/pair", 0)?.positionJson).toBe('"p0"');

    // Shrinking the trigger list drops the orphaned index so a later trigger
    // reusing that slot cannot inherit a stale position.
    await engine.reconcile([row("watch/pair", [triggers[0]!])]);
    expect(cursors.getCursor("watch/pair", 0)?.positionJson).toBe('"p0"');
    expect(cursors.getCursor("watch/pair", 1)).toBeUndefined();
  });

  it("re-runs a doorbell that was rung while a batch was failing", async () => {
    const cursors = store();
    const attempts: string[] = [];
    const engine: VaultCursorEngine = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [{ position: "9", occurredAt: 9 }],
        positionJson: "9",
      }),
      fireCursor: ({ element }) => {
        attempts.push(element.position);
        if (attempts.length > 1) return;
        // A delivery lands mid-failure. Webhook triggers are reached by
        // neither `tick` nor `nudge`, so a swallowed flag strands it until the
        // next POST or a restart.
        engine.nudgeIngress("hook-id");
        throw new Error("gateway stopped");
      },
    });
    const trigger = {
      kind: "webhook" as const,
      id: "hook-id",
      secretHash: "a".repeat(64),
    };

    await expect(
      engine.reconcile([row("hooks/doorbell", [trigger])])
    ).rejects.toThrow("gateway stopped");

    // The doorbell was drained inside the same serialized run — and the
    // failure was still surfaced rather than swallowed by the retry.
    expect(attempts).toStrictEqual(["9", "9"]);
    expect(cursors.getCursor("hooks/doorbell", 0)).toMatchObject({
      positionJson: "9",
    });
    expect(cursors.getCursor("hooks/doorbell", 0)?.pendingJson).toBeUndefined();
  });

  it("does not write a cursor row for a cron minute that produced nothing", async () => {
    const cursors = store();
    let writes = 0;
    let clock = new Date(2026, 0, 1, 8, 0);
    const counting = {
      getCursor: (id: string, index: number) => cursors.getCursor(id, index),
      putCursor: (
        input: Parameters<AutomationTriggerStore["putCursor"]>[0]
      ) => {
        writes += 1;
        cursors.putCursor(input);
      },
    };
    const engine = new VaultCursorEngine({
      store: counting,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      fireCursor: vi.fn<NonNullable<VaultCursorEngineOptions["fireCursor"]>>(),
      now: () => clock,
    });
    await engine.reconcile([
      row("clock/daily", [{ kind: "cron", expr: "0 3 * * *" }]),
    ]);

    engine.tick();
    await settle();
    const afterBootstrap = writes;

    const tickNextMinute = async (index: number): Promise<void> => {
      const minute = [1, 2, 3, 4, 5][index];
      if (minute === undefined) return;
      clock = new Date(2026, 0, 1, 8, minute);
      engine.tick();
      await settle();
      return tickNextMinute(index + 1);
    };
    await tickNextMinute(0);

    // One bootstrap row, then silence — 1,440 upserts a day buys nothing.
    expect(afterBootstrap).toBe(1);
    expect(writes).toBe(1);
  });

  it("routes a failing dormancy hook to onError instead of failing the reconcile", async () => {
    const errors: Array<{ ref: string; message: string }> = [];
    const engine = new VaultCursorEngine({
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      fireCursor: vi.fn<NonNullable<VaultCursorEngineOptions["fireCursor"]>>(),
      onDormancyChange: () => Promise.reject(new Error("ledger write failed")),
      onError: (error, ref) =>
        errors.push({
          ref,
          message: error instanceof Error ? error.message : String(error),
        }),
    });

    await expect(
      engine.reconcile([
        row("clock/daily", [{ kind: "cron", expr: "0 3 * * *" }]),
      ])
    ).resolves.toMatchObject({ added: ["clock/daily"] });

    await expect(engine.list()).resolves.toStrictEqual(["clock/daily"]);
    expect(errors).toStrictEqual([
      { ref: "<scheduler-dormancy>", message: "ledger write failed" },
    ]);
  });
});
