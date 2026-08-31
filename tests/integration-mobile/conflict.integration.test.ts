/*
 * CONFLICT, produced rather than posed (#890 W3).
 *
 * The phone queues an edit of a row while it is cut off; a second device edits
 * the SAME row; the gateway compares the intent's `baseVersions` against the
 * row's canonical version and refuses. Nothing here writes the word "conflict"
 * into a fixture: the version numbers the session reports are the gateway's
 * own, and they are what the pending sheet prints.
 *
 * The two versions are captured by the product, not by the test — the shipped
 * pending projection supplies the optimistic row and the coordinator captures
 * its base version from the replica.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { enumerate, statusOf } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";
import { arrangeConflict } from "./lib/write-conditions.js";

const apps = await enumerate("conflict");

describe("a conflicted write on a real gateway", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("conflict");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test.each(apps)(
    "$appId: a row that moved underneath the queued edit comes back conflicted",
    async ({ appId, recipe }) => {
      const observed = await arrangeConflict(gateway, seat, recipe);
      const contested = observed.pending.find(
        (entry) => entry.intentId === observed.contestedIntentId
      );

      expect(contested?.status, `${appId} contested intent`).toBe("conflict");
      // The two versions are what separates a conflict from a bare refusal:
      // they are what the overlay copy prints for the member.
      expect(contested?.expectedVersion).toBeTypeOf("number");
      expect(contested?.actualVersion).toBeTypeOf("number");
      expect(contested!.actualVersion).toBeGreaterThan(
        contested!.expectedVersion!
      );

      // The negative: the same session, the same action, the same drain — one
      // row left alone. It must not be conflicted, or "conflict" is simply what
      // this edit always returns.
      expect(
        statusOf(observed.pending, observed.untouchedIntentId),
        `${appId} also conflicted the intent whose row nobody touched`
      ).not.toBe("conflict");
    }
  );
});
