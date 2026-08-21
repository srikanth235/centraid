// Issue #731 goal 2: a parked intent expires on a bounded horizon, and a
// member can cancel one that has not executed yet. Shares the seats built
// in `commons-intent.test-fixtures.ts`.

import { rmSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { REPLICA_DDL } from "../schema/replica.js";
import { SHARE_COMMONS_DDL } from "../schema/share-commons.js";
import { opened, roots, setup } from "./commons-intent.test-fixtures.js";
import {
  cancelCommonsIntent,
  expireParkedCommonsIntents,
  queueCommonsIntent,
  settleCommonsIntent,
} from "./commons.js";

describe("issue #731: parked-intent expiry and cancel", () => {
  afterEach(() => {
    while (opened.length > 0) {
      opened.pop()?.close();
    }
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  // Issue #750: two of the three optimistic-write lifecycles are rendered to
  // the same person in the same list, so they speak ONE grammar. The commons
  // intent vocabulary is the pending-write outbox's own words (see
  // `PendingOverlayStatus` in blueprints' `_shared/pending-overlay.ts`) —
  // never a third set of names for the same states.
  test("commons intent states are the pending-write outbox's states", () => {
    const statesIn = (ddl: string, table: string): string[] => {
      const check = new RegExp(
        `CREATE TABLE (?:IF NOT EXISTS )?${table}[\\s\\S]*?status\\s+TEXT NOT NULL CHECK \\([\\s\\S]*?status IN\\s*\\((?<states>[^)]*)\\)`,
        "u"
      ).exec(ddl);
      const states = check?.groups?.["states"];
      if (!states) throw new Error(`no status CHECK for ${table}`);
      return [...states.matchAll(/'(?<state>[a-z-]+)'/gu)]
        .map((match) => match.groups!["state"]!)
        .toSorted();
    };
    const commons = statesIn(SHARE_COMMONS_DDL, "share_commons_intent");
    expect(commons).toStrictEqual([
      "cancelled",
      "denied",
      "executed",
      "expired",
      "parked",
      "queued",
    ]);
    // Every state the two lifecycles genuinely share is spelled the same way.
    const outbox = new Set(statesIn(REPLICA_DDL, "replica_intent_outcome"));
    for (const state of ["queued", "parked", "denied", "executed"])
      expect(outbox.has(state)).toBe(true);
    // `pending` was the third vocabulary; it is gone from the DDL entirely.
    expect(SHARE_COMMONS_DDL).not.toMatch(/'pending','parked'/u);
  });

  test("expireParkedCommonsIntents settles a long-parked intent and leaves a fresh one alone", () => {
    const { bob, grant, now } = setup();
    const oldIntentId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: "irrelevant" },
      stewardLabel: "Priya's device",
      now,
    });
    settleCommonsIntent({
      seat: bob.db.vault,
      intentId: oldIntentId,
      status: "parked",
      reason: "waiting for Priya's device",
      now,
    });
    // A moment later, expiring with the real horizon leaves the intent
    // parked — it is not old enough yet.
    const soonAfter = new Date(Date.parse(now) + 1_000).toISOString();
    expect(
      expireParkedCommonsIntents({ seat: bob.db.vault, now: soonAfter })
    ).toBe(0);

    // Fifteen days later, the intent parked back at `now` has outlived the
    // horizon. A second intent parked only an hour before this check has
    // not — expiry looks at each row's own age, not a global clock tick.
    const fifteenDaysLater = new Date(
      Date.parse(now) + 15 * 24 * 60 * 60 * 1000
    ).toISOString();
    const anHourEarlier = new Date(
      Date.parse(fifteenDaysLater) - 60 * 60 * 1000
    ).toISOString();
    // Queued at `now` (like `oldIntentId`) so creating it does not itself
    // opportunistically sweep `oldIntentId` early, then backdated to look
    // like it was actually parked an hour before the check below —
    // `queueCommonsIntent`'s own sweep only ever touches THIS seat's rows as
    // of the `now` it is given, so calling it again much later would sweep
    // `oldIntentId` as a side effect before this test gets to assert on the
    // explicit `expireParkedCommonsIntents` call.
    const freshIntentId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: "irrelevant" },
      stewardLabel: "Priya's device",
      now,
    });
    settleCommonsIntent({
      seat: bob.db.vault,
      intentId: freshIntentId,
      status: "parked",
      reason: "waiting for Priya's device",
      now,
    });
    bob.db.vault
      .prepare(
        "UPDATE share_commons_intent SET created_at = ? WHERE intent_id = ?"
      )
      .run(anHourEarlier, freshIntentId);
    expect(
      expireParkedCommonsIntents({ seat: bob.db.vault, now: fifteenDaysLater })
    ).toBe(1);
    expect(
      bob.db.vault
        .prepare(
          "SELECT status, reason FROM share_commons_intent WHERE intent_id = ?"
        )
        .get(oldIntentId)
    ).toMatchObject({
      status: "expired",
      reason: "waiting for Priya's device",
    });
    expect(
      bob.db.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get(freshIntentId)
    ).toMatchObject({ status: "parked" });

    // Re-running finds nothing left to settle — idempotent.
    expect(
      expireParkedCommonsIntents({ seat: bob.db.vault, now: fifteenDaysLater })
    ).toBe(0);
  });

  test("queueCommonsIntent opportunistically expires this seat's own old parked intents", () => {
    const { bob, grant, now } = setup();
    const oldIntentId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: "irrelevant" },
      now,
    });
    settleCommonsIntent({
      seat: bob.db.vault,
      intentId: oldIntentId,
      status: "parked",
      now,
    });
    const fifteenDaysLater = new Date(
      Date.parse(now) + 15 * 24 * 60 * 60 * 1000
    ).toISOString();

    queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: "irrelevant-2" },
      now: fifteenDaysLater,
    });

    expect(
      bob.db.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get(oldIntentId)
    ).toMatchObject({ status: "expired" });
  });

  test("cancelCommonsIntent is idempotent and loses gracefully to an already-executed intent", () => {
    const { bob, grant, now } = setup();

    const pendingId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: "irrelevant" },
      now,
    });
    const first = cancelCommonsIntent({
      seat: bob.db.vault,
      intentId: pendingId,
      now,
    });
    expect(first).toMatchObject({ status: "cancelled", cancelled: true });

    // Cancelling again is a no-op, not an error — same terminal answer.
    const second = cancelCommonsIntent({
      seat: bob.db.vault,
      intentId: pendingId,
      now,
    });
    expect(second).toMatchObject({ status: "cancelled", cancelled: true });

    // A parked intent the steward has already executed (e.g. the peer sweep
    // reached it first) never gets stomped back to "cancelled" by a
    // now-pointless local cancel.
    const executedId = queueCommonsIntent({
      seat: bob.db.vault,
      grantId: grant.grantId,
      actorPartyId: bob.boot.ownerPartyId,
      command: "tally.add_expense",
      commandInput: { group_id: "irrelevant" },
      now,
    });
    settleCommonsIntent({
      seat: bob.db.vault,
      intentId: executedId,
      status: "executed",
      now,
    });
    const lostRace = cancelCommonsIntent({
      seat: bob.db.vault,
      intentId: executedId,
      now,
    });
    expect(lostRace).toMatchObject({ status: "executed", cancelled: false });

    expect(() =>
      cancelCommonsIntent({
        seat: bob.db.vault,
        intentId: "no-such-intent",
        now,
      })
    ).toThrow("no-such-intent");
  });
});
