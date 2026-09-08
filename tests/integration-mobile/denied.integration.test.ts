/*
 * DENIED, produced rather than posed (#890 W3).
 *
 * The authorization path, end to end: a write is durable in the outbox while
 * the phone is cut off, the owner withdraws the app on the gateway
 * (`VaultPlane.revokeApp` — the same call that backs the settings screen), and
 * the drain then meets a permanent refusal rather than a retry. What the
 * session does with it is the point: the intent stays visible and terminal, so
 * the member is told their saved change will never land instead of watching it
 * retry forever.
 *
 * Each app gets its OWN gateway here, unlike every other suite in this tier.
 * Revocation is a vault-wide act that removes the app's replica shape, which
 * moves the schema epoch and invalidates the session's cursor; a second app
 * sharing that vault would then fail a rebootstrap it has nothing to do with,
 * and the failure would name the wrong test.
 */

import { afterEach, describe, expect, test } from "vitest";

import { enumerate, statusOf } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";
import { arrangeDenied } from "./lib/write-conditions.js";

const apps = await enumerate("denied");

describe("a denied write on a real gateway", () => {
  let gateway: MobileGateway | undefined;
  let seat: MobileSeat | undefined;

  afterEach(async () => {
    await seat?.close();
    await gateway?.close();
    seat = undefined;
    gateway = undefined;
  });

  test.each(apps)(
    "$appId: a withdrawn app turns a queued write into a stated refusal",
    async ({ appId, recipe }) => {
      gateway = await bootMobileGateway(`denied-${appId}`);
      seat = await openSeat(gateway);
      const observed = await arrangeDenied(gateway, seat, recipe);
      const denied = observed.pending.find(
        (entry) => entry.intentId === observed.deniedIntentId
      );

      expect(observed.appRevoked, `${appId} was not withdrawn`).toBe(true);
      expect(denied?.status, `${appId} revoked intent`).toBe("denied");
      // Terminal AND explained: a refusal with no reason is a spinner.
      expect(denied?.reason).toBeTypeOf("string");
      expect(denied?.reason?.length ?? 0).toBeGreaterThan(0);

      // The negative: the identical write, same session, made BEFORE the
      // withdrawal. It must not be denied, or the refusal is not the
      // revocation's doing.
      expect(
        statusOf(observed.pending, observed.allowedIntentId),
        `${appId} denied the write made while the owner still trusted the app`
      ).not.toBe("denied");
    }
  );
});
