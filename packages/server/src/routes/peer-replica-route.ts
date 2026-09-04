/*
 * THE SUBSCRIPTION DOORS on the peer plane (#929).
 *
 * ADMISSION is the link PAIR and nothing else: the forwarder's peer proof
 * already stands (peer-plane.ts), and `linkForPair` verifies that exactly this
 * (origin, audience) couple is linked over the endpoint that dialled. No
 * subscriber key is minted — one would be a second thing to revoke beside the
 * link, and a link that has ended must end the subscription.
 *
 * A LINK NEVER ADMITS A DEVICE-TIER ROUTE. These paths live under the peer
 * plane prefix, which `isPeerPlaneTarget` confines and `route-security.ts`
 * classifies; the device-tier `/centraid/_vault/replica` surface is unreachable
 * from here, and `authz-deny-matrix.test.ts` holds that.
 *
 * Refusals are STATES, never exceptions, and an unknown link, an unknown shape
 * and a revoked grant answer alike — topology hiding, same as the rest of the
 * plane.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  judgeSubscriberCredential,
  shareShapeGrantId,
} from "@centraid/core/protocol";
import {
  channelForParty,
  composeShareShape,
  ingestShareShape,
  purgeShareShape,
  readShareGrant,
  resolveGrantAudienceParties,
} from "@centraid/vault";
import type { ShareShapeFrame, VaultDb } from "@centraid/vault";

import type { PeerIdentity } from "./peer-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_REPLICA_BOOTSTRAP_PATH = "/centraid/_peer/replica/bootstrap";
export const PEER_REPLICA_CHANGES_PATH = "/centraid/_peer/replica/changes";
export const PEER_REPLICA_BLOB_PATH = "/centraid/_peer/replica/blob";
export const PEER_REPLICA_INTENTS_PATH = "/centraid/_peer/replica/intents";

/** One chunk per request. The manifest names the total, so the puller loops. */
export const PEER_REPLICA_BLOB_CHUNK_BYTES = 1024 * 1024;

export interface PeerReplicaDeps {
  /** `undefined` for a vault this host does not mount. */
  vaultFor: (vaultId: string) => VaultDb | undefined;
  /** The audience seat's way back to an origin, for the pull half. */
  pullShape?: (input: {
    originVaultId: string;
    audienceVaultId: string;
    shapeId: string;
    seat: VaultDb;
  }) => Promise<PeerReplicaPullOutcome>;
  now?: () => string;
}

export type PeerReplicaPullOutcome =
  | {
      state: "ingested";
      apply: "bootstrap" | "reproject" | "fields";
      fieldUpdates: number;
      cursor: { epoch: string; seq: number };
    }
  | { state: "unreachable"; detail: string };

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

function nowOf(deps: PeerReplicaDeps): string {
  return (deps.now ?? ((): string => new Date().toISOString()))();
}

interface Admission {
  origin: VaultDb;
  originVaultId: string;
  audienceVaultId: string;
  shapeId: string;
  grantId: string;
}

/**
 * The origin's admission: the link pair stands, this host mounts the origin
 * vault, the shape names a LIVE grant, and the audience vault is one this grant
 * actually reaches. Every failure is `not_found`.
 */
function admitAtOrigin(
  peer: PeerIdentity,
  params: URLSearchParams,
  deps: PeerReplicaDeps
): Admission | undefined {
  const verdict = judgeSubscriberCredential(params);
  if (verdict.state !== "ok") return undefined;
  const { originVaultId, audienceVaultId, shapeId } = verdict.credential;
  if (!peer.linkForPair(originVaultId, audienceVaultId)) return undefined;
  const origin = deps.vaultFor(originVaultId);
  if (!origin) return undefined;
  const grantId = shareShapeGrantId(shapeId);
  if (!grantId) return undefined;
  const grant = readShareGrant(origin.vault, grantId);
  if (!grant || grant.revokedAt !== null) return undefined;
  // The grant must actually reach THIS audience vault: a link alone is not a
  // share, and a circle grant reaches only the parties on its live roster.
  const audience = resolveGrantAudienceParties(origin.vault, grant);
  const reaches = audience.parties.some(
    (partyId) =>
      channelForParty(origin.vault, partyId)?.vaultId === audienceVaultId
  );
  if (!reaches) return undefined;
  return { origin, originVaultId, audienceVaultId, shapeId, grantId };
}

function frameFor(admission: Admission): ShareShapeFrame {
  const grant = readShareGrant(admission.origin.vault, admission.grantId);
  if (!grant) throw new Error(`share grant ${admission.grantId} vanished`);
  return composeShareShape({
    origin: admission.origin,
    originVaultId: admission.originVaultId,
    audienceVaultId: admission.audienceVaultId,
    shapeId: admission.shapeId,
    grantId: admission.grantId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    maxSizeBytes: grant.maxSizeBytes,
  });
}

