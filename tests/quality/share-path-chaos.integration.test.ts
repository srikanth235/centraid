/*
 * SEEDED CHAOS ON THE SHARE PATH (umbrella #1014, T16 + S3).
 *
 * The #929 subscription plane's six deterministic apply rules
 * (`docs/protocol.md`) had no chaos lane and no peer fault injection: the
 * tunnel lane beside this one faults the DEVICE intent path, and the only
 * owner of the peer share wire was a scale test on a cooperative link.
 *
 * Two real vaults, two real gateways' peer handlers wired to each other in
 * process, and a real predicate transport — compose the tail at the origin,
 * pull it over the peer dial, apply the three outputs at the audience. The
 * only synthetic part is the FAULT, injected at the dial: the seam a caller
 * above QUIC can honestly see a cut or a duplicate at.
 *
 * Every assertion reads REAL post-chaos state — the audience's own rows, its
 * `share_subscription` cursor, its `share_subscription_lineage` claims, the
 * blobs on its disk. Never a log line and never a timing.
 */

import { afterEach, describe, expect, test } from "vitest";

import { shareShapeId } from "../../packages/core/src/protocol/index.js";
import {
  link,
  makeSide,
} from "../../packages/server/src/serve/peer-give.test-fixtures.js";
import type { Side } from "../../packages/server/src/serve/peer-give.test-fixtures.js";
import type {
  PeerDial,
  PeerRequest,
} from "../../packages/server/src/serve/peer-link-client.js";
import { pullShareTail } from "../../packages/server/src/serve/share-subscriber.js";
import {
  addAudienceParty,
  addLocalParty,
  seedEverySubject,
  wireGoldenPair,
} from "../../packages/server/src/serve/share-subscription-peer.test-fixtures.js";
import {
  beginReplicaCommit,
  createShareGrant,
  endReplicaCommit,
  nowIso,
  readSubscription,
  readSubscriptionLineage,
} from "../../packages/vault/src/index.js";
import { SHARE_PATH_FAULTS } from "./network-faults.js";

const open: Side[] = [];

/** One cut, at the door the fault names. `undefined` lets the call through. */
type Cut = "tail" | "blob" | undefined;

function faultedDial(base: PeerDial, cut: () => Cut): PeerDial {
  const request: PeerRequest = async (input) => {
    const target = String(input.target);
    const which = cut();
    if (which === "tail" && target.includes("/replica/tail"))
      throw new Error("the connection was cut mid tail page");
    if (which === "blob" && target.includes("/replica/blob"))
      throw new Error("the connection was cut mid blob chunk");
    return base.request(input);
  };
  return { request, endpointTicketFor: base.endpointTicketFor };
}

interface World {
  origin: Side;
  audience: Side;
  grantId: string;
  dial: PeerDial;
  cut: Cut;
  pull: () => Promise<unknown>;
}

async function world(name: string): Promise<World> {
  const origin = makeSide(`${name}-origin`);
  const audience = makeSide(`${name}-audience`);
  open.push(origin, audience);
  await link(origin, audience);
  const audienceParty = addAudienceParty(origin, audience);
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
  const state: { cut: Cut } = { cut: undefined };
  const dial = faultedDial(
    wireGoldenPair(origin, audience).toOrigin,
    () => state.cut
  );
  const built: World = {
    origin,
    audience,
    grantId: grant.grantId,
    dial,
    get cut(): Cut {
      return state.cut;
    },
    set cut(value: Cut) {
      state.cut = value;
    },
    pull: () =>
      pullShareTail({
        dial,
        route: { endpointId: origin.endpointId, relayHints: [] },
        originVaultId: origin.vaultId,
        audienceVaultId: audience.vaultId,
        shapeId: shareShapeId(grant.grantId),
        seat: audience.vault,
        now: nowIso,
      }),
  };
  return built;
}

