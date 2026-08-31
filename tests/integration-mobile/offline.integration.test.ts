/*
 * OFFLINE, produced rather than posed (#890 W3).
 *
 * The phone's transport is moved to a loopback port nothing listens on, so a
 * pull fails the way a lost network really fails — the platform's own
 * connection error, not a boolean the fetcher was told to honour. What the
 * session must then do is the product's promise: refuse to advance, and keep
 * serving the replica it already holds (docs/mobile-offline.md — a local read
 * is never gated on the network).
 */

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

      // A real transport failure, surfaced rather than swallowed.
      expect(
        observed.cutPullError,
        `${appId} pulled successfully while its transport was cut`
      ).toBeTypeOf("string");
      // The cursor is exactly where the last landed pull left it: an outage
      // must not advance freshness.
      expect(observed.cursorWhileCut).not.toBeNull();
      // Still readable. This is the claim the state exists to make.
      expect(
        observed.rowsWhileCut,
        `${appId} lost its ${recipe.entity} rows the moment the network went`
      ).toBe(1);

      // The negative: the same session, the same pull, on a live transport —
      // it lands, and the row written during the outage arrives.
      expect(observed.restoredPull).toBe(true);
      expect(
        observed.rowsAfterRestore,
        `${appId} did not catch up after the network came back — the outage half proves nothing`
      ).toBe(2);
    }
  );
});
