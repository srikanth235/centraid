/*
 * THE GOLDEN PAIR (#929): one link, two gateways in one process, and a
 * subscription for every offerable subject type.
 *
 * What this holds:
 *   - each of the six subject types reaches an audience vault on ANOTHER
 *     gateway over the peer plane, and the co-hosted case takes the loopback;
 *   - the seat PULLS: the origin's notice carries no rows, so a linked peer
 *     cannot write into an audience vault by announcing;
 *   - revocation settles `removed` only on the seat's acknowledgement.
 */

import { describe, expect, test, vi } from "vitest";

import {
  createShareGrant,
  listPendingShareDeliveries,
  loopbackShareTransports,
  nowIso,
  readFulfillment,
  revokeShareGrant,
  startShareSubscription,
  stopShareSubscription,
} from "@centraid/vault";

import {
  link,
  makeCoHostedSides,
  makeSide,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import {
  addAudienceParty,
  addLocalParty,
  bindPartyToVault,
  grantEach,
  seedEverySubject,
  wireGoldenPair,
} from "./share-subscription-peer.test-fixtures.js";
import { sweepShareSubscriptions } from "./share-subscription-sweep.js";

// Real vaults, six closures and a Tally sub-graph across two gateways: cold
// setup under the concurrent gate can exceed the small unit default.
vi.setConfig({ testTimeout: 60_000 });

function held(side: Side, probe: { table: string; column: string }): number {
  const row = side.vault.vault
    .prepare(`SELECT count(*) AS n FROM "${probe.table}"`)
    .get() as { n: number };
  return row.n;
}

describe("a share is a subscription, across two gateways", () => {
  test("every subject type reaches a remote audience over the peer plane", async () => {
    const origin = makeSide("gp-origin");
    const audience = makeSide("gp-audience");
    await link(origin, audience);
    const audienceParty = addAudienceParty(origin, audience);
    const member = addLocalParty(origin, "Ledger member");
    const subjects = seedEverySubject(origin, member);
    const grants = grantEach(origin, subjects, audienceParty);
    const { toAudience } = wireGoldenPair(origin, audience);

    for (const subject of subjects) {
      const grantId = grants.get(subject.subjectType)!;
      // The pass runs on the commit path, so it does not dial: it leaves the
      // row pending and names the route.
      const started = startShareSubscription({
        origin: origin.vault,
        originVaultId: origin.vaultId,
        grantId,
        transportFor: () => ({
          route: "peer",
          deliver: () => ({ outcome: "unreachable", detail: "queued" }),
          remove: () => ({ outcome: "unreachable", detail: "queued" }),
        }),
        now: nowIso(),
      });
      expect(started.steps[0]).toMatchObject({
        state: "syncing",
        route: "peer",
        peerVaultId: audience.vaultId,
      });
    }
    expect(
      listPendingShareDeliveries(origin.vault.vault).length
    ).toBeGreaterThanOrEqual(subjects.length);

    const swept = await sweepShareSubscriptions({
      origin: origin.vault,
      originVaultId: origin.vaultId,
      dial: toAudience,
      routeTo: () => ({
        endpointId: audience.endpointId,
        relayHints: [],
        assertedAt: Date.now(),
      }),
      now: nowIso,
    });
    expect(
      swept.map((step) => step.result.outcome),
      JSON.stringify(swept.map((step) => step.result))
    ).toStrictEqual(swept.map(() => "delivered"));

    // Every subject type is now readable from the AUDIENCE's own vault.
    for (const subject of subjects)
      expect(
        held(audience, subject.probe),
        subject.subjectType
      ).toBeGreaterThan(0);
    // The bytes came over the peer plane, not a hardlink: different gateways,
    // different CAS roots, so the audience holds its own copy of every sha the
    // manifest claimed and `ingestSync` re-hashed each one on the way in.
    expect(
      audience.vault.vault
        .prepare("SELECT count(*) AS n FROM core_content_item")
        .get()
    ).toMatchObject({ n: 2 });
    expect(audience.vault.blobs.local.listSync().length).toBeGreaterThan(0);

    // Revocation: the origin sends, the SEAT acknowledges, and only then does
    // the row settle `removed`.
    const albumGrant = grants.get("core.collection")!;
    revokeShareGrant(origin.vault.vault, {
      grantId: albumGrant,
      revokedAt: nowIso(),
    });
    stopShareSubscription({
      origin: origin.vault,
      originVaultId: origin.vaultId,
      grantId: albumGrant,
      transportFor: () => ({
        route: "peer",
        deliver: () => ({ outcome: "unreachable", detail: "queued" }),
        remove: () => ({ outcome: "unreachable", detail: "queued" }),
      }),
      now: nowIso(),
    });
    expect(
      readFulfillment(origin.vault.vault, albumGrant, audience.vaultId)
    ).toMatchObject({ state: "remove_sent" });
    await sweepShareSubscriptions({
      origin: origin.vault,
      originVaultId: origin.vaultId,
      dial: toAudience,
      routeTo: () => ({
        endpointId: audience.endpointId,
        relayHints: [],
        assertedAt: Date.now(),
      }),
      now: nowIso,
    });
    expect(
      readFulfillment(origin.vault.vault, albumGrant, audience.vaultId)
    ).toMatchObject({ state: "removed" });
    expect(held(audience, { table: "core_collection", column: "" })).toBe(0);

    origin.vault.close();
    audience.vault.close();
  });

  test("a co-hosted audience takes the loopback in the same pass", () => {
    const [origin, audience] = makeCoHostedSides(
      "gp-host",
      "gp-local-origin",
      "gp-local-audience"
    );
    const audienceParty = addLocalParty(origin, "Co-hosted");
    bindPartyToVault(origin, audienceParty, audience.vaultId);
    const photo = seedEverySubject(
      origin,
      addLocalParty(origin, "Ledger member")
    ).find((subject) => subject.subjectType === "media.asset")!;
    const grant = createShareGrant(origin.vault.vault, {
      audience: { kind: "party", id: audienceParty },
      subjectType: "media.asset",
      subjectId: photo.subjectId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: origin.ownerPartyId,
    });
    const result = startShareSubscription({
      origin: origin.vault,
      originVaultId: origin.vaultId,
      grantId: grant.grantId,
      transportFor: loopbackShareTransports({
        origin: origin.vault,
        seatFor: (vaultId) =>
          vaultId === audience.vaultId ? audience.vault : undefined,
        now: nowIso,
      }),
      now: nowIso(),
    });
    expect(result.steps[0]).toMatchObject({
      state: "delivered",
      route: "loopback",
      apply: "bootstrap",
    });
    expect(held(audience, { table: "media_asset", column: "" })).toBe(1);
    // Nothing is left for the sweep: the loopback settled in this pass.
    expect(listPendingShareDeliveries(origin.vault.vault)).toStrictEqual([]);

    origin.vault.close();
    audience.vault.close();
  });

  test("the origin refuses a shape the grant does not reach", async () => {
    const origin = makeSide("gp-refuse-origin");
    const audience = makeSide("gp-refuse-audience");
    const stranger = makeSide("gp-refuse-stranger");
    await link(origin, audience);
    const audienceParty = addAudienceParty(origin, audience);
    const subjects = seedEverySubject(
      origin,
      addLocalParty(origin, "Ledger member")
    );
    const grants = grantEach(origin, subjects, audienceParty);
    const { toOrigin } = wireGoldenPair(origin, audience);

    // A shape id for a real grant, asked for on behalf of a vault the grant
    // never reached: `not_found`, the same answer an unknown shape gets.
    const response = await toOrigin.request({
      endpointTicket: "ticket",
      method: "GET",
      target:
        "/centraid/_peer/replica/bootstrap?" +
        new URLSearchParams({
          originVaultId: origin.vaultId,
          audienceVaultId: stranger.vaultId,
          shapeId: `@share:${grants.get("media.asset")!}`,
        }).toString(),
    });
    expect(response.status).toBe(404);

    origin.vault.close();
    audience.vault.close();
    stranger.vault.close();
  });
});
