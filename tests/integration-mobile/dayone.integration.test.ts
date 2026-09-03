import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { arrangeDayone, enumerate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

const apps = await enumerate("dayone");

describe("day one on a real gateway", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("dayone");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test.each(apps)(
    "$appId: an empty vault reports a bootstrapped, empty library",
    async ({ appId, recipe }) => {
      const observed = await arrangeDayone(gateway, seat, recipe);

      expect(
        observed.emptyRows,
        `${appId} read ${recipe.entity} on a fresh vault`
      ).toBe(0);
      expect(observed.cursor).not.toBeNull();
      expect(observed.coverage ?? "complete").toBe("complete");

      expect(
        observed.seededRows,
        `${appId} still read ${recipe.entity} as empty after a real row landed — the day-one zero proves nothing`
      ).toBe(1);
    }
  );
});
