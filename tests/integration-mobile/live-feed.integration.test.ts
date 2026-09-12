/*
 * THE FEED, EXERCISED (#1014, T11 — and the live defect it was blind to).
 *
 * This tier's own header used to say the change feed never emits: "the SSE feed
 * is a device concern", and what the tier therefore could not claim was that a
 * live frame wakes the pull. That is precisely where R15 and R22 were living. A
 * foregrounded phone sat 43 minutes behind a reachable gateway because its SSE
 * request had been cancelled at the platform and never re-issued, and `lsof` on
 * the gateway showed zero connections from either of two foregrounded
 * simulators — a defect the per-PR gate could not see, because the only feed it
 * ran was one that never connected.
 *
 * So the feed here is the SHIPPED `NativeMultiplexChangeFeed` over real `fetch`
 * against the real SSE route. Three things are asserted, and each is a delivery
 * trigger the product did not have before #1014:
 *
 *   1. a gateway write reaches TWO seats with no `pullNow()` anywhere;
 *   2. a stream cancelled mid-flight is re-issued, and the next write lands;
 *   3. with the feed disabled entirely, the foreground clock lands a write.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import { recipeFor } from "./lib/apps.js";
import { serverCreate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

const NOTES = recipeFor("notes");
if (!NOTES) throw new Error("the notes recipe is what this suite writes with");

const open: MobileSeat[] = [];

/** Poll: delivery is a race the product is supposed to win, not a fixed wait. */
async function until(
  predicate: () => boolean,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by definition
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  return predicate();
}

function applied(seat: MobileSeat): number {
  return seat.session.watermark()?.applied ?? -1;
}

describe("a live SSE feed against a real gateway", () => {
  let gateway: MobileGateway;

  beforeAll(async () => {
    gateway = await bootMobileGateway("live-feed");
  });

  afterEach(async () => {
    await forEachSequentially(open.splice(0), (seat) => seat.close());
  });

  // A GATEWAY LEFT RUNNING IS NOT A LEAK THIS TIER CAN AFFORD. `serve()` boots
  // a real host with its recognition automations armed; one left behind keeps
  // committing for the rest of the run, and the suites after it time out
  // against a machine doing another file's work.
  afterAll(async () => {
    await gateway.close();
  });

  test("a gateway write reaches two foregrounded seats with no pull", async () => {
    // R22 EXACTLY: two phones, one gateway, both connected the whole time, and
    // nothing in this test calls `pullNow()` after the seats are open.
    const a = await openSeat(gateway, { label: "phone-a", liveFeed: true });
    const b = await openSeat(gateway, { label: "phone-b", liveFeed: true });
    open.push(a, b);
    await expect(
      until(() => a.feedRequests() > 0 && b.feedRequests() > 0),
      "both seats open a stream to the gateway"
    ).resolves.toBe(true);
    const invalidated: string[] = [];
    a.session.subscribe("suite", (batch) => {
      for (const one of batch) invalidated.push(one.entity);
    });
    const before = { a: applied(a), b: applied(b) };

    await serverCreate(gateway, a, NOTES, "live-feed-1");

    await expect(
      until(() => applied(a) > before.a && applied(b) > before.b),
      "the write reaches both seats' applied position with no foreground transition"
    ).resolves.toBe(true);
    // And on screen: rows landing name the entity a list re-reads (C3).
    await expect(
      until(() => invalidated.includes(NOTES.entity)),
      "the applier's change sink is what tells a screen to re-read"
    ).resolves.toBe(true);
  });

  test("a stream cancelled mid-flight is re-issued, and the next write lands", async () => {
    // R15 EXACTLY: the platform cancelled the request (`-999`) and the feed's
    // reconnect never fired, because it declined to reconnect whenever its own
    // controller had aborted.
    const phone = await openSeat(gateway, {
      label: "cancelled",
      liveFeed: true,
    });
    open.push(phone);
    await expect(until(() => phone.feedRequests() > 0)).resolves.toBe(true);
    const issued = phone.feedRequests();

    phone.dropFeed();

    await expect(
      until(() => phone.feedRequests() > issued),
      "a cancelled stream is a reconnect, not a stop"
    ).resolves.toBe(true);
    const before = applied(phone);
    await serverCreate(gateway, phone, NOTES, "live-feed-2");
    await expect(
      until(() => applied(phone) > before),
      "the write after the reconnect still reaches this seat"
    ).resolves.toBe(true);
  });

  test("with no feed at all, the foreground clock lands the write", async () => {
    // The trigger that does not depend on a socket surviving. This seat has the
    // silent feed every other suite in this tier uses, so the ONLY thing that
    // can move it is the clock.
    const phone = await openSeat(gateway, {
      label: "clocked",
      pullIntervalMs: 150,
    });
    open.push(phone);
    const before = applied(phone);

    await serverCreate(gateway, phone, NOTES, "live-feed-3");

    await expect(
      until(() => applied(phone) > before),
      "a foregrounded session catches up on a clock with no feed and no pull"
    ).resolves.toBe(true);
  });
});
