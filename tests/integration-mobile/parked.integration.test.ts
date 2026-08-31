/*
 * PARKED, produced rather than posed (#890 W3).
 *
 * A park is neither an error nor a delay: it is the vault holding a
 * `confirm: true` command for the owner's confirmation
 * (`packages/vault/src/gateway/gateway.ts` — "loud on purpose"). The session
 * must carry that back as a first-class outcome the pending sheet can narrate.
 *
 * Four of the eight apps ship no action that reaches such a command, so no
 * arrangement at this tier can make a real gateway park their write. Those
 * cells do NOT get a passing state test and they do not get a silent skip
 * either: they get a test that asserts the BLOCKER, computed from the shipped
 * vault registry and the app's own handlers. It passes only while the product
 * really has no parking path there, and turns red the day one is added — which
 * is exactly when the cell becomes coverable here. (An `it.skip` was the first
 * shape considered; it would have needed a `tests/skips.json` entry with an
 * open issue, and there is no open issue here — the four cells are a product
 * fact, not deferred work.)
 */

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
      // The reason is the vault's own sentence, not one this tier invented.
      expect(observed.parkedResult.reason).toContain("owner confirmation");
      expect(statusOf(observed.pending, observed.parkedIntentId)).toBe(
        "parked"
      );

      // The negative: an ordinary write of the same app, through the same
      // session. If it parked too, "parked" would be this seat's default rather
      // than this command's decision.
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
