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
      expect(contested?.expectedVersion).toBeTypeOf("number");
      expect(contested?.actualVersion).toBeTypeOf("number");
      expect(contested!.actualVersion).toBeGreaterThan(
        contested!.expectedVersion!
      );

      expect(
        statusOf(observed.pending, observed.untouchedIntentId),
        `${appId} also conflicted the intent whose row nobody touched`
      ).not.toBe("conflict");
    }
  );
});
