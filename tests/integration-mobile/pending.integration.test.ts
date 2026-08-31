/*
 * PENDING, produced rather than posed (#890 W3).
 *
 * A write goes into the REAL `SqliteIntentStore` while the phone's transport
 * refuses to connect, and the assertions are what the session then reports:
 * a durable intent it calls `queued`, and an optimistic overlay row stamped
 * with that intent's key — "saved on this phone" as a fact about the outbox,
 * not a label a fixture supplied.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { enumerate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";
import { arrangePending } from "./lib/write-conditions.js";

const apps = await enumerate("pending");

describe("a pending write on a real gateway", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("pending");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test.each(apps)(
    "$appId: an unreachable gateway leaves the write durable and drawn",
    async ({ appId, recipe }) => {
      const observed = await arrangePending(gateway, seat, recipe);

      expect(observed.queuedResult.status).toBe("queued");
      expect(
        observed.queuedStatusWhileCut,
        `${appId} did not hold ${observed.queuedIntentId} in the outbox while the gateway was unreachable`
      ).toBe("queued");
      // The overlay is the other half of the claim: the row the member sees is
      // carrying this intent, not a canonical row that happens to be there.
      expect(
        observed.overlayKeys,
        `${appId} queued ${observed.queuedIntentId} but no row on ${recipe.entity} carries its pending key`
      ).toContain(observed.queuedIntentId);

      // The negative: same session, same shape of write, live transport.
      expect(
        observed.liveStatus,
        `${appId} reported the LIVE write queued too — "queued" is then what this write always says`
      ).not.toBe("queued");
    }
  );
});
