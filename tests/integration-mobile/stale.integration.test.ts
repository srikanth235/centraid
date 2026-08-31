/*
 * STALE, produced rather than posed (#890 W3).
 *
 * Stale is not offline: the gateway is reachable the whole time. A second
 * device writes, this session does not pull, and the question is whether the
 * session can tell that it is behind — asked over the real changes route with
 * this session's own cursor and shape ids, which is the same question the
 * foreground pull asks.
 *
 * Three of these cells are literal `gap`s in `tests/matrix.json#appStates`
 * (docs, people, photos), which is why this state is one of the three the slice
 * did first.
 */

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

      // Behind in what it shows…
      expect(
        observed.staleRows,
        `${appId} showed the other device's row without ever pulling — the read is not answering from the replica`
      ).toBe(0);
      // …and knowing it, over the real protocol rather than by inference.
      expect(
        observed.staleChangesAhead,
        `${appId} reported nothing waiting beyond its cursor while the gateway held a newer row`
      ).toBeGreaterThan(0);

      // The negative: one pull on the same session flips both answers. Without
      // it, "behind" could be a read that never sees anything.
      expect(observed.freshRows).toBe(1);
      expect(
        observed.freshChangesAhead,
        `${appId} still reported changes waiting after a successful pull — the stale signal never clears`
      ).toBe(0);
    }
  );
});
