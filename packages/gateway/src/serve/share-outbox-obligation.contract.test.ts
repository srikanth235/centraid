/*
 * The sharing plane's ONE effect outbox, as a law (issue #750 abstraction 2).
 *
 * `share_effects` succeeded three hand-rolled queues with three drainers and
 * three ways to forget a crash. What replaced them is only worth having if
 * four things hold together: an obligation is keyed by WHAT IT IS ABOUT (so a
 * replay lands on the same row rather than doubling the work), an obligation
 * that waits on a HUMAN is never picked up by a machine tick, one unreadable
 * row cannot stop the drainer from discharging its neighbours, and a failed
 * attempt backs off instead of spinning — while a transfer that made progress
 * is not punished for a backoff it never earned.
 *
 * Those are delivery guarantees, not storage details: the failure each one
 * prevents is a share that is silently duplicated, silently stalled, or
 * silently lost. `share-refusal-outbox.test.ts` proves ONE effect kind's
 * journey end-to-end across two gateways; this file owns the guarantees the
 * table gives EVERY obligation, which that journey can only sample.
 *
 * Deterministic by injection: every call here takes an explicit `now`, so the
 * retry clock is asserted at its exact boundary rather than slept through.
 */

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import type { ShareEffect } from "./share-coordinator.js";
import {
  claimDueShareEffects,
  completeShareEffect,
  deferShareEffect,
  enqueueShareEffect,
  findQueuedEffect,
  listQueuedEffects,
} from "./share-effects.js";

const opened: GatewayDatabase[] = [];

/** Epoch ms with no wall-clock in it — every deadline below is relative. */
const T0 = 1_760_000_000_000;

async function outbox(): Promise<GatewayDatabase> {
  const db = GatewayDatabase.open(await tempDir());
  opened.push(db);
  return db;
}

function give(edgeId: string): ShareEffect {
  return { kind: "deliver-give", edgeId, delivery: "peer", crossOwner: true };
}

function dueIds(db: GatewayDatabase, now: number): string[] {
  return claimDueShareEffects(db, { now }).map((pending) => pending.effectId);
}

describe("[law:share-outbox-obligation] every share obligation is durable, single, and eventually drained", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
  });

  test("[law:share-outbox-obligation] a replayed enqueue lands on the same obligation and never rewinds its retry clock", async () => {
    const db = await outbox();
    const first = enqueueShareEffect(db, give("edge-1"), { now: T0 });
    const again = enqueueShareEffect(db, give("edge-1"), { now: T0 + 60_000 });

    expect(again).toBe(first);
    expect(dueIds(db, T0)).toStrictEqual(["give:edge-1"]);

    // One attempt failed, so this obligation is now waiting out a backoff. A
    // crash-replayed enqueue must not shove it back to the front of the queue.
    deferShareEffect(db, first, { attempts: 0, now: T0 });
    enqueueShareEffect(db, give("edge-1"), { now: T0 });
    expect(dueIds(db, T0)).toStrictEqual([]);

    // An explicit requeue is the deliberate opposite — the owner asking for
    // this exact obligation to be tried again now.
    enqueueShareEffect(db, give("edge-1"), { requeue: true, now: T0 });
    expect(dueIds(db, T0)).toStrictEqual(["give:edge-1"]);

    // Discharged is forward-only: the row survives as evidence it happened,
    // and no later tick picks it up again.
    completeShareEffect(db, first);
    expect(dueIds(db, T0 + 86_400_000)).toStrictEqual([]);
    expect(listQueuedEffects(db, "deliver-give")).toStrictEqual([]);
  });

  test("[law:share-outbox-obligation] an obligation waiting on a human is never claimed by a machine tick", async () => {
    const db = await outbox();
    const ask: ShareEffect = {
      kind: "await-answer",
      edgeId: "edge-ask",
      linkId: "link-1",
      peerVaultId: "vlt-peer",
      localVaultId: "vlt-local",
      itemType: "media.asset",
      itemCount: 3,
    };
    enqueueShareEffect(db, ask, { awaitsHuman: true, now: T0 });
    enqueueShareEffect(db, give("edge-2"), { now: T0 });

    // A year of ticks later, the ask is still nobody's work but its owner's.
    expect(dueIds(db, T0 + 365 * 86_400_000)).toStrictEqual(["give:edge-2"]);
    // …and it is emphatically not lost: the surface that shows an owner what
    // they must answer still finds it, unchanged.
    expect(listQueuedEffects(db, "await-answer")).toStrictEqual([
      { effectId: "ask:edge-ask", attempts: 0, effect: ask },
    ]);
    expect(
      findQueuedEffect(db, "await-answer", "edge-ask")?.effect
    ).toStrictEqual(ask);
  });

  test("[law:share-outbox-obligation] one unreadable row never blocks the obligations beside it", async () => {
    const db = await outbox();
    enqueueShareEffect(db, give("edge-early"), { now: T0 });
    // A payload that drifted — a hand edit, a half-written generation. Handing
    // this to a transport as if it were well-formed is the other way to fail.
    db.run(
      `INSERT INTO share_effects
         (effect_id, edge_id, kind, payload_json, status, attempts,
          next_attempt_at, created_at, updated_at)
       VALUES ('give:edge-drifted', 'edge-drifted', 'deliver-give',
               '{"delivery":"carrier-pigeon"}', 'queued', 0, ?, ?, ?)`,
      T0 + 1,
      new Date(T0 + 1).toISOString(),
      new Date(T0 + 1).toISOString()
    );
    enqueueShareEffect(db, give("edge-late"), { now: T0 + 2 });

    expect(dueIds(db, T0 + 10)).toStrictEqual([
      "give:edge-early",
      "give:edge-late",
    ]);
  });

  test("[law:share-outbox-obligation] a failed attempt backs off; a transfer that moved bytes does not", async () => {
    const db = await outbox();
    const effectId = enqueueShareEffect(db, give("edge-retry"), { now: T0 });

    deferShareEffect(db, effectId, { attempts: 0, now: T0 });
    // Five seconds, to the millisecond — a tick one ms early finds nothing,
    // which is what "backs off" has to mean to stop a hot loop.
    expect(dueIds(db, T0 + 4_999)).toStrictEqual([]);
    expect(dueIds(db, T0 + 5_000)).toStrictEqual(["give:edge-retry"]);

    // The second failure doubles it rather than repeating the same delay.
    const attempts = claimDueShareEffects(db, { now: T0 + 5_000 })[0]!.attempts;
    expect(attempts).toBe(1);
    deferShareEffect(db, effectId, { attempts, now: T0 + 5_000 });
    expect(dueIds(db, T0 + 5_000 + 9_999)).toStrictEqual([]);
    expect(dueIds(db, T0 + 5_000 + 10_000)).toStrictEqual(["give:edge-retry"]);

    // A resumable pull that moved bytes has not failed at anything: it returns
    // to the queue immediately and forfeits the attempts it had accumulated.
    deferShareEffect(db, effectId, { attempts: 2, progressed: true, now: T0 });
    expect(claimDueShareEffects(db, { now: T0 })).toStrictEqual([
      { effectId: "give:edge-retry", attempts: 0, effect: give("edge-retry") },
    ]);
  });
});
