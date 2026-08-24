/*
 * Steward-absence status surfaced by the commons sweep (#731). The status
 * itself is computed and persisted by `pullPeerCommons`/`recordCommonsPull`
 * (`commons-observability.ts`) on every attempt regardless of this file; what
 * this suite pins is that `sweepPeerCommons` does not drop `result.steward`
 * on the floor — a concerning presence reaches the sweep's own logger, and a
 * healthy/unremarkable one stays quiet.
 */

import { describe, expect, test } from "vitest";

import {
  commonsSeats,
  COMMONS_INTENT_PARK_HORIZON_MS,
  compileCommons,
  createCommonsGrant,
  queueCommonsIntent,
  settleCommonsIntent,
} from "@centraid/vault";

import {
  COMMONS_SWEEP_BACKOFF_BASE_MS,
  COMMONS_SWEEP_BACKOFF_MAX_MS,
  sweepPeerCommons,
} from "./peer-commons-sweep.js";
import { link, makeSide, seedPhoto } from "./peer-give.test-fixtures.js";
import type { PeerDial } from "./peer-link-client.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Always resolves with a clean "not found" — never throws, so the sweep's
 *  device-reach evidence still records a completed round trip. */
function unreachableDial(): PeerDial {
  return {
    endpointTicketFor: () => "ticket",
    request: async () => ({ status: 404, json: { state: "not_found" } }),
  };
}

/** The same dead steward, with a call counter for the backoff suite. */
function countingUnreachableDial(): PeerDial & { calls: () => number } {
  let dialled = 0;
  return {
    calls: () => dialled,
    endpointTicketFor: () => "ticket",
    request: async () => {
      dialled += 1;
      return { status: 404, json: { state: "not_found" } };
    },
  };
}

/** A member holding a commons grant from a steward it will never actually
 *  reach in this suite — the fake dial above stands in for the wire. */
async function memberWithGrant(label: string): Promise<{
  steward: ReturnType<typeof makeSide>;
  member: ReturnType<typeof makeSide>;
  grantId: string;
}> {
  const steward = makeSide(`${label}-steward`);
  const member = makeSide(`${label}-member`);
  await link(member, steward);
  const now = new Date().toISOString();
  const photo = seedPhoto(steward, label);
  const grant = createCommonsGrant({
    origin: steward.vault.vault,
    ownerPartyId: steward.ownerPartyId,
    ownerVaultId: steward.vaultId,
    ownerVault: steward.vault,
    containerType: "media.asset",
    containerId: photo.assetId,
    members: [
      {
        partyId: member.ownerPartyId,
        capability: "read+write",
        vaultId: member.vaultId,
        vault: member.vault,
        vaultPublicKey: member.publicKey,
      },
    ],
    now,
  });
  compileCommons({
    steward: steward.vault,
    stewardVaultId: steward.vaultId,
    grantId: grant.grantId,
    seats: commonsSeats({
      steward: steward.vault.vault,
      grantId: grant.grantId,
      stewardVaultId: steward.vaultId,
      vaultFor: (vaultId) =>
        vaultId === steward.vaultId
          ? steward.vault
          : vaultId === member.vaultId
            ? member.vault
            : undefined,
    }),
    now,
  });
  return { steward, member, grantId: grant.grantId };
}

