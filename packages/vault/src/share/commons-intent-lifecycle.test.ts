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
    const outbox = new Set(statesIn(REPLICA_DDL, "replica_intent_outcome"));
    for (const state of ["queued", "parked", "denied", "executed"])
      expect(outbox.has(state)).toBe(true);
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
    const soonAfter = new Date(Date.parse(now) + 1_000).toISOString();
    expect(
      expireParkedCommonsIntents({ seat: bob.db.vault, now: soonAfter })
    ).toBe(0);

    const fifteenDaysLater = new Date(
      Date.parse(now) + 15 * 24 * 60 * 60 * 1000
    ).toISOString();
    const anHourEarlier = new Date(
      Date.parse(fifteenDaysLater) - 60 * 60 * 1000
    ).toISOString();
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

    const second = cancelCommonsIntent({
      seat: bob.db.vault,
      intentId: pendingId,
      now,
    });
    expect(second).toMatchObject({ status: "cancelled", cancelled: true });

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
