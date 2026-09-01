/*
 * THE EMPTY LIBRARY OVER A FULL VAULT (#905).
 *
 * A phone can mount believing it is offline. `resolveIdentity` probes the
 * gateway base ONCE and carries the answer as a boolean, so a cold launch whose
 * first probe misses — a tunnel still coming up, a radio still settling — mounts
 * a session whose `isConnected()` is false while the socket underneath it is
 * fine. `start()` then skips the bootstrap outright, which is correct: an
 * offline mount must fail open on disk rather than hang.
 *
 * What follows is the defect. Every trigger that could bootstrap it afterwards
 * fires exactly once per event — a reachability wake, a foreground transition, a
 * rebootstrap demand — and none of them is a schedule. So the FIRST attempt after
 * the wake was the only one, and when it was refused the rejection went nowhere:
 * no cursor, no status row, no log. The library drew its empty state over a vault
 * holding rows, reported `partial` coverage, and settled its reachability,
 * because a cursorless `pullNow()` returns before it dials and so never looks
 * like a stall. On screen that is indistinguishable from a vault that is
 * genuinely empty, which is exactly how it survived on device.
 *
 * The arrangement below produces that, and nothing in it is stubbed: the mount's
 * oracle really says offline, the refused attempt is a real socket refusing on a
 * dead loopback port, and the recovery is the session's own. Its negative half is
 * the second seat, which is handed the same failure with the transport already
 * back — proving the rows were always reachable and that the first seat's
 * emptiness was the retry's absence rather than the vault's.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { recipeFor } from "./lib/apps.js";
import type { AppRecipe } from "./lib/apps.js";
import { serverCreate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

/** Short enough that a suite can outlive several, long enough to be a wait. */
const RETRY_BASE_MS = 40;
const SETTLE_TIMEOUT_MS = 5_000;
const POLL_MS = 20;

const BOOTSTRAP_ROUTE = "/centraid/_vault/replica/bootstrap";

function notes(): AppRecipe {
  const recipe = recipeFor("notes");
  if (!recipe) throw new Error("the notes recipe is missing from lib/apps.ts");
  return recipe;
}

async function until(
  predicate: () => Promise<boolean>,
  what: string
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

/** How many times this seat has asked the gateway for a bootstrap page. */
function bootstrapAttempts(seat: MobileSeat): number {
  return seat.attempts.filter((pathname) =>
    pathname.startsWith(BOOTSTRAP_ROUTE)
  ).length;
}

describe("a phone that mounted before its gateway was reachable", () => {
  let gateway: MobileGateway;
  let seat: MobileSeat;
  let reachable = false;

  beforeAll(async () => {
    gateway = await bootMobileGateway("bootstrap-recovery");
    // Mounts believing it is offline, exactly as a cold launch whose one probe
    // missed. `start()` therefore skips the bootstrap and takes no cursor.
    seat = await openSeat(gateway, {
      isConnected: () => reachable,
      retryDelayMs: RETRY_BASE_MS,
    });
  });

  afterAll(async () => {
    await seat?.close();
    await gateway?.close();
  });

  test("recovers the library after its first bootstrap is refused", async () => {
    const recipe = notes();
    const mounted = await seat.session.status();
    expect(
      mounted.cursor,
      "the offline mount took a cursor, so this suite never reaches the state it exists for"
    ).toBeNull();
    expect(bootstrapAttempts(seat)).toBe(0);

    // The vault gains a row the phone has never seen.
    await serverCreate(gateway, seat, recipe, "written-before-the-phone-woke");
    // Page one IS the shape catalog, so a session that never bootstrapped cannot
    // answer this read at all. It REFUSES rather than reporting zero — "absent is
    // never empty" (docs/mobile-offline.md), and the refusal is what the screen
    // above it should have been drawing all along.
    await expect(
      seat.session.read(recipe.appId, { entity: recipe.entity })
    ).rejects.toThrow(/No offline shape/u);

    // The wake arrives while the transport is still refusing — the ordinary
    // shape of a tunnel that has not finished coming up. One real attempt, one
    // real refusal.
    reachable = true;
    seat.cut();
    seat.session.notifyReachable();
    await until(
      () => Promise.resolve(bootstrapAttempts(seat) >= 1),
      "the woken session to attempt its first bootstrap"
    );
    const refusedAfter = bootstrapAttempts(seat);
    expect(
      (await seat.session.status()).cursor,
      "the refused bootstrap took a cursor anyway"
    ).toBeNull();

    // The tunnel comes up. NOTHING further happens to this session: no wake, no
    // foreground transition, no manual pull. Recovery is the session's own or it
    // does not exist.
    seat.restore();
    await until(
      async () => (await seat.session.status()).cursor !== null,
      [
        "the session to retry the bootstrap it was refused —",
        "it asked once, was told no, and never asked again",
      ].join(" ")
    );

    const recovered = await seat.session.read(recipe.appId, {
      entity: recipe.entity,
    });
    expect(
      recovered.rows,
      "the session took a cursor but the row the vault held never landed"
    ).toHaveLength(1);
    // Explicitly a NEW request after the refused one: a walk takes more than one
    // page request even when it succeeds outright, so a bare count could be met
    // without anything ever having been retried.
    expect(
      bootstrapAttempts(seat),
      "the recovery reused the refused attempt rather than making a fresh one"
    ).toBeGreaterThan(refusedAfter);
  });

  test("the negative: the same refusal, with the transport already back", async () => {
    const recipe = notes();
    let secondReachable = false;
    const second = await openSeat(gateway, {
      label: "already-back",
      isConnected: () => secondReachable,
      retryDelayMs: RETRY_BASE_MS,
    });
    try {
      expect((await second.session.status()).cursor).toBeNull();
      // The wake lands on a working transport, so the FIRST attempt succeeds.
      // Without this half, "the rows arrived" could be a retry rescuing a vault
      // that was never reachable in the first place.
      secondReachable = true;
      second.session.notifyReachable();
      await until(
        async () => (await second.session.status()).cursor !== null,
        "a bootstrap on a live transport to take a cursor"
      );
      const read = await second.session.read(recipe.appId, {
        entity: recipe.entity,
      });
      expect(
        read.rows.length,
        "a wake on a live transport did not land the rows either, so the first seat's emptiness says nothing about retries"
      ).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });
});
