/*
 * DAYONE, produced rather than posed (#890 W3).
 *
 * The component tier renders whatever empty state it is handed. This one boots
 * a real gateway on a freshly founded vault, bootstraps a real native replica
 * session against it, and asks the SESSION what it holds for each app: no rows,
 * a real cursor, and complete coverage — an empty library that finished syncing,
 * which is a different thing from a library that never started.
 */

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
      // Empty AND ready. A session with no cursor has not synced at all, which
      // the product draws as a first sync rather than as day one.
      expect(observed.cursor).not.toBeNull();
      expect(observed.coverage ?? "complete").toBe("complete");

      // The negative: the same read, once the vault really holds a row. Without
      // it, `0` could be a read that never works for this app.
      expect(
        observed.seededRows,
        `${appId} still read ${recipe.entity} as empty after a real row landed — the day-one zero proves nothing`
      ).toBe(1);
    }
  );
});
