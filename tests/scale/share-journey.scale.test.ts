/*
 * THE SHARE JOURNEY'S NUMBER (#927 wave 3; the AFTER is #929's).
 *
 * "Grant it to Ravi" to "Ravi's screen shows it" is one of the nine journeys and
 * had no number at all — the grant plane's tests prove the STATE is right and
 * time nothing. This measures the interval on the topology that exists today:
 * two vaults side by side under one gateway root, which is what a household
 * runs and what `placement-fixture.household()` builds.
 *
 * The delivery term is `startShareSubscription` since #929: a share is a
 * replica subscription, so what is timed is composing the shape once for the
 * grant and carrying it over the loopback transport. The KEY and the interval
 * are unchanged, which is what makes the before and after comparable at all —
 * `tests/journeys.json` holds both under one metric.
 *
 * WHAT IS MEASURED. Three intervals, separately, because they have different
 * owners and a single total would hide which one moved:
 *
 *   grantMs      `createShareGrant` — writing the standing grant.
 *   fulfillMs    `startShareSubscription` — composing the grant's shape and
 *                carrying it into the audience vault. This is the term that
 *                scales with the size of what was shared, and the one #929
 *                moved.
 *   visibleMs    the audience vault's own read returning the shared rows —
 *                the grantee's screen, not the delivery's own success.
 *
 * The album is deliberately NOT one photo. A share of one row measures the
 * plane's fixed cost and says nothing about the term that grows; SHARED_ASSETS
 * is a share big enough that projection dominates.
 *
 * CROSS-GATEWAY IS NOT MEASURED HERE and the omission is the point: the second
 * vault is co-hosted, so no transport is in the interval. A cross-gateway share
 * needs two data dirs and a tunnel, and its number belongs beside this one
 * rather than folded into it.
 */
import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { startShareSubscription } from "../../packages/vault/src/grant/fulfillment.js";
import {
  addParty,
  addToAlbum,
  AUDIENCE_VAULT,
  audienceTitles,
  linkVault,
  ORIGIN_VAULT,
  seedAlbum,
} from "../../packages/vault/src/grant/fulfillment.test-fixtures.js";
import { createShareGrant } from "../../packages/vault/src/grant/grant-store.js";
import { nowIso } from "../../packages/vault/src/ids.js";
import {
  closeOpenVaults,
  household,
  seedPhoto,
} from "../../packages/vault/src/share/placement-fixture.js";
import { loopbackShareTransports } from "../../packages/vault/src/share/subscription-transport.js";
import { journeyCeiling } from "../helpers/journeys.js";

const OWNER = "tests/scale/share-journey.scale.test.ts";
const SHARE_KEY = "gateway/share/shared-album/ci-linux-x64-4c";
/** Big enough that projection, not the plane's fixed cost, dominates. */
const SHARED_ASSETS = 200;

describe("share-journey.scale", () => {
  test("granting a 200-photo album reaches the grantee's own read", async () => {
    onTestFinished(closeOpenVaults);
    const home = household();
    const now = nowIso();
    const ravi = addParty(home.origin.vault, "Ravi", now);
    linkVault(home.origin.vault, ravi, AUDIENCE_VAULT, now);

    // `seedAlbum` puts one photo in; this rig needs a share whose projection
    // cost is visible, so the album is topped up to SHARED_ASSETS.
    const { albumId } = seedAlbum(home, now);
    for (let index = 1; index < SHARED_ASSETS; index += 1) {
      const photo = seedPhoto(home.origin, home.originBoot, `share-${index}`);
      addToAlbum(home, albumId, photo.assetId, index, now);
    }

    const seatFor = (vaultId: string) =>
      vaultId === AUDIENCE_VAULT ? home.audience : undefined;
    const transportFor = loopbackShareTransports({
      origin: home.origin,
      seatFor,
      now: () => now,
    });

    const grantStarted = performance.now();
    const grant = createShareGrant(home.origin.vault, {
      audience: { kind: "party", id: ravi },
      subjectType: "core.collection",
      subjectId: albumId,
      capability: "view",
      grantedAt: now,
      grantedBy: home.originBoot.ownerPartyId,
    });
    const grantMs = performance.now() - grantStarted;

    const fulfillStarted = performance.now();
    const delivered = startShareSubscription({
      origin: home.origin,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      transportFor,
      now,
    });
    const fulfillMs = performance.now() - fulfillStarted;

    const visibleStarted = performance.now();
    const titles = audienceTitles(home.audience.vault);
    const visibleMs = performance.now() - visibleStarted;
    const totalMs = grantMs + fulfillMs + visibleMs;

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Share a ${SHARED_ASSETS}-photo album, co-hosted`,
      status:
        totalMs < journeyCeiling(SHARE_KEY, "grantToVisible", "ceilingMs")
          ? "passed"
          : "failed",
      measurements: [
        { name: "grant written", value: grantMs, unit: "ms" },
        { name: "grant fulfilled", value: fulfillMs, unit: "ms" },
        { name: "grantee's own read", value: visibleMs, unit: "ms" },
        { name: "grant to visible", value: totalMs, unit: "ms" },
        { name: "assets shared", value: SHARED_ASSETS, unit: "count" },
      ],
    });

    expect(delivered.steps).toHaveLength(1);
    expect(delivered.steps[0]).toMatchObject({
      partyId: ravi,
      state: "delivered",
      peerVaultId: AUDIENCE_VAULT,
    });
    // The grantee sees every shared row, not merely a delivery receipt.
    expect(titles).toHaveLength(SHARED_ASSETS);
    expect(totalMs).toBeLessThan(
      journeyCeiling(SHARE_KEY, "grantToVisible", "ceilingMs")
    );
  });
});
