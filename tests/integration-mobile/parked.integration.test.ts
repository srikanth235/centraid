import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { isBlocked } from "./lib/apps.js";
import { enumerate, statusOf } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { parkableCommandsOf } from "./lib/parking.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";
import { arrangeParked } from "./lib/write-conditions.js";

const apps = await enumerate("parked");
const arrangeable = apps.filter((app) => app.blocked === undefined);
const unreachable = apps.filter((app) => app.blocked !== undefined);

describe("a parked write on a real gateway", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("parked");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test.each(arrangeable)(
    "$appId: a confirm-required command comes back parked, with its reason",
    async ({ appId, recipe }) => {
      const park = recipe.park;
      if (isBlocked(park)) throw new Error(`${appId} was filtered as blocked`);
      const observed = await arrangeParked(gateway, seat, recipe, park);

      expect(observed.parkedResult.status).toBe("parked");
      expect(observed.parkedResult.reason).toContain("owner confirmation");
      expect(statusOf(observed.pending, observed.parkedIntentId)).toBe(
        "parked"
      );

      expect(
        statusOf(observed.pending, observed.ordinaryIntentId),
        `${appId} parked an ordinary write as well — the park is not the command's`
      ).not.toBe("parked");
    }
  );

  test.each(unreachable)(
    "$appId: no shipped action reaches a confirm-required command, so this tier cannot produce a park",
    async ({ appId, blocked }) => {
      await expect(
        parkableCommandsOf(appId),
        `${appId} now ships an action routing to a parking vault command — ` +
          `this cell is coverable here; give it a recipe and drop the blocker (${blocked})`
      ).resolves.toStrictEqual([]);
    }
  );
});
