/*
 * Closure evidence for #726: one sequential story over the SAME two gateway
 * artifacts. The phase suites remain useful fault-isolation tests, but this
 * composition is the canary for seams between mint, local placement, route
 * migration, remote give/refusal, lend/write-back, and revocation.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";

import { startGatewayEndpoint } from "@centraid/tunnel";
import type { GatewayEndpointHandle } from "@centraid/tunnel";
import { shareToVault } from "@centraid/vault";

import { resolveInvitation } from "../routes/device-invitations.js";
import { closeLiveEdge } from "../routes/edges-live.js";
import { reconcileRemoteEdge } from "../routes/edges-reconcile-remote.js";
import { readEdgeRow } from "../routes/edges-reconcile.js";
import { makePeerPlaneHandler } from "../routes/peer-plane.js";
import { expectedPayloadHash } from "../routes/replica-intent-shape.js";
import { EnrollmentStore } from "./enrollment-store.js";
import type { BorrowedDeps } from "./lend-audience.js";
import { syncBorrowedEdge } from "./lend-audience.js";
import { pushLendIntentOverPeer } from "./lend-client.js";
import { borrowedSlotsFor, lend } from "./lend.test-fixtures.js";
import { drainPeerBlobPulls } from "./peer-blob-pull.js";
import { startPeerDial } from "./peer-dial.js";
import type { PeerDialHandle } from "./peer-dial.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import {
  contentItemCount,
  insertEdgeRow,
  makeSide,
  routeFrom,
  seedPhoto,
} from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import {
  encodeLinkTicket,
  parseLinkTicket,
  redeemLinkTicket,
} from "./peer-link-client.js";
import { setReceiveSetting } from "./peer-receive-settings.js";

vi.setConfig({ testTimeout: 30_000 });

interface PeerArtifact {
  side: Side;
  upstream: http.Server;
  endpoint: GatewayEndpointHandle;
  dial: PeerDialHandle;
  closed: boolean;
}

const artifacts: PeerArtifact[] = [];

async function bootPeerArtifact(
  side: Side,
  borrowed?: BorrowedDeps
): Promise<PeerArtifact> {
  const token = crypto.randomBytes(16).toString("hex");
  const endpointCell: { current?: GatewayEndpointHandle } = {};
  const handler = makePeerPlaneHandler({
    links: side.links,
    peerProof: side.proof,
    vaultPublicKey: (vaultId) =>
      vaultId === side.vaultId ? side.publicKey : undefined,
    localRoute: () => ({
      endpointId: endpointCell.current?.endpointId,
      relayHints: [],
    }),
    localLabel: () => side.label,
    vaultFor: (vaultId) => (vaultId === side.vaultId ? side.vault : undefined),
    gatewayDatabase: side.gatewayDb,
    lend: {
      signAsVault: side.signAsVault,
      ...(borrowed ? { borrowed } : {}),
      gatewayFor: (vaultId) =>
        vaultId === side.vaultId ? side.gateway : undefined,
    },
  });
  const upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    void handler(req, res);
  });
  const baseUrl = await new Promise<string>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  const secretKey = crypto.randomBytes(32);
  const endpoint = await startGatewayEndpoint({
    secretKey,
    upstream: () => ({ baseUrl, token }),
    authorize: () => false,
    pair: () => ({ ok: false, error: "not_supported" }),
    authorizePeer: (endpointId) =>
      side.links.isLinked(endpointId) ||
      side.links.hasAnyLink() ||
      side.links.tickets.hasPending(),
    peerRequestHeaders: (endpointId) => {
      const link = side.links.peerForEndpoint(endpointId);
      return {
        "x-centraid-peer-endpoint": endpointId,
        "x-centraid-peer-proof": side.proof,
        ...(link ? { "x-centraid-peer-vault": link.peerVaultId } : {}),
      };
    },
    relays: "disabled",
  });
  endpointCell.current = endpoint;
  side.endpointId = endpoint.endpointId;
  const artifact = {
    side,
    upstream,
    endpoint,
    dial: startPeerDial({ secretKey, relays: "disabled" }),
    closed: false,
  };
  artifacts.push(artifact);
  return artifact;
}

async function closePeerArtifact(artifact: PeerArtifact): Promise<void> {
  if (artifact.closed) return;
  artifact.closed = true;
  await artifact.dial.close();
  await artifact.endpoint.close();
  await new Promise<void>((resolve) => {
    artifact.upstream.close(() => resolve());
  });
}

function dialBetween(caller: PeerArtifact, callee: PeerArtifact): PeerDial {
  return {
    request: caller.dial.request,
    endpointTicketFor: () => callee.endpoint.ticket(),
  };
}

async function linkArtifacts(
  shower: PeerArtifact,
  scanner: PeerArtifact
): Promise<void> {
  const ticket = shower.side.links.tickets.mint(
    shower.side.vaultId,
    shower.side.publicKey
  );
  const payload = parseLinkTicket(
    encodeLinkTicket({
      v: 1,
      kind: "centraid-link",
      vaultId: shower.side.vaultId,
      vaultPublicKey: shower.side.publicKey,
      endpointTicket: shower.endpoint.ticket(),
      ticketId: ticket.ticketId,
      secret: ticket.secret,
    })
  )!;
  const result = await redeemLinkTicket({
    ticket: payload,
    links: scanner.side.links,
    request: scanner.dial.request,
    localVault: {
      vaultId: scanner.side.vaultId,
      publicKey: scanner.side.publicKey,
    },
    localRoute: {
      endpointId: scanner.endpoint.endpointId,
      relayHints: [],
    },
    localLabel: scanner.side.label,
  });
  if (result.state !== "linked")
    throw new Error(`expected a linked ceremony, got ${result.state}`);
}

describe("#726 composed share-plane lifecycle", () => {
  afterEach(async () => {
    await Promise.all(artifacts.splice(0).map(closePeerArtifact));
  });

  test("drives the complete story over the same two gateway artifacts", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const origin = makeSide(`origin-lifecycle-${suffix}`);
    const audience = makeSide(`audience-lifecycle-${suffix}`);
    const borrowed = borrowedSlotsFor(audience);
    const originArtifact = await bootPeerArtifact(origin);
    let audienceArtifact = await bootPeerArtifact(audience, borrowed);

    // 1. Mint a vault for a second person. This is the production decision
    // helper used by the device-ticket route; the minted vault is sovereign
    // immediately even though this first part of the story is co-hosted.
    const invitation = resolveInvitation({
      enrollments: EnrollmentStore.open(origin.gatewayDb),
      vaultName: (vaultId) =>
        vaultId === audience.vaultId ? "Maya's vault" : undefined,
      callerKey: origin.deviceId,
      hostCustody: false,
      target: "",
      body: {},
      vaultIds: [],
      forPerson: { label: "Maya" },
      mintVaultForPerson: () => ({ vaultId: audience.vaultId }),
    });
    expect(invitation).toMatchObject({
      ownerLabel: "Maya",
      vaultIds: [audience.vaultId],
    });
    if ("error" in invitation) throw new Error(invitation.message);
    expect(
      origin.gatewayDb.db
        .prepare("SELECT owner_id FROM vault_owners WHERE vault_id = ?")
        .get(audience.vaultId)
    ).toMatchObject({ owner_id: invitation.ownerId });

    // 2. The two owners approve a local link, then one photo is given through
    // the shared closure/projection substrate. No peer transport is used yet.
    const localLink = origin.links.propose({
      fromVaultId: origin.vaultId,
      fromPublicKey: origin.publicKey,
      fromLabel: origin.label,
      toVaultId: audience.vaultId,
      toPublicKey: audience.publicKey,
      toLabel: audience.label,
    });
    origin.links.approve(localLink.linkId, audience.vaultId);
    const localPhoto = seedPhoto(origin, "local-before-move");
    const localGive = shareToVault({
      origin: origin.vault,
      originVaultId: origin.vaultId,
      audience: audience.vault,
      itemType: "media.media_asset",
      itemId: localPhoto.assetId,
      sharedBy: origin.ownerId,
      crossOwner: true,
    });
    expect(localGive.deduped).toBe(false);
    expect(contentItemCount(audience.vault)).toBe(1);
    expect(audience.vault.blobs.local.hasSync(localPhoto.thumbSha)).toBe(true);

    // 3. Moving the audience vault changes only its route. The remote ceremony
    // upgrades the pre-existing pair in place, so the link id, vault identity,
    // and already-given rows survive the host move.
    const publicKeyBeforeMove = audience.publicKey;
    await closePeerArtifact(audienceArtifact);
    audienceArtifact = await bootPeerArtifact(audience, borrowed);
    await linkArtifacts(originArtifact, audienceArtifact);
    expect(audience.publicKey).toBe(publicKeyBeforeMove);
    expect(
      origin.links.findPair(origin.vaultId, audience.vaultId)?.linkId
    ).toBe(localLink.linkId);
    expect(
      origin.links.peerForVault(audience.vaultId, origin.vaultId)?.route
        .endpointId
    ).toBe(audience.endpointId);
    expect(contentItemCount(audience.vault)).toBe(1);

    // 4. Give remotely. The derivative paints synchronously; the original is
    // then pulled in deliberately tiny ranges and verified into the audience.
    const remotePhoto = seedPhoto(origin, "remote-after-move");
    const remoteEdge = insertEdgeRow(origin, {
      edgeId: `edge-give-${suffix}`,
      audienceVaultId: audience.vaultId,
      itemIds: [remotePhoto.assetId],
    });
    await expect(
      reconcile(origin, audience, remoteEdge.edge_id)
    ).resolves.toMatchObject({ status: "completed" });
    expect(audience.vault.blobs.local.hasSync(remotePhoto.thumbSha)).toBe(true);
    expect(audience.vault.blobs.local.hasSync(remotePhoto.sha256)).toBe(false);
    await expect(
      drainPeerBlobPulls({
        db: audience.gatewayDb,
        links: audience.links,
        vaultFor: (vaultId) =>
          vaultId === audience.vaultId ? audience.vault : undefined,
        dial: dialBetween(audienceArtifact, originArtifact),
        chunkBytes: 4,
      })
    ).resolves.toMatchObject({ done: [remotePhoto.sha256] });
    expect(audience.vault.blobs.local.hasSync(remotePhoto.sha256)).toBe(true);
    expect(contentItemCount(audience.vault)).toBe(2);

    // 5. Refuse the next give. It is a typed sender-side state and cannot
    // erase either gift that already completed.
    const audienceLink = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    )!;
    setReceiveSetting(
      audience.gatewayDb,
      audienceLink.linkId,
      audience.vaultId,
      "refuse"
    );
    const refusedPhoto = seedPhoto(origin, "refused");
    const refusedEdge = insertEdgeRow(origin, {
      edgeId: `edge-refused-${suffix}`,
      audienceVaultId: audience.vaultId,
      itemIds: [refusedPhoto.assetId],
    });
    await expect(
      reconcile(origin, audience, refusedEdge.edge_id)
    ).resolves.toMatchObject({
      status: "denied",
      reason: "recipient is not accepting gives right now",
    });
    expect(audience.vault.blobs.local.hasSync(refusedPhoto.thumbSha)).toBe(
      false
    );
    expect(contentItemCount(audience.vault)).toBe(2);
    expect(audience.vault.blobs.local.hasSync(remotePhoto.sha256)).toBe(true);
    setReceiveSetting(
      audience.gatewayDb,
      audienceLink.linkId,
      audience.vaultId,
      "accept"
    );

    // 6. Lend a write-capable Tasks scope, land its borrowed shape, and send a
    // device-shaped intent back through the peer plane. The row is authored in
    // the origin's ordinary vault and nowhere in the audience's vault.db.
    const opened = await lend(origin, audience, borrowed, {
      edgeId: `edge-lend-${suffix}`,
      itemType: "schedule.task",
      scopes: [{ schema: "schedule" }],
      verbs: "read+act",
      transport: {
        originToAudience: dialBetween(originArtifact, audienceArtifact),
        audienceToOrigin: dialBetween(audienceArtifact, originArtifact),
      },
    });
    expect(opened.edge.status).toBe("established");
    await expect(
      syncBorrowedEdge(borrowed, opened.identity, opened.pull)
    ).resolves.toMatchObject({ state: "established" });
    const borrowedStore = borrowed.storeFor(origin.vaultId);
    const borrowedShape = borrowedStore.shapeForEdge(opened.edge.edge_id)!;
    const writeInput = { title: "Written back through the lend" };
    const write = await pushLendIntentOverPeer({
      dial: dialBetween(audienceArtifact, originArtifact),
      route: routeFrom(audience, origin),
      edgeId: opened.edge.edge_id,
      request: {
        intentId: `intent-${suffix}`,
        action: "schedule.add_task",
        input: writeInput,
        baseVersions: [],
        payloadHash: expectedPayloadHash(
          opened.edge.edge_id,
          "schedule.add_task",
          writeInput,
          []
        ),
      },
    });
    expect(write).toMatchObject({
      state: "answered",
      frame: { state: "executed" },
    });
    if (write.state !== "answered" || write.frame.state !== "executed")
      throw new Error("write-back did not execute");
    const taskId = (write.frame.output as { task_id: string }).task_id;
    expect(
      origin.vault.vault
        .prepare("SELECT title FROM schedule_task WHERE task_id = ?")
        .get(taskId)
    ).toMatchObject({ title: writeInput.title });
    expect(
      audience.vault.vault
        .prepare("SELECT count(*) AS n FROM schedule_task")
        .get()
    ).toMatchObject({ n: 0 });

    // 7. Revoke. The origin grant refuses future pulls and the audience's
    // borrowed shape (rows, search state, and queued outcomes) is deleted.
    const closed = await closeLiveEdge({
      db: origin.gatewayDb,
      row: readEdgeRow(origin.gatewayDb, opened.edge.edge_id)!,
      origin: origin.vault,
      route: routeFrom(origin, audience),
      peerDial: dialBetween(originArtifact, audienceArtifact),
      linkId: audienceLink.linkId,
    });
    expect(closed.status).toBe("revoked");
    expect(borrowedStore.shapeForEdge(opened.edge.edge_id)).toBeUndefined();
    expect(borrowedStore.rowCount(borrowedShape.shapeId)).toBe(0);
    await expect(
      opened.pull({
        frame: "changes",
        edgeId: opened.edge.edge_id,
        since: { epoch: "stale", seq: 0 },
      })
    ).resolves.toMatchObject({ state: "not_found" });
    expect(contentItemCount(audience.vault)).toBe(2);
  });
});

async function reconcile(
  origin: ReturnType<typeof makeSide>,
  audience: ReturnType<typeof makeSide>,
  edgeId: string
) {
  const originArtifact = artifacts.find((artifact) => artifact.side === origin);
  const audienceArtifact = artifacts.find(
    (artifact) => artifact.side === audience && !artifact.closed
  );
  if (!originArtifact || !audienceArtifact)
    throw new Error("peer artifacts are not running");
  return reconcileRemoteEdge(
    origin.gatewayDb,
    readEdgeRow(origin.gatewayDb, edgeId)!,
    origin.vault,
    routeFrom(origin, audience),
    dialBetween(originArtifact, audienceArtifact)
  );
}
