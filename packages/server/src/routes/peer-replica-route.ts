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
  composeShareTail,
  ingestShareTail,
  purgeShareShape,
  readShareClosure,
  readShareGrant,
  readSubscription,
  recordSubscription,
  resolveGrantAudienceParties,
} from "@centraid/vault";
import type {
  Credential,
  Gateway as VaultGateway,
  ShareTailFrame,
  VaultDb,
} from "@centraid/vault";

import type { PeerIdentity } from "./peer-plane.js";
import { readJson, sendJson } from "./route-helpers.js";

export const PEER_REPLICA_CHANGES_PATH = "/centraid/_peer/replica/changes";
export const PEER_REPLICA_BLOB_PATH = "/centraid/_peer/replica/blob";
export const PEER_REPLICA_INTENTS_PATH = "/centraid/_peer/replica/intents";
export const PEER_REPLICA_TAIL_PATH = "/centraid/_peer/replica/tail";

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
  /** The origin executes a member's write as the single writer (#929 wave 3). */
  gatewayFor?: (vaultId: string) => VaultGateway | undefined;
  credentialFor?: (vaultId: string) => Credential | undefined;
  now?: () => string;
}

export type PeerReplicaPullOutcome =
  | {
      /** The predicate transport (#996, R10): what the three outputs did. */
      state: "applied";
      entered: number;
      updated: number;
      left: number;
      retained: number;
      cursor: { epoch: string; seq: number };
    }
  | { state: "unreachable"; detail: string };

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { state: "not_found" });
}

function nowOf(deps: PeerReplicaDeps): string {
  return (deps.now ?? ((): string => new Date().toISOString()))();
}

export interface Admission {
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
export function admitAtOrigin(
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

/**
 * ORIGIN door: THE THREE OUTPUTS since the audience's cursor (#996, R10).
 *
 * TWO THINGS THE ORIGIN CHECKS BEFORE IT TRUSTS A CURSOR. It is the audience's
 * claim about what it holds, and a claim is not an acknowledgement — so the
 * origin compares it against `share_subscription.cursor_seq`, ITS OWN record of
 * what it last served this audience. A cursor that does not match means the
 * previous pass was never applied (the audience crashed, the connection died),
 * and the answer is a RESEND of every member rather than a diff against a
 * membership the audience never received. That is the one thing a per-grant
 * member set cannot infer on its own, and `entered_seq` is what makes the
 * resend an upsert rather than a scrub.
 *
 * A grant this door cannot serve — today only a Locker item, whose sealed
 * columns must be re-sealed under the audience DEK inside one process —
 * answers `unsupported` and names the reason. It is never answered wrongly,
 * and it was never deliverable over a subscription: the old ingest had no
 * keys to re-seal with and threw. There is no second door to fall back to.
 */
export function handlePeerReplicaTail(
  res: ServerResponse,
  peer: PeerIdentity,
  params: URLSearchParams,
  deps: PeerReplicaDeps
): true {
  const admission = admitAtOrigin(peer, params, deps);
  if (!admission) return notFound(res);
  const grant = readShareGrant(admission.origin.vault, admission.grantId);
  if (!grant) return notFound(res);
  const claimed = Number(params.get("seq") ?? "-1");
  const epoch = params.get("epoch") ?? "";
  const served = readSubscription(
    admission.origin.vault,
    admission.grantId,
    admission.audienceVaultId
  );
  const acknowledged =
    served !== undefined &&
    served.cursor.epoch === epoch &&
    served.cursor.seq === claimed &&
    Number.isSafeInteger(claimed) &&
    claimed >= 0;
  const pass = composeShareTail({
    origin: admission.origin.vault,
    originVaultId: admission.originVaultId,
    audienceVaultId: admission.audienceVaultId,
    authorityId: admission.grantId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId,
    maxSizeBytes: grant.maxSizeBytes,
    ...(acknowledged ? { since: { epoch, seq: claimed } } : {}),
  });
  if (!pass)
    return sendJson(res, 200, {
      state: "unsupported",
      detail: "this grant's closure cannot be served as rows",
    });
  // Served, so recorded: the origin now believes this audience holds these
  // rows, and the next request's cursor is what confirms or refutes it.
  pass.settle();
  recordSubscription(admission.origin.vault, {
    authorityId: admission.grantId,
    audienceVaultId: admission.audienceVaultId,
    originVaultId: admission.originVaultId,
    subjectType: grant.subjectType,
    cursor: pass.frame.outputs.cursor,
    state: "subscribed",
    now: nowOf(deps),
  });
  return sendJson(res, 200, { state: "tail", frame: pass.frame });
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
  // MEMBERSHIP OF THE MANIFEST IS THE AUTHORIZATION, and the manifest is the
  // grant's own closure: a linked peer cannot name an arbitrary content
  // address and read the owner's library through the share.
  const grant = readShareGrant(admission.origin.vault, admission.grantId);
  if (!grant) return notFound(res);
  const claimed = readShareClosure(admission.origin.vault, {
    originVaultId: admission.originVaultId,
    itemType: grant.subjectType,
    itemIds: [grant.subjectId],
    crossOwner: true,
  }).blobs.some((blob) => blob.sha256 === sha256);
  if (!claimed) return notFound(res);
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
    const grantId = shareShapeGrantId(notice.shapeId);
    if (!grantId) return notFound(res);
    const purged = purgeShareShape(seat.vault, {
      authorityId: grantId,
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
  // Either transport is a delivery: `ingested` is the frame path's word and
  // `applied` is the predicate transport's (#996, R10). Only `unreachable` is
  // a failure, and only it answers 503.
  return sendJson(res, outcome.state === "unreachable" ? 503 : 200, outcome);
}

/** Apply a TAIL the seat pulled — the three outputs, as rows (#996, R10). */
export function ingestPulledTail(
  seat: VaultDb,
  frame: ShareTailFrame,
  input: { audienceVaultId: string; now: string }
): PeerReplicaPullOutcome {
  const applied = ingestShareTail(seat.vault, frame, {
    audienceVaultId: input.audienceVaultId,
    now: input.now,
  });
  return {
    state: "applied",
    entered: applied.entered,
    updated: applied.updated,
    left: applied.left,
    retained: applied.retained,
    cursor: applied.cursor,
  };
}
