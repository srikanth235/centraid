import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { arrangeOffline, enumerate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

const apps = await enumerate("offline");

describe("an offline phone on a real gateway", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("offline");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test.each(apps)(
    "$appId: a refused socket stops the pull and still serves the replica",
    async ({ appId, recipe }) => {
      const observed = await arrangeOffline(gateway, seat, recipe);

      expect(
        observed.cutPullError,
        `${appId} pulled successfully while its transport was cut`
      ).toBeTypeOf("string");
      expect(observed.cursorWhileCut).not.toBeNull();
      expect(
        observed.rowsWhileCut,
        `${appId} lost its ${recipe.entity} rows the moment the network went`
      ).toBe(1);

      expect(observed.restoredPull).toBe(true);
      expect(
        observed.rowsAfterRestore,
        `${appId} did not catch up after the network came back — the outage half proves nothing`
      ).toBe(2);
    }
  );
});
