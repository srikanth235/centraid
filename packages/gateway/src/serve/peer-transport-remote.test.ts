/*
 * Exit evidence for #726 P3 gap 1 — "no production peer dial". Every other
 * peer-plane test (`peer-link-ceremony.test.ts`, `peer-remote-give.test.ts`)
 * proves the PROTOCOL against an in-process double that calls the far side's
 * route handler directly. This file proves the TRANSPORT: two gateways that
 * reach each other ONLY through a real `centraid/gw-link/1` QUIC connection
 * — `startGatewayEndpoint` (accept, `@centraid/tunnel`) on one side,
 * `startPeerDial` (dial, `./peer-dial.js`, this package's production
 * implementation of `PeerRequest`/`PeerDial`) on the other — complete a link
 * ceremony, a remote give (with a derivative painted immediately), and a
 * ranged original pull. No `transportTo`-style handler call anywhere here.
 *
 * `relays: "disabled"` keeps this offline and fast (loopback UDP, no n0
 * network dependency), the same posture `peer-plane.test.ts` and
 * `tunnel.integration.test.ts` already use. Route rediscovery via a relay
 * hint (how a peer reconnects after this process's original dial ticket is
 * gone) is an n0-network concern proved in `packages/tunnel`, not repeated
 * here — this fixture keeps each side's live dial ticket on hand and hands
 * it to `endpointTicketFor` instead, so every request still crosses the
 * real transport; only HOW the ticket is obtained is test-simplified.
 */

import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import type { GatewayEndpointHandle } from "@centraid/tunnel";
import { startGatewayEndpoint } from "@centraid/tunnel";
import {
  blobUriFor,
  bootstrapVault,
  openVaultDb,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { reconcileRemoteEdge } from "../routes/edges-reconcile-remote.js";
import { readEdgeRow } from "../routes/edges-reconcile.js";
import { makePeerPlaneHandler } from "../routes/peer-plane.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import { judgeEdgeCrossing } from "./link-crossing.js";
import { drainPeerBlobPulls } from "./peer-blob-pull.js";
import { startPeerDial } from "./peer-dial.js";
import type { PeerDialHandle } from "./peer-dial.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import {
  encodeLinkTicket,
  parseLinkTicket,
  pushRouteAssertion,
  redeemLinkTicket,
} from "./peer-link-client.js";
import { isLinkApproved } from "./vault-link-row.js";
import { VaultLinksStore } from "./vault-links-store.js";

// Real iroh handshakes want more than vitest's 5s default under load.
vi.setConfig({ testTimeout: 30_000 });

const UPSTREAM_TOKEN = crypto.randomBytes(16).toString("hex");

interface Side {
  vaultId: string;
  seed: Buffer;
  publicKey: string;
  label: string;
  gatewayDb: GatewayDatabase;
  links: VaultLinksStore;
  proof: string;
  vault: VaultDb;
  ownerPartyId: string;
  ownerId: string;
  deviceId: string;
  upstream: http.Server;
  endpoint: GatewayEndpointHandle;
  dial: PeerDialHandle;
}

/** One real gateway: a loopback HTTP upstream hosting the peer plane, a real
 * iroh endpoint accepting `centraid/gw-link/1` into it, and a real dial
 * client sharing the endpoint's own persistent identity. */
