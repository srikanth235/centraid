/*
 * Exit evidence for the REMOTE GIVE half of #726 P3 (decisions 7 and 9), two
 * gateways in one process — the same in-process-transport pattern
 * `peer-link-ceremony.test.ts` uses for the link ceremony itself. What this
 * proves that the reconciler unit tests cannot: derivatives paint at the
 * audience before the original arrives, the original's ranged pull verifies
 * its own sha and resumes rather than restarting, a re-give of bytes the
 * audience already holds moves none, and D9 refuse/ask are states — never
 * exceptions, never bytes, never leaks about what else exists. The D9
 * 'refuse'-reaches-the-origin gap is its own suite: `peer-refusal-relay.test.ts`.
 */

import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import { makeEdgeAnswerRouteHandler } from "../routes/edge-answer-routes.js";
import { reconcileRemoteEdge } from "../routes/edges-reconcile-remote.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { judgeEdgeCrossing } from "./link-crossing.js";
import { drainPeerBlobPulls } from "./peer-blob-pull.js";
import {
  contentItemCount,
  derivativeRows,
  dialFrom,
  dialFromHost,
  insertEdgeRow,
  link,
  makeCoHostedSides,
  makeSide,
  routeFrom,
  seedPhoto,
  transportTo,
} from "./peer-give.test-fixtures.js";
import type { PeerRequest } from "./peer-link-client.js";
import { setReceiveSetting } from "./peer-receive-settings.js";