/** ORIGIN door: the whole grant-keyed shape, composed on demand. */
export function handlePeerReplicaBootstrap(
  res: ServerResponse,
  peer: PeerIdentity,
  params: URLSearchParams,
  deps: PeerReplicaDeps
): true {
  const admission = admitAtOrigin(peer, params, deps);
  if (!admission) return notFound(res);
  return sendJson(res, 200, { state: "shape", frame: frameFor(admission) });
}

/**
 * ORIGIN door: bytes for a sha THIS SHAPE claims. Membership of the manifest is
 * the authorization — a linked peer cannot name an arbitrary content address
 * and read the owner's library through the share.
 */
export function handlePeerReplicaBlob(
  res: ServerResponse,
  peer: PeerIdentity,
  params: URLSearchParams,
  deps: PeerReplicaDeps
): true {
  const admission = admitAtOrigin(peer, params, deps);
  if (!admission) return notFound(res);
  const sha256 = params.get("sha256") ?? "";
  const offset = Number(params.get("offset") ?? "0");
  if (!sha256 || !Number.isSafeInteger(offset) || offset < 0)
    return sendJson(res, 400, { state: "bad_request" });
  const frame = frameFor(admission);
  const entry = frame.closure.blobs.find((blob) => blob.sha256 === sha256);
  if (!entry) return notFound(res);
  const bytes = admission.origin.blobs.local.getSync(sha256);
  if (!bytes) return notFound(res);
  const chunk = bytes.subarray(offset, offset + PEER_REPLICA_BLOB_CHUNK_BYTES);
  return sendJson(res, 200, {
    state: "chunk",
    sha256,
    offset,
    total: bytes.byteLength,
    base64: chunk.toString("base64"),
  });
}

interface ChangeNotice {
  shapeId: string;
  originVaultId: string;
  audienceVaultId: string;
  revoked: boolean;
}

function readNotice(body: Record<string, unknown>): ChangeNotice | undefined {
  const read = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const shapeId = read("shapeId");
  const originVaultId = read("originVaultId");
  const audienceVaultId = read("audienceVaultId");
  if (!shapeId || !originVaultId || !audienceVaultId) return undefined;
  if (!shareShapeGrantId(shapeId)) return undefined;
  return {
    shapeId,
    originVaultId,
    audienceVaultId,
    revoked: body.revoked === true,
  };
}

/**
 * AUDIENCE door: "this shape moved — pull it", or "it is revoked — drop it".
 *
 * The notice carries NO ROWS. The seat fetches the shape from the origin itself
 * over the same link, so what lands in this vault is what this vault asked for;
 * a notice that could carry rows would let a linked peer write into an audience
 * vault by announcing.
 */
export async function handlePeerReplicaChanges(
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerIdentity,
  deps: PeerReplicaDeps
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { state: "bad_request" });
  }
  const notice = readNotice(body);
  if (!notice) return sendJson(res, 400, { state: "bad_request" });
  // The pair is read from the SEAT's side: this vault is the audience.
  if (!peer.linkForPair(notice.audienceVaultId, notice.originVaultId))
    return notFound(res);
  const seat = deps.vaultFor(notice.audienceVaultId);
  if (!seat) return notFound(res);
  if (notice.revoked) {
    const purged = purgeShareShape(seat.vault, {
      shapeId: notice.shapeId,
      audienceVaultId: notice.audienceVaultId,
      now: nowOf(deps),
    });
    return sendJson(res, 200, {
      state: "removed",
      removed: purged.removed,
      retained: purged.retained,
    });
  }
  if (!deps.pullShape) return notFound(res);
  const outcome = await deps.pullShape({
    originVaultId: notice.originVaultId,
    audienceVaultId: notice.audienceVaultId,
    shapeId: notice.shapeId,
    seat,
  });
  return sendJson(res, outcome.state === "ingested" ? 200 : 503, outcome);
}

/** Apply a frame the seat pulled. Kept here so the pull half and the loopback
 *  half agree about what "ingest" means on this seat. */
export function ingestPulledShape(
  seat: VaultDb,
  frame: ShareShapeFrame,
  input: { audienceVaultId: string; now: string }
): PeerReplicaPullOutcome {
  const result = ingestShareShape(seat.vault, frame, {
    audienceVaultId: input.audienceVaultId,
    now: input.now,
  });
  return {
    state: "ingested",
    apply: result.apply,
    fieldUpdates: result.fieldUpdates,
    cursor: result.cursor,
  };
}