async function makeSide(name: string): Promise<Side> {
  const root = tempDirSync(`centraid-peer-transport-${name}-`);
  const seed = crypto.randomBytes(32);
  const vaultId = `vlt_${name}`;
  const gatewayDb = GatewayDatabase.open(path.join(root, "gateway"));
  const vaultDir = path.join(root, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const vault = openVaultDb({ dir: vaultDir });
  const boot = bootstrapVault(vault, { ownerName: name, vaultId });
  const enrollment = EnrollmentStore.open(gatewayDb).enroll({
    endpointId: `device-${name}`,
    vaultIds: [vaultId],
    label: `${name} device`,
    ownerLabel: name,
  });
  const links = VaultLinksStore.open(gatewayDb);
  const proof = crypto.randomBytes(32).toString("hex");
  const publicKey = vaultIdentityPublicKey(seed).toString("base64");

  // `localRoute` closes over `endpoint` before it exists: the upstream
  // server (which needs `localRoute`) must start before `startGatewayEndpoint`
  // can be called (which needs the upstream's `baseUrl`) — a genuine cycle,
  // broken by mutating a `const` cell's property rather than reassigning a
  // `let` binding.
  const endpointCell: { current?: GatewayEndpointHandle } = {};
  const localRoute = (): { endpointId?: string; relayHints: string[] } => ({
    endpointId: endpointCell.current?.endpointId,
    relayHints: [],
  });
  const peerHandler = makePeerPlaneHandler({
    links,
    peerProof: proof,
    vaultPublicKey: (id) => (id === vaultId ? publicKey : undefined),
    localRoute,
    localLabel: () => name,
    vaultFor: (id) => (id === vaultId ? vault : undefined),
    gatewayDatabase: gatewayDb,
  });
  const upstream = http.createServer((req, res) => {
    if ((req.headers.authorization ?? "") !== `Bearer ${UPSTREAM_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    void peerHandler(req, res);
  });
  const baseUrl = await new Promise<string>((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      const { port } = upstream.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  const secretKey = seed; // any 32 bytes works as an iroh endpoint secret
  endpointCell.current = await startGatewayEndpoint({
    secretKey,
    upstream: () => ({ baseUrl, token: UPSTREAM_TOKEN }),
    authorize: () => false,
    pair: () => ({ ok: false, error: "not_supported" }),
    authorizePeer: (endpointId) =>
      links.isLinked(endpointId) ||
      links.hasAnyLink() ||
      links.tickets.hasPending(),
    peerRequestHeaders: (endpointId) => {
      const link = links.peerForEndpoint(endpointId);
      return {
        "x-centraid-peer-endpoint": endpointId,
        "x-centraid-peer-proof": proof,
        ...(link ? { "x-centraid-peer-vault": link.peerVaultId } : {}),
      };
    },
    relays: "disabled",
  });
  const dial = startPeerDial({ secretKey, relays: "disabled" });

  return {
    vaultId,
    seed,
    publicKey,
    label: name,
    gatewayDb,
    links,
    proof,
    vault,
    ownerPartyId: boot.ownerPartyId,
    ownerId: enrollment.ownerId,
    deviceId: enrollment.endpointId,
    upstream,
    endpoint: endpointCell.current!,
    dial,
  };
}

async function closeSide(side: Side): Promise<void> {
  await side.dial.close();
  await side.endpoint.close();
  await new Promise<void>((resolve) => {
    side.upstream.close(() => resolve());
  });
}

/** A `PeerDial` whose `request` is the REAL transport, but whose
 * `endpointTicketFor` returns the CALLEE's live dial ticket rather than
 * reconstructing one from a bare EndpointId (which needs n0 relay discovery
 * to resolve with no direct addresses — a `packages/tunnel` concern, proved
 * there, not re-exercised here). Every byte still crosses the real QUIC
 * connection this test's own `startPeerDial` opens. */
function dialFrom(caller: Side, callee: Side): PeerDial {
  return {
    request: caller.dial.request,
    endpointTicketFor: () => callee.endpoint.ticket(),
  };
}

function showTicket(side: Side): string {
  const ticket = side.links.tickets.mint(side.vaultId, side.publicKey);
  return encodeLinkTicket({
    v: 1,
    kind: "centraid-link",
    vaultId: side.vaultId,
    vaultPublicKey: side.publicKey,
    endpointTicket: side.endpoint.ticket(),
    ticketId: ticket.ticketId,
    secret: ticket.secret,
  });
}

function routeFrom(from: Side, to: Side) {
  const crossing = judgeEdgeCrossing(
    {
      links: from.links,
      ownerOf: (id) => (id === from.vaultId ? from.ownerId : undefined),
    },
    from.vaultId,
    to.vaultId
  );
  if (crossing.state !== "linked" || !crossing.route) {
    throw new Error(`expected a routed link from ${from.label} to ${to.label}`);
  }
  return crossing.route;
}

function seedPhoto(side: Side, label: string) {
  const bytes = Buffer.from(`original-${label}-${crypto.randomUUID()}`);
  const thumbBytes = Buffer.from(`thumb-${label}`);
  const original = side.vault.blobs.ingestSync(bytes);
  const thumb = side.vault.blobs.ingestSync(thumbBytes);
  const now = new Date().toISOString();
  const contentId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(original.sha256),
      original.sha256,
      original.byteSize,
      `Photo ${label}`,
      side.ownerPartyId,
      now
    );
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
       VALUES (?, ?, 'thumb', ?, 'image/jpeg', ?, NULL, ?)`
    )
    .run(crypto.randomUUID(), contentId, thumb.sha256, thumb.byteSize, now);
  const assetId = crypto.randomUUID();
  side.vault.vault
    .prepare(
      `INSERT INTO media_media_asset
         (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id,
          place_id, camera_device_id, width, height, duration_s, exif_json,
          favorite, archived_at, deleted_at, purge_at)
       VALUES (?, ?, 'photo', ?, NULL, NULL, NULL, NULL, 800, 600, NULL, NULL, 1, NULL, NULL, NULL)`
    )
    .run(assetId, contentId, now);
  return { assetId, sha256: original.sha256, thumbSha: thumb.sha256, bytes };
}

function insertEdgeRow(
  origin: Side,
  input: { edgeId: string; audienceVaultId: string; itemIds: string[] }
) {
  const now = new Date().toISOString();
  origin.gatewayDb.run(
    `INSERT INTO share_edges
       (edge_id, created_by_device, owner_id, kind, mode, item_type,
        scope_json, origin_vault_id, audience_vault_id, verbs,
        target_state, source_state, status, created_at, updated_at)
     VALUES (?, ?, ?, 'add', 'snapshot', 'media.media_asset', ?, ?, ?, 'read',
             'queued', 'not-needed', 'queued', ?, ?)`,
    input.edgeId,
    origin.deviceId,
    origin.ownerId,
    JSON.stringify(input.itemIds),
    origin.vaultId,
    input.audienceVaultId,
    now,
    now
  );
  return readEdgeRow(origin.gatewayDb, input.edgeId)!;
}

describe("peer transport over real iroh (#726 P3 gap 1)", () => {
  let origin: Side;
  let audience: Side;

  beforeAll(async () => {
    origin = await makeSide("real-origin");
    audience = await makeSide("real-audience");
  }, 30_000);

  afterAll(async () => {
    await closeSide(origin);
    await closeSide(audience);
  });

  test("a link ceremony completes over a real peer-ALPN connection", async () => {
    const payload = parseLinkTicket(showTicket(origin))!;
    const result = await redeemLinkTicket({
      ticket: payload,
      links: audience.links,
      request: audience.dial.request,
      localVault: { vaultId: audience.vaultId, publicKey: audience.publicKey },
      localRoute: { endpointId: audience.endpoint.endpointId, relayHints: [] },
      localLabel: audience.label,
    });
    expect(result.state).toBe("linked");
    // Mutual: BOTH sides hold the other's vault id, key, and route, approved.
    const audienceSide = audience.links.findPair(
      origin.vaultId,
      audience.vaultId
    );
    const originSide = origin.links.findPair(origin.vaultId, audience.vaultId);
    expect(audienceSide && isLinkApproved(audienceSide)).toBe(true);
    expect(originSide && isLinkApproved(originSide)).toBe(true);
  }, 30_000);

  test("a signed route assertion verifies over the real transport", async () => {
    const outcomes = await pushRouteAssertion({
      links: audience.links,
      request: audience.dial.request,
      signAsVault: (vaultId, bytes) =>
        vaultId === audience.vaultId
          ? signWithVaultIdentity(audience.seed, bytes)
          : undefined,
      route: {
        vaultId: audience.vaultId,
        endpointId: audience.endpoint.endpointId,
        relayHints: [],
      },
      endpointTicketFor: () => origin.endpoint.ticket(),
    });
    expect(outcomes).toStrictEqual([
      { peerVaultId: origin.vaultId, state: "accepted" },
    ]);
  }, 30_000);

  test("a remote give paints the derivative immediately and pulls the ranged original over the real transport", async () => {
    const photo = seedPhoto(origin, "real-transport");
    const row = insertEdgeRow(origin, {
      edgeId: "edge-real-transport",
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
    expect(audience.vault.blobs.local.hasSync(photo.thumbSha)).toBe(true);
    // The original crossed as a manifest entry, not yet as bytes.
    expect(audience.vault.blobs.local.hasSync(photo.sha256)).toBe(false);
    const pendingBefore = audience.gatewayDb.db
      .prepare("SELECT sha256 FROM peer_blob_pulls")
      .all() as Array<{ sha256: string }>;
    expect(pendingBefore.map((p) => p.sha256)).toStrictEqual([photo.sha256]);

    const drained = await drainPeerBlobPulls({
      db: audience.gatewayDb,
      links: audience.links,
      vaultFor: (id) => (id === audience.vaultId ? audience.vault : undefined),
      dial: dialFrom(audience, origin),
      chunkBytes: 8,
    });
    expect(drained.done).toStrictEqual([photo.sha256]);
    expect(audience.vault.blobs.local.hasSync(photo.sha256)).toBe(true);
    expect(
      audience.vault.blobs.local.getSync(photo.sha256)?.equals(photo.bytes)
    ).toBe(true);
    expect(
      audience.gatewayDb.db.prepare("SELECT * FROM peer_blob_pulls").all()
    ).toHaveLength(0);
  }, 30_000);
});
