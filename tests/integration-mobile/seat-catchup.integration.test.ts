/*
 * A SEAT THAT BOOTSTRAPPED AT AN EMPTY LOG, AND THE PULL THAT FOLLOWS (#1011).
 *
 * The reproduction of the live defect, at the tier that has the real doors: a
 * phone paired to a freshly founded vault takes its snapshot at watermark 0 —
 * every row it will ever hold arrives afterwards, as log pages — and it stayed
 * at that watermark over a gateway holding hundreds of rows.
 *
 * Two claims, in the order the phone met them:
 *
 *   1. the copy catches up from ZERO over the shipped log door, so a snapshot
 *      taken before any content is not a copy that can never fill; and
 *   2. a catch-up refused by a dead transport is asked again on the SAME
 *      session once the transport is back, without a remount — which is the
 *      half that was missing, because the failure latched the session's
 *      connectivity oracle shut.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { readEntity } from "./lib/reads.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

async function upload(gateway: MobileGateway, title: string): Promise<void> {
  const outcome = await gateway.callAction("docs", "upload", {
    data_uri: "data:text/plain;base64,c2VlZGVk",
    title,
  });
  if (outcome.body.status !== "executed")
    throw new Error(
      `docs.upload did not execute: ${JSON.stringify(outcome.body)}`
    );
}

describe("a seat bootstrapped before the vault held anything", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("seat-catchup");
    seat = await openSeat(gateway);
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test("fills from the log door, then recovers from a refused pull", async () => {
    await upload(gateway, "Doc one");
    await expect(seat.session.pullNow()).resolves.toBe(true);
    expect((await readEntity(seat, "core.document")).rows).toHaveLength(1);

    // The transport dies under a session that is otherwise fine — the shape of
    // the live failure, whose reason used to be swallowed whole.
    seat.cut();
    await expect(seat.session.pullNow()).resolves.toBe(false);
    expect(seat.session.lastSyncError).toBeDefined();

    // …and the SAME session catches up when it comes back. No remount, no
    // reachability event: the phone's own retry is what has to carry this.
    seat.restore();
    await upload(gateway, "Doc two");
    await expect(seat.session.pullNow()).resolves.toBe(true);
    expect(seat.session.lastSyncError).toBeUndefined();
    expect((await readEntity(seat, "core.document")).rows).toHaveLength(2);
  });
});