describe("sweepPeerCommons steward-status surfacing", () => {
  test("a fresh, first-time failure stays quiet — reachable, not yet concerning", async () => {
    const { member } = await memberWithGrant("sweep-fresh");
    const warnings: string[] = [];
    const result = await sweepPeerCommons({
      vaults: [{ vaultId: member.vaultId, db: member.vault }],
      links: member.links,
      dial: unreachableDial(),
      limit: 10,
      now: new Date().toISOString(),
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(result.progressed).toBe(0);
    expect(warnings).toStrictEqual([]);
  });

  test("silence past the absent threshold, with a working local link, logs the escalation", async () => {
    const { member, grantId } = await memberWithGrant("sweep-absent");
    const t0 = new Date().toISOString();
    const dial = unreachableDial();
    const links = member.links;
    const baseVaults = [{ vaultId: member.vaultId, db: member.vault }];

    // First contact attempt opens the absence episode and proves the local
    // link works (the dial resolved, even with a 404).
    await sweepPeerCommons({
      vaults: baseVaults,
      links,
      dial,
      limit: 10,
      now: t0,
    });

    const eightDaysLater = new Date(Date.parse(t0) + 8 * DAY_MS).toISOString();
    const warnings: string[] = [];
    await sweepPeerCommons({
      vaults: baseVaults,
      links,
      dial,
      limit: 10,
      now: eightDaysLater,
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("absent");
    expect(warnings[0]).toContain(grantId);
    expect(warnings[0]).toContain(member.vaultId);
  });

  test("no logger supplied is a silent no-op, not a throw", async () => {
    const { member } = await memberWithGrant("sweep-no-logger");
    await expect(
      sweepPeerCommons({
        vaults: [{ vaultId: member.vaultId, db: member.vault }],
        links: member.links,
        dial: unreachableDial(),
        limit: 10,
      })
    ).resolves.toStrictEqual({ progressed: 0 });
  });
});

describe("sweepPeerCommons backs off an absent steward (issue #750 defect e)", () => {
  test("recorded absence evidence gates re-dialing exponentially, intents included", async () => {
    const { member, grantId } = await memberWithGrant("sweep-backoff");
    const t0 = new Date().toISOString();
    // A pending intent alongside the grant pull: without the gate the sweep
    // dials the dead steward once per intent per grant per tick.
    queueCommonsIntent({
      seat: member.vault.vault,
      grantId,
      actorPartyId: member.ownerPartyId,
      command: "media.update_asset",
      commandInput: { asset_id: "does-not-matter", title: "queued" },
      now: t0,
    });
    const dial = countingUnreachableDial();
    const at = async (offsetMs: number): Promise<void> => {
      await sweepPeerCommons({
        vaults: [{ vaultId: member.vaultId, db: member.vault }],
        links: member.links,
        dial,
        limit: 10,
        now: new Date(Date.parse(t0) + offsetMs).toISOString(),
      });
    };
    await at(0);
    const firstTick = dial.calls();
    expect(firstTick).toBeGreaterThan(0);
    // Inside the first backoff window: NOTHING is dialed — not the pull, not
    // the queued intent.
    await at(COMMONS_SWEEP_BACKOFF_BASE_MS / 2);
    expect(dial.calls()).toBe(firstTick);
    // Past the window the steward is probed again…
    await at(COMMONS_SWEEP_BACKOFF_BASE_MS + 1000);
    const secondProbe = dial.calls();
    expect(secondProbe).toBeGreaterThan(firstTick);
    // …and the second consecutive failure doubles the window.
    await at(
      COMMONS_SWEEP_BACKOFF_BASE_MS + 1000 + COMMONS_SWEEP_BACKOFF_BASE_MS
    );
    expect(dial.calls()).toBe(secondProbe);
    // The ceiling always allows an eventual re-probe.
    await at(
      COMMONS_SWEEP_BACKOFF_BASE_MS + 1000 + COMMONS_SWEEP_BACKOFF_MAX_MS
    );
    expect(dial.calls()).toBeGreaterThan(secondProbe);
  });
});

describe("sweepPeerCommons expires long-parked intents (issue #731 goal 2)", () => {
  test("a parked intent past the review-window horizon is expired before the sweep's own retry pass", async () => {
    const { member, grantId } = await memberWithGrant("sweep-expiry");
    const t0 = new Date().toISOString();
    const parkedId = queueCommonsIntent({
      seat: member.vault.vault,
      grantId,
      actorPartyId: member.ownerPartyId,
      command: "media.update_asset",
      commandInput: { asset_id: "does-not-matter", title: "queued" },
      now: t0,
    });
    settleCommonsIntent({
      seat: member.vault.vault,
      intentId: parkedId,
      status: "parked",
      reason: "waiting for the steward's device",
      now: t0,
    });

    const pastHorizon = new Date(
      Date.parse(t0) + COMMONS_INTENT_PARK_HORIZON_MS + 1
    ).toISOString();
    await sweepPeerCommons({
      vaults: [{ vaultId: member.vaultId, db: member.vault }],
      links: member.links,
      dial: unreachableDial(),
      limit: 10,
      now: pastHorizon,
    });

    expect(
      member.vault.vault
        .prepare(
          "SELECT status, settled_at FROM share_commons_intent WHERE intent_id = ?"
        )
        .get(parkedId)
    ).toMatchObject({ status: "expired", settled_at: pastHorizon });
  });

  test("a parked intent still within the horizon survives the sweep untouched", async () => {
    const { member, grantId } = await memberWithGrant("sweep-expiry-fresh");
    const t0 = new Date().toISOString();
    const parkedId = queueCommonsIntent({
      seat: member.vault.vault,
      grantId,
      actorPartyId: member.ownerPartyId,
      command: "media.update_asset",
      commandInput: { asset_id: "does-not-matter", title: "queued" },
      now: t0,
    });
    settleCommonsIntent({
      seat: member.vault.vault,
      intentId: parkedId,
      status: "parked",
      reason: "waiting for the steward's device",
      now: t0,
    });

    const stillWaiting = new Date(Date.parse(t0) + 60_000).toISOString();
    await sweepPeerCommons({
      vaults: [{ vaultId: member.vaultId, db: member.vault }],
      links: member.links,
      dial: unreachableDial(),
      limit: 10,
      now: stillWaiting,
    });

    expect(
      member.vault.vault
        .prepare("SELECT status FROM share_commons_intent WHERE intent_id = ?")
        .get(parkedId)
    ).toMatchObject({ status: "parked" });
  });
});