function count(side: Side, table: string): number {
  return (
    side.vault.vault.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;
}

function cursorOf(w: World): { epoch: string | null; seq: number } {
  return (
    readSubscription(w.audience.vault.vault, w.grantId, w.audience.vaultId)
      ?.cursor ?? { epoch: null, seq: 0 }
  );
}

describe("the subscription plane under a faulted peer wire (#1014 T16)", () => {
  afterEach(() => {
    for (const side of open.splice(0)) side.vault.close();
  });

  test("the catalog names exactly the three faults this lane injects", () => {
    // "Available but did not run" must never read as green: the lane asserts
    // its own coverage against the catalog rather than the other way round.
    expect(SHARE_PATH_FAULTS.map((fault) => fault.id)).toStrictEqual([
      "share-cut-mid-tail-page",
      "share-cut-mid-blob-chunk",
      "share-duplicate-delivery",
    ]);
    expect(
      SHARE_PATH_FAULTS.every((fault) => fault.tier === "in-process")
    ).toBe(true);
  });

  test("share-cut-mid-tail-page: an unapplied tail moves no cursor", async () => {
    const w = await world("spc-tail");
    w.cut = "tail";
    await expect(w.pull()).resolves.toMatchObject({ state: "unreachable" });
    // RULE: the domain mutation and the cursor advance settle atomically at
    // the audience vault — so a pass that never reached it did neither.
    expect(cursorOf(w)).toStrictEqual({ epoch: null, seq: 0 });
    expect(count(w.audience, "media_asset")).toBe(0);
    expect(
      readSubscriptionLineage(w.audience.vault.vault, w.grantId)
    ).toStrictEqual([]);

    // RULE: the retry is an idempotent upsert under the same version guard.
    w.cut = undefined;
    await expect(w.pull()).resolves.toMatchObject({ state: "applied" });
    expect(count(w.audience, "media_asset")).toBe(1);
    expect(cursorOf(w).seq).toBeGreaterThan(0);
  });

  test("share-cut-mid-blob-chunk: unverified bytes are never adopted", async () => {
    const w = await world("spc-blob");
    w.cut = "blob";
    await expect(w.pull()).resolves.toMatchObject({ state: "unreachable" });
    // Content addressing is the integrity check: nothing lands under an
    // address whose bytes this vault has not seen whole.
    expect(w.audience.vault.blobs.local.listSync()).toStrictEqual([]);
    // And no row landed claiming them: the rows and the bytes arrive together
    // or not at all.
    expect(count(w.audience, "media_asset")).toBe(0);
    expect(cursorOf(w)).toStrictEqual({ epoch: null, seq: 0 });

    w.cut = undefined;
    await expect(w.pull()).resolves.toMatchObject({ state: "applied" });
    expect(w.audience.vault.blobs.local.listSync().length).toBeGreaterThan(0);
    expect(count(w.audience, "media_asset")).toBe(1);
  });

  test("share-duplicate-delivery: a second apply of one pass changes nothing", async () => {
    const w = await world("spc-dup");
    await expect(w.pull()).resolves.toMatchObject({ state: "applied" });
    const rows = count(w.audience, "media_asset");
    const claims = readSubscriptionLineage(
      w.audience.vault.vault,
      w.grantId
    ).length;
    const cursor = cursorOf(w);

    // The ambiguous retry after an acknowledgement the audience never saw.
    for (let attempt = 0; attempt < 2; attempt += 1)
      // oxlint-disable-next-line no-await-in-loop -- the point is that the SECOND delivery follows the first
      await expect(w.pull()).resolves.toMatchObject({ state: "applied" });

    expect(count(w.audience, "media_asset")).toBe(rows);
    expect(
      readSubscriptionLineage(w.audience.vault.vault, w.grantId)
    ).toHaveLength(claims);
    // RULE: within an epoch the cursor only ever moves forward.
    expect(cursorOf(w).epoch).toBe(cursor.epoch);
    expect(cursorOf(w).seq).toBeGreaterThanOrEqual(cursor.seq);
  });

  test("S3: an offline audience converges once, per edit, on reconnect", async () => {
    const w = await world("spc-offline");
    await expect(w.pull()).resolves.toMatchObject({ state: "applied" });
    const assetId = (
      w.origin.vault.vault
        .prepare("SELECT asset_id FROM media_asset")
        .get() as {
        asset_id: string;
      }
    ).asset_id;

    // The audience is cut, and the origin edits the shared subject twice.
    w.cut = "tail";
    for (const caption of ["SHARED-EDIT-1", "SHARED-EDIT-2"]) {
      // AS THE GATEWAY MAKES ONE: the `update` half of the three outputs is
      // the LOG's, so an edit written behind the log is one no subscription
      // can see — a test that edits outside a commit tests a write the
      // product cannot produce.
      w.origin.vault.vault.exec("BEGIN IMMEDIATE");
      const handle = beginReplicaCommit(w.origin.vault.vault);
      w.origin.vault.vault
        .prepare("UPDATE media_asset SET title = ? WHERE asset_id = ?")
        .run(caption, assetId);
      endReplicaCommit(w.origin.vault.vault, handle);
      w.origin.vault.vault.exec("COMMIT");
      // oxlint-disable-next-line no-await-in-loop -- each attempt is an offline interval of its own
      await expect(w.pull()).resolves.toMatchObject({ state: "unreachable" });
    }

    // Reconnect: ONE pass carries the latest value, and the cursor lands on
    // the origin's head rather than half way through the two edits.
    w.cut = undefined;
    await expect(w.pull()).resolves.toMatchObject({ state: "applied" });
    expect(
      (
        w.audience.vault.vault
          .prepare("SELECT title FROM media_asset")
          .get() as { title: string | null }
      ).title
    ).toBe("SHARED-EDIT-2");
    // No lost update, no double: one asset row, one lineage claim for it.
    expect(count(w.audience, "media_asset")).toBe(1);
    expect(
      readSubscriptionLineage(w.audience.vault.vault, w.grantId).filter(
        (row) => row.targetType === "media.asset"
      )
    ).toHaveLength(1);

    // A pass with nothing left to carry does not move the audience again.
    const settled = cursorOf(w);
    await expect(w.pull()).resolves.toMatchObject({ state: "applied" });
    expect(cursorOf(w).seq).toBeGreaterThanOrEqual(settled.seq);
    expect(count(w.audience, "media_asset")).toBe(1);
  });
});
