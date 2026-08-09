// Shared fixture vocabulary for the "two gateways, one process" peer-give
// suites (#726 P3): `peer-remote-give.test.ts` (decisions 7/9) and
// `peer-refusal-relay.test.ts` (decision 9's refusal-reaches-origin gap).
// Both stand up the SAME shape of fixture — a gateway.db + vault pair linked
// over the in-process `transportTo` double `peer-link-ceremony.test.ts`
// establishes — so splitting the suites by concern should not mean
// copy-pasting this setup into each file.
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { PEER_ENDPOINT_HEADER, PEER_PROOF_HEADER } from "@centraid/tunnel";
import {
  blobUriFor,
  bootstrapVault,
  createGateway,
  openVaultDb,
  registerTaskCommands,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
} from "@centraid/vault";
import type { Gateway as VaultGateway, VaultDb } from "@centraid/vault";

import { readEdgeRow } from "../routes/edges-reconcile.js";
import type { EdgeRow } from "../routes/edges-reconcile.js";
import { makePeerPlaneHandler } from "../routes/peer-plane.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import type { BorrowedDeps } from "./lend-audience.js";
import { judgeEdgeCrossing } from "./link-crossing.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import {
  encodeLinkTicket,
  parseLinkTicket,
  redeemLinkTicket,
} from "./peer-link-client.js";
import type { PeerRequest } from "./peer-link-client.js";
import type { LinkRoute } from "./vault-link-row.js";
import { VaultLinksStore } from "./vault-links-store.js";

export interface Side {
  vaultId: string;
  /** The vault's REAL P1 identity key — what a lease signature verifies against. */
  publicKey: string;
  /** `VaultRegistry.signAsVault`, for a fixture with no registry. */
  signAsVault: (vaultId: string, bytes: Buffer) => Buffer | undefined;
  endpointId: string;
  label: string;
  gatewayDb: GatewayDatabase;
  links: VaultLinksStore;
  proof: string;
  vault: VaultDb;
  ownerPartyId: string;
  ownerId: string;
  deviceId: string;
  /** The vault's own `Gateway`, with the task commands registered — what a
   *  write-capable live edge invokes through (#726 P5). */
  gateway: VaultGateway;
  /** The founding owner-device credential (#726 P5) — what confirms a
   *  parked invocation. */
  ownerCredential: { kind: "device"; deviceId: string; deviceKey: string };
}

/** The gateway-level identity two co-hosted vaults SHARE: one `gatewayDb`
 *  (so one `vault_links` table), one endpoint id, one peer proof — an iroh
 *  endpoint is per-GATEWAY, not per-vault (D1 invariant 2), so this is the
 *  actual production shape of "two people's vaults hosted on one machine". */
export interface HostFixture {
  gatewayDb: GatewayDatabase;
  links: VaultLinksStore;
  endpointId: string;
  proof: string;
}

function makeHost(name: string): HostFixture {
  const root = tempDirSync(`centraid-remote-give-${name}-host-`);
  const gatewayDb = GatewayDatabase.open(path.join(root, "gateway"));
  return {
    gatewayDb,
    links: VaultLinksStore.open(gatewayDb),
    endpointId: `ep-${name}`,
    proof: crypto.randomBytes(32).toString("hex"),
  };
}

/**
 * A vault fixture. `host` is optional and lets two (or more) `makeSide` calls
 * share ONE gateway (see `makeCoHostedSides`) instead of each minting its own
 * — everything else (the vault dir, the owner, the device enrollment) stays
 * per-vault, matching how a real household gateway hosts several owners.
 */
