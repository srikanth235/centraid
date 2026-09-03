import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { recipeFor } from "./lib/apps.js";
import type { AppRecipe } from "./lib/apps.js";
import { serverCreate } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

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

    await serverCreate(gateway, seat, recipe, "written-before-the-phone-woke");
    await expect(
      seat.session.read(recipe.appId, { entity: recipe.entity })
    ).rejects.toThrow(/No offline shape/u);

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
