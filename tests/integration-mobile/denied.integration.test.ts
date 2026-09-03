import { afterEach, describe, expect, test } from "vitest";

import { enumerate, statusOf } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";
import { arrangeDenied } from "./lib/write-conditions.js";

const apps = await enumerate("denied");

describe("a denied write on a real gateway", () => {
  let gateway: MobileGateway | undefined;
  let seat: MobileSeat | undefined;

  afterEach(async () => {
    await seat?.close();
    await gateway?.close();
    seat = undefined;
    gateway = undefined;
  });

  test.each(apps)(
    "$appId: a withdrawn app turns a queued write into a stated refusal",
    async ({ appId, recipe }) => {
      gateway = await bootMobileGateway(`denied-${appId}`);
      seat = await openSeat(gateway);
      const observed = await arrangeDenied(gateway, seat, recipe);
      const denied = observed.pending.find(
        (entry) => entry.intentId === observed.deniedIntentId
      );

      expect(
        observed.grantsRevoked,
        `${appId} had no grant to revoke — the arrangement withdrew nothing`
      ).toBeGreaterThan(0);
      expect(denied?.status, `${appId} revoked intent`).toBe("denied");
      expect(denied?.reason).toBeTypeOf("string");
      expect(denied?.reason?.length ?? 0).toBeGreaterThan(0);

      expect(
        statusOf(observed.pending, observed.allowedIntentId),
        `${appId} denied the write made while the owner still trusted the app`
      ).not.toBe("denied");
    }
  );
});