describe("remote give (#726 P3)", () => {
  test("derivatives paint immediately; the original is pulled ranged and resumes after interruption", async () => {
    const origin = makeSide("origin-a");
    const audience = makeSide("audience-a");
    await link(origin, audience);
    const photo = seedPhoto(origin, "resume");
    const row = insertEdgeRow(origin, {
      edgeId: "edge-derivatives",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });

    const updated = await reconcileRemoteEdge(
      origin.gatewayDb,
      row,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );
    expect(updated.status).toBe("completed");

    // The audience painted the thumb before pulling anything else.
    expect(derivativeRows(audience.vault).map((r) => r.sha256)).toStrictEqual([
      photo.thumbSha,
    ]);
    expect(audience.vault.blobs.local.hasSync(photo.thumbSha)).toBe(true);
    // The original is recorded (a content_item row exists) but its bytes
    // are not yet local — exactly one pending pull.
    expect(audience.vault.blobs.local.hasSync(photo.sha256)).toBe(false);
    const pending = () =>
      audience.gatewayDb.db
        .prepare("SELECT sha256, tmp_path FROM peer_blob_pulls")
        .all() as Array<{ sha256: string; tmp_path: string }>;
    expect(pending().map((p) => p.sha256)).toStrictEqual([photo.sha256]);

    // Interrupted: the transport fails after the first (tiny) chunk.
    let calls = 0;
    const flakyRequest: PeerRequest = async (input) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated network drop");
      return transportTo(origin, audience.endpointId)(input);
    };
    const firstDrain = await drainPeerBlobPulls({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: (vaultId) =>
        vaultId === audience.vaultId ? audience.vault : undefined,
      dial: {
        request: flakyRequest,
        endpointTicketFor: (id) => `ticket-for-${id}`,
      },
      chunkBytes: 4,
    });
    expect(firstDrain.pending).toStrictEqual([photo.sha256]);
    expect(audience.vault.blobs.local.hasSync(photo.sha256)).toBe(false);
    const partialPath = pending()[0]!.tmp_path;
    const partialSize = statSync(partialPath).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(photo.bytes.length);

    // Resumed: a working transport continues from the partial offset rather
    // than restarting, and completes with the sha verified.
    const offsetsRequested: number[] = [];
    const resumingRequest: PeerRequest = async (input) => {
      const url = new URL(input.target, "http://x");
      offsetsRequested.push(Number(url.searchParams.get("offset")));
      return transportTo(origin, audience.endpointId)(input);
    };
    const secondDrain = await drainPeerBlobPulls({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: (vaultId) =>
        vaultId === audience.vaultId ? audience.vault : undefined,
      dial: {
        request: resumingRequest,
        endpointTicketFor: (id) => `ticket-for-${id}`,
      },
      chunkBytes: 4,
    });
    expect(secondDrain.done).toStrictEqual([photo.sha256]);
    expect(offsetsRequested[0]).toBe(partialSize);
    expect(audience.vault.blobs.local.hasSync(photo.sha256)).toBe(true);
    expect(
      audience.vault.blobs.local.getSync(photo.sha256)?.equals(photo.bytes)
    ).toBe(true);
    expect(pending()).toHaveLength(0);
  });

  test("re-giving a held original short-circuits by sha — no bytes are pulled again", async () => {
    const origin = makeSide("origin-b");
    const audience = makeSide("audience-b");
    await link(origin, audience);
    const photo = seedPhoto(origin, "regive");
    const first = insertEdgeRow(origin, {
      edgeId: "edge-first",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });
    await reconcileRemoteEdge(
      origin.gatewayDb,
      first,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );
    await drainPeerBlobPulls({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: (vaultId) =>
        vaultId === audience.vaultId ? audience.vault : undefined,
      dial: dialFrom(audience, origin),
    });
    expect(audience.vault.blobs.local.hasSync(photo.sha256)).toBe(true);

    // Give the SAME item again, on a fresh edge.
    const second = insertEdgeRow(origin, {
      edgeId: "edge-second",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });
    const updated = await reconcileRemoteEdge(
      origin.gatewayDb,
      second,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );
    expect(updated.status).toBe("completed");
    // No pending pull was ever queued for bytes already resident.
    expect(
      audience.gatewayDb.db.prepare("SELECT * FROM peer_blob_pulls").all()
    ).toHaveLength(0);
    expect(contentItemCount(audience.vault)).toBe(1);
  });

  test("an unlinked or revoked peer sees not_found", async () => {
    const origin = makeSide("origin-c");
    const audience = makeSide("audience-c");
    // Never linked — a stranger's give attempt.
    const strangerAnswer = await transportTo(
      audience,
      "stranger-endpoint"
    )({
      endpointTicket: "irrelevant",
      method: "POST",
      target: "/centraid/_peer/edge/give",
      body: {
        edgeId: "x",
        itemType: "media.asset",
        closure: {},
        derivatives: [],
      },
    });
    expect(strangerAnswer.status).toBe(404);
    expect(strangerAnswer.json).toStrictEqual({ state: "not_found" });

    await link(origin, audience);
    const linkId = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!.linkId;
    audience.links.revoke(linkId);
    const photo = seedPhoto(origin, "revoked");
    const row = insertEdgeRow(origin, {
      edgeId: "edge-revoked",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });
    const crossing = judgeEdgeCrossing(
      {
        links: origin.links,
        ownerOf: (vaultId) =>
          vaultId === origin.vaultId ? origin.ownerId : undefined,
      },
      origin.vaultId,
      audience.vaultId
    );
    // The origin's OWN link row is unrevoked (revoking is per-side bookkeeping
    // in this fixture — only the audience's copy was revoked), so the origin
    // still dials out; the audience is the one that must answer not_found.
    // Asserted unconditionally (not inside an `if`) so a fixture regression
    // that stops producing a route fails loudly instead of skipping the
    // assertions below.
    expect(crossing.state).toBe("linked");
    if (crossing.state !== "linked" || !crossing.route) {
      throw new Error("expected a linked crossing with a route");
    }
    const updated = await reconcileRemoteEdge(
      origin.gatewayDb,
      row,
      origin.vault,
      crossing.route,
      dialFrom(origin, audience)
    );
    expect(updated.status).toBe("parked");
    expect(updated.reason).toBe("peer link not reachable");
    expect(contentItemCount(audience.vault)).toBe(0);
  });

  test("a refused edge fails at the sender as a state, moves zero bytes, and leaves earlier gives untouched", async () => {
    const origin = makeSide("origin-d");
    const audience = makeSide("audience-d");
    await link(origin, audience);
    const linkId = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!.linkId;

    // A prior successful give.
    const kept = seedPhoto(origin, "kept");
    const keptEdge = insertEdgeRow(origin, {
      edgeId: "edge-kept",
      audienceVaultId: audience.vaultId,
      itemIds: [kept.assetId],
    });
    await reconcileRemoteEdge(
      origin.gatewayDb,
      keptEdge,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );
    expect(contentItemCount(audience.vault)).toBe(1);

    // Now the audience stops accepting.
    setReceiveSetting(audience.gatewayDb, linkId, audience.vaultId, "refuse");
    const refused = seedPhoto(origin, "refused");
    const refusedEdge = insertEdgeRow(origin, {
      edgeId: "edge-refused",
      audienceVaultId: audience.vaultId,
      itemIds: [refused.assetId],
    });
    const updated = await reconcileRemoteEdge(
      origin.gatewayDb,
      refusedEdge,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );

    // Fails at the SENDER as a typed state, never an exception.
    expect(updated.status).toBe("denied");
    expect(updated.reason).toBe("recipient is not accepting gives right now");
    // Zero bytes moved, nothing written for the refused item...
    expect(audience.vault.blobs.local.hasSync(refused.sha256)).toBe(false);
    expect(audience.vault.blobs.local.hasSync(refused.thumbSha)).toBe(false);
    // ...and the earlier, already-given item is untouched.
    expect(contentItemCount(audience.vault)).toBe(1);
    expect(audience.vault.blobs.local.hasSync(kept.thumbSha)).toBe(true);
  });

  test("D9 'ask' parks the edge and writes nothing until the audience owner accepts", async () => {
    const origin = makeSide("origin-e");
    const audience = makeSide("audience-e");
    await link(origin, audience);
    const linkId = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!.linkId;
    setReceiveSetting(audience.gatewayDb, linkId, audience.vaultId, "ask");

    const photo = seedPhoto(origin, "asked");
    const row = insertEdgeRow(origin, {
      edgeId: "edge-asked",
      audienceVaultId: audience.vaultId,
      itemIds: [photo.assetId],
    });
    const updated = await reconcileRemoteEdge(
      origin.gatewayDb,
      row,
      origin.vault,
      routeFrom(origin, audience),
      dialFrom(origin, audience)
    );
    expect(updated.status).toBe("parked");
    expect(updated.reason).toBe("awaiting recipient decision");
    expect(contentItemCount(audience.vault)).toBe(0);
    const pendingRow = audience.gatewayDb.db
      .prepare("SELECT * FROM peer_pending_gives WHERE edge_id = ?")
      .get("edge-asked");
    expect(pendingRow).toBeDefined();

    // The owner later accepts — the audience PULLS the closure fresh.
    const answerHandler = makeEdgeAnswerRouteHandler({
      gatewayDatabase: audience.gatewayDb,
      enrollments: EnrollmentStore.open(audience.gatewayDb),
      links: audience.links,
      vaultFor: (vaultId) =>
        vaultId === audience.vaultId ? audience.vault : undefined,
      peerDial: dialFrom(audience, origin),
    });
    const answerReq = Readable.from([
      Buffer.from(JSON.stringify({ decision: "accept" })),
    ]) as IncomingMessage;
    answerReq.method = "POST";
    answerReq.url = "/centraid/_gateway/edges/edge-asked/answer";
    answerReq.headers = { [AUTHED_DEVICE_HEADER]: audience.deviceId };
    let answerStatus = 0;
    let answerBody = "";
    const answerRes = {
      setHeader: () => undefined,
      end(value?: string | Buffer) {
        if (value) answerBody += value.toString();
      },
      get statusCode() {
        return answerStatus;
      },
      set statusCode(value: number) {
        answerStatus = value;
      },
    } as unknown as ServerResponse;
    await answerHandler(answerReq, answerRes);
    expect(answerStatus).toBe(200);
    expect(JSON.parse(answerBody)).toMatchObject({ decision: "accept" });
    expect(contentItemCount(audience.vault)).toBe(1);
    expect(
      audience.gatewayDb.db
        .prepare("SELECT * FROM peer_pending_gives WHERE edge_id = ?")
        .get("edge-asked")
    ).toBeUndefined();
  });

  test("two vaults co-hosted on one remote gateway both link and give correctly, attributed to the right counterparty (#726 audit finding 2)", async () => {
    // An iroh endpoint is per-GATEWAY, not per-vault (D1 invariant 2): `x`
    // and `y` share one `gatewayDb`/`links`/`endpointId` — the household
    // shape where two people's vaults are hosted on one box. `audience`'s
    // `vault_links` table ends up with TWO rows both routed through the SAME
    // endpoint, which is exactly what `linkForEndpoint` alone could not tell
    // apart before this fix.
    const [x, y] = makeCoHostedSides("household-co", "x-co", "y-co");
    const audience = makeSide("z-solo");
    await link(x, audience);
    await link(y, audience);

    const photoFromX = seedPhoto(x, "from-x");
    const photoFromY = seedPhoto(y, "from-y");

    const edgeFromX = insertEdgeRow(x, {
      edgeId: "edge-from-x-co",
      audienceVaultId: audience.vaultId,
      itemIds: [photoFromX.assetId],
    });
    const updatedFromX = await reconcileRemoteEdge(
      x.gatewayDb,
      edgeFromX,
      x.vault,
      routeFrom(x, audience),
      dialFrom(x, audience)
    );
    expect(updatedFromX.status).toBe("completed");

    const edgeFromY = insertEdgeRow(y, {
      edgeId: "edge-from-y-co",
      audienceVaultId: audience.vaultId,
      itemIds: [photoFromY.assetId],
    });
    const updatedFromY = await reconcileRemoteEdge(
      y.gatewayDb,
      edgeFromY,
      y.vault,
      routeFrom(y, audience),
      dialFrom(y, audience)
    );
    expect(updatedFromY.status).toBe("completed");

    // Both derivatives painted — neither give silently failed nor landed
    // under the other co-hosted vault's identity.
    expect(
      derivativeRows(audience.vault)
        .map((r) => r.sha256)
        .sort()
    ).toStrictEqual([photoFromX.thumbSha, photoFromY.thumbSha].sort());

    // Both originals are pending, one pull queue per edge — the audience now
    // dials INTO the shared household endpoint for both, each ranged pull
    // naming its OWN `edgeId` (the blob-route half of the fix) so the host
    // can resolve which of `x`/`y` it concerns rather than guessing from the
    // endpoint alone.
    const drained = await drainPeerBlobPulls({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: (vaultId) =>
        vaultId === audience.vaultId ? audience.vault : undefined,
      dial: dialFromHost(audience, [x, y]),
    });
    expect(drained.done.sort()).toStrictEqual(
      [photoFromX.sha256, photoFromY.sha256].sort()
    );
    // Attributed correctly, not swapped: each original's bytes match its OWN
    // source, never the co-hosted sibling's.
    expect(
      audience.vault.blobs.local
        .getSync(photoFromX.sha256)
        ?.equals(photoFromX.bytes)
    ).toBe(true);
    expect(
      audience.vault.blobs.local
        .getSync(photoFromY.sha256)
        ?.equals(photoFromY.bytes)
    ).toBe(true);
  });
});
