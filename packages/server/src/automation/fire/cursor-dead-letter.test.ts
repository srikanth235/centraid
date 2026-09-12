/*
 * A TRIGGER ELEMENT IS NEVER SILENTLY CONSUMED (#1014, B1).
 *
 * The old contract acknowledged an element the moment its fire returned, and
 * a handler failure returned — so a Gmail message whose handler hit a
 * transient error was consumed and never processed again. These are the four
 * properties that replace it: a failed element is not acknowledged; the rest
 * of the batch still moves; the retry is backed off and durable across a
 * restart; and at the cap the element is dead-lettered ON THE CURSOR ROW and
 * reported, before the batch is allowed to settle past it.
 */

import { describe, expect, it, vi } from "vitest";

import type { Manifest } from "../manifest/manifest.js";
import type { Row } from "../scaffold/app.js";
import {
  TRIGGER_MAX_ATTEMPTS,
  VaultCursorEngine,
  readDeadLetters,
} from "./cursor-engine.js";
import type {
  TriggerDeadLetter,
  VaultCursorEngineOptions,
} from "./cursor-engine.js";
import { MemoryCursorStore } from "./memory-cursor-store.js";

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

const WEBHOOK = {
  kind: "webhook" as const,
  id: "hook-id",
  secretHash: "a".repeat(64),
};

describe("trigger element retry and dead letter", () => {
  it("leaves a failed element unacknowledged and keeps delivering the rest", async () => {
    const cursors = new MemoryCursorStore();
    const attempted: Array<{ position: string; attempt: number }> = [];
    const engine = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [
          { position: "1", occurredAt: 1 },
          { position: "poison", occurredAt: 2 },
          { position: "3", occurredAt: 3 },
        ],
        positionJson: "3",
      }),
      onError: () => undefined,
      fireCursor: ({ element, attempt }) => {
        attempted.push({ position: element.position, attempt });
        if (element.position === "poison") throw new Error("handler exploded");
      },
    });

    await engine.reconcile([row("hooks/poison", [WEBHOOK])]);

    // The two healthy elements ran; the poisoned one did not hold them.
    expect(attempted.map((entry) => entry.position)).toStrictEqual([
      "1",
      "poison",
      "3",
    ]);
    const cursor = cursors.getCursor("hooks/poison", 0);
    // The batch is still OWED, so the committed position has not moved past it.
    expect(cursor?.positionJson).toBeUndefined();
    const pending = JSON.parse(cursor?.pendingJson ?? "{}") as {
      acknowledged: string[];
      attempts: Record<string, number>;
    };
    expect(pending.acknowledged.sort()).toStrictEqual(["1", "3"]);
    expect(pending.attempts).toStrictEqual({ poison: 1 });
  });

  it("dead-letters at the cap, records it on the cursor row, and settles", async () => {
    const cursors = new MemoryCursorStore();
    const reported: TriggerDeadLetter[] = [];
    let clock = Date.parse("2026-09-10T00:00:00.000Z");
    const engine = new VaultCursorEngine({
      store: cursors,
      now: () => new Date(clock),
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [{ position: "poison", occurredAt: 1 }],
        positionJson: "poison",
      }),
      onError: () => undefined,
      onDeadLetter: (entry) => void reported.push(entry),
      fireCursor: () => {
        throw new Error("handler exploded");
      },
    });

    await engine.reconcile([row("hooks/cap", [WEBHOOK])]);
    const retryPastBackoff = async (left: number): Promise<void> => {
      if (left === 0) return;
      // An hour is past every rung of the backoff ladder. A webhook trigger is
      // reached by neither `tick` nor `nudge`, so its doorbell is the retry.
      clock += 60 * 60_000;
      engine.nudgeIngress("hook-id");
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      return retryPastBackoff(left - 1);
    };
    await retryPastBackoff(TRIGGER_MAX_ATTEMPTS - 1);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      automationRef: "hooks/cap",
      position: "poison",
      attempts: TRIGGER_MAX_ATTEMPTS,
      error: "handler exploded",
    });
    const cursor = cursors.getCursor("hooks/cap", 0);
    // Settled: the batch is gone and the position moved — but ONLY because
    // the element is durably recorded as given up on.
    expect(cursor?.pendingJson).toBeUndefined();
    expect(cursor?.positionJson).toBe("poison");
    const letters = readDeadLetters(cursor?.deadLetterJson);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      position: "poison",
      attempts: TRIGGER_MAX_ATTEMPTS,
      error: "handler exploded",
    });
  });

  it("keeps the dead-letter tail across later settled batches", async () => {
    const cursors = new MemoryCursorStore();
    cursors.putCursor({
      automationId: "hooks/keep",
      triggerIndex: 0,
      sourceKind: "webhook",
      deadLetterJson: JSON.stringify([
        {
          position: "old",
          occurredAt: 1,
          attempts: 5,
          error: "x",
          deadLetteredAt: 1,
        },
      ]),
      updatedAt: 1,
    });
    const engine = new VaultCursorEngine({
      store: cursors,
      fire: vi.fn<VaultCursorEngineOptions["fire"]>(),
      readCursor: async () => ({
        elements: [{ position: "fine", occurredAt: 2 }],
        positionJson: "fine",
      }),
      fireCursor: vi.fn<NonNullable<VaultCursorEngineOptions["fireCursor"]>>(),
    });

    await engine.reconcile([row("hooks/keep", [WEBHOOK])]);

    const cursor = cursors.getCursor("hooks/keep", 0);
    expect(cursor?.positionJson).toBe("fine");
    expect(readDeadLetters(cursor?.deadLetterJson)).toHaveLength(1);
  });
});
