import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { arrangeStale, enumerate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

const apps = await enumerate("stale");

describe("a stale replica on a real gateway", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("stale");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test.each(apps)(
    "$appId: a cursor behind the gateway reads behind, and says so",
    async ({ appId, recipe }) => {
      const observed = await arrangeStale(gateway, seat, recipe);

      expect(
        observed.staleRows,
        `${appId} showed the other device's row without ever pulling — the read is not answering from the replica`
      ).toBe(0);
      expect(
        observed.staleChangesAhead,
        `${appId} reported nothing waiting beyond its cursor while the gateway held a newer row`
      ).toBeGreaterThan(0);

      expect(observed.freshRows).toBe(1);
      expect(
        observed.freshChangesAhead,
        `${appId} still reported changes waiting after a successful pull — the stale signal never clears`
      ).toBe(0);
    }
  );
});