export function makeSide(name: string, host?: HostFixture): Side {
  const root = tempDirSync(`centraid-remote-give-${name}-`);
  const vaultId = `vlt_${name}`;
  const h = host ?? makeHost(name);
  const vaultDir = path.join(root, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const vault = openVaultDb({ dir: vaultDir });
  const boot = bootstrapVault(vault, { ownerName: name, vaultId });
  const enrollment = EnrollmentStore.open(h.gatewayDb).enroll({
    endpointId: `device-${name}`,
    vaultIds: [vaultId],
    label: `${name} device`,
    ownerLabel: name,
  });
  const gateway = createGateway(vault);
  registerTaskCommands(gateway);
  return {
    vaultId,
    publicKey: vaultIdentityPublicKey(vault.identitySeed).toString("base64"),
    signAsVault: (id, bytes) =>
      id === vaultId
        ? signWithVaultIdentity(vault.identitySeed, bytes)
        : undefined,
    endpointId: h.endpointId,
    label: name,
    gatewayDb: h.gatewayDb,
    links: h.links,
    proof: h.proof,
    vault,
    ownerPartyId: boot.ownerPartyId,
    ownerId: enrollment.ownerId,
    deviceId: enrollment.endpointId,
    gateway,
    ownerCredential: {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    },
  };
}

/**
 * Two vaults co-hosted on ONE gateway (audit #726 finding 2's exact shape):
 * same `gatewayDb`/`links`/`endpointId`/`proof`, different owners. Whoever
 * links to either of these sees the SAME endpoint for both — the ambiguity
 * `linkForPeer`/`peer.linkFor` exist to resolve.
 */
export function makeCoHostedSides(
  hostName: string,
  nameA: string,
  nameB: string
): [Side, Side] {
  const host = makeHost(hostName);
  return [makeSide(nameA, host), makeSide(nameB, host)];
}

/** Wrap an already-built handler as the `PeerRequest` the relay would
 *  deliver, over the given endpoint/proof — shared by `transportTo` (one
 *  vault) and `transportToHost` (several co-hosted vaults answering as one
 *  gateway). */
function wireHandler(
  handler: ReturnType<typeof makePeerPlaneHandler>,
  callerEndpointId: string,
  proof: string
): PeerRequest {
  return async (input) => {
    let status = 0;
    let body = "";
    const req = Readable.from([
      Buffer.from(JSON.stringify(input.body ?? {})),
    ]) as IncomingMessage;
    req.method = input.method;
    req.url = input.target;
    req.headers = {
      [PEER_ENDPOINT_HEADER]: callerEndpointId,
      [PEER_PROOF_HEADER]: proof,
    };
    const res = {
      setHeader: () => undefined,
      end(value?: string | Buffer) {
        if (value) body += value.toString();
      },
      get statusCode() {
        return status;
      },
      set statusCode(value: number) {
        status = value;
      },
    } as unknown as ServerResponse;
    await handler(req, res);
    return { status, json: body ? (JSON.parse(body) as unknown) : undefined };
  };
}

/** A peer request that lands on `side`'s real handler, as the relay would deliver it. */
export function transportTo(
  side: Side,
  callerEndpointId: string,
  /** The live-edge half (#726 P4); omitted, every `lend/*` frame is not_found. */
  borrowed?: BorrowedDeps
): PeerRequest {
  const handler = makePeerPlaneHandler({
    links: side.links,
    peerProof: side.proof,
    vaultPublicKey: (vaultId) =>
      vaultId === side.vaultId ? side.publicKey : undefined,
    localRoute: () => ({ endpointId: side.endpointId, relayHints: [] }),
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
  return wireHandler(handler, callerEndpointId, side.proof);
}

/**
 * Like `transportTo`, but for TWO OR MORE vaults co-hosted on one gateway —
 * `makeCoHostedSides`' shape. `vaultFor`/`vaultPublicKey`/`gatewayFor` widen
 * to recognize ANY of `sides` as local, matching how one real gateway
 * process serves every vault it hosts; `links`/`gatewayDb`/`endpointId` are
 * already shared (that IS what "co-hosted" means here) so any one side names
 * them.
 */
export function transportToHost(
  sides: readonly [Side, ...Side[]],
  callerEndpointId: string,
  borrowed?: BorrowedDeps
): PeerRequest {
  const host = sides[0];
  const sideFor = (vaultId: string): Side | undefined =>
    sides.find((candidate) => candidate.vaultId === vaultId);
  const handler = makePeerPlaneHandler({
    links: host.links,
    peerProof: host.proof,
    vaultPublicKey: (vaultId) => sideFor(vaultId)?.publicKey,
    localRoute: () => ({ endpointId: host.endpointId, relayHints: [] }),
    localLabel: () => host.label,
    vaultFor: (vaultId) => sideFor(vaultId)?.vault,
    gatewayDatabase: host.gatewayDb,
    lend: {
      signAsVault: (vaultId, bytes) =>
        sideFor(vaultId)?.signAsVault(vaultId, bytes),
      ...(borrowed ? { borrowed } : {}),
      gatewayFor: (vaultId) => sideFor(vaultId)?.gateway,
    },
  });
  return wireHandler(handler, callerEndpointId, host.proof);
}

export function dialFrom(
  caller: Side,
  callee: Side,
  borrowed?: BorrowedDeps
): PeerDial {
  return {
    request: transportTo(callee, caller.endpointId, borrowed),
    endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
  };
}

/** `dialFrom`'s co-hosted counterpart: dial INTO `sides` (several vaults
 *  answering as one gateway) FROM `caller`. */
export function dialFromHost(
  caller: Side,
  sides: readonly [Side, ...Side[]],
  borrowed?: BorrowedDeps
): PeerDial {
  return {
    request: transportToHost(sides, caller.endpointId, borrowed),
    endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
  };
}

function showTicket(side: Side): string {
  const ticket = side.links.tickets.mint(side.vaultId, side.publicKey);
  return encodeLinkTicket({
    v: 1,
    kind: "centraid-link",
    vaultId: side.vaultId,
    vaultPublicKey: side.publicKey,
    endpointTicket: `ticket-for-${side.endpointId}`,
    ticketId: ticket.ticketId,
    secret: ticket.secret,
  });
}

export async function link(shower: Side, scanner: Side): Promise<void> {
  const payload = parseLinkTicket(showTicket(shower))!;
  const result = await redeemLinkTicket({
    ticket: payload,
    links: scanner.links,
    request: transportTo(shower, scanner.endpointId),
    localVault: { vaultId: scanner.vaultId, publicKey: scanner.publicKey },
    localRoute: { endpointId: scanner.endpointId, relayHints: [] },
    localLabel: scanner.label,
  });
  if (result.state !== "linked") {
    throw new Error(`expected a link, got ${result.state}`);
  }
}

export function routeFrom(from: Side, to: Side): LinkRoute {
  const crossing = judgeEdgeCrossing(
    {
      links: from.links,
      ownerOf: (vaultId) =>
        vaultId === from.vaultId ? from.ownerId : undefined,
    },
    from.vaultId,
    to.vaultId
  );
  if (crossing.state !== "linked" || !crossing.route)
    throw new Error(`expected a routed link from ${from.label} to ${to.label}`);
  return crossing.route;
}

export interface SeededPhoto {
  assetId: string;
  sha256: string;
  thumbSha: string;
  bytes: Buffer;
  thumbBytes: Buffer;
}

export function seedPhoto(side: Side, label: string): SeededPhoto {
  const bytes = Buffer.from(`original-bytes-${label}-${crypto.randomUUID()}`);
  const thumbBytes = Buffer.from(`thumb-bytes-${label}`);
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
  return {
    assetId,
    sha256: original.sha256,
    thumbSha: thumb.sha256,
    bytes,
    thumbBytes,
  };
}

export function insertEdgeRow(
  origin: Side,
  input: { edgeId: string; audienceVaultId: string; itemIds: string[] }
): EdgeRow {
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

export function derivativeRows(vault: VaultDb): Array<{ sha256: string }> {
  return vault.vault
    .prepare("SELECT sha256 FROM core_content_derivative")
    .all() as Array<{ sha256: string }>;
}

export function contentItemCount(vault: VaultDb): number {
  return (
    vault.vault
      .prepare("SELECT count(*) AS n FROM core_content_item")
      .get() as {
      n: number;
    }
  ).n;
}
