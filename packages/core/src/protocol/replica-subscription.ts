/*
 * A SHARE IS A REPLICA SUBSCRIPTION (#929). The audience vault subscribes to a
 * grant-keyed replica shape served by the origin vault over the PEER plane —
 * the same wire the owner's own phone replicates over, admitted differently.
 *
 * ADMISSION is the whole of the difference. A device is admitted by its
 * enrollment; a subscriber is admitted by the forwarder's peer proof plus the
 * link PAIR (`PeerIdentity.linkForPair`) naming exactly this (origin, audience)
 * couple. There is no subscriber key: minting one would be a second thing to
 * revoke beside the link, and a link that has ended must end the subscription.
 *
 * EVERYTHING AFTER ADMISSION IS UNCHANGED. The bootstrap header, the change
 * batch, the cursor, `rowVersion`, `commitId` and the intent outcome are the
 * device-tier contract verbatim — `REPLICA_POST_ADMISSION_CONTRACT` names the
 * fields, and the contract test refuses a second vocabulary for them here.
 */

/** Mirrors `@centraid/tunnel`'s `PEER_PLANE_PREFIX`; core carries no deps, so
 *  `peer-plane.test.ts` in the server asserts the two agree byte for byte. */
const PEER_PLANE_PREFIX = "/centraid/_peer/";

const REPLICA_PREFIX = `${PEER_PLANE_PREFIX}replica/` as const;

/** The audience's first pull: header, shape catalog, rows, cursor. */
export const PEER_REPLICA_BOOTSTRAP_PATH =
  `${REPLICA_PREFIX}bootstrap` as const;

/** Incremental pull from a cursor. Same batch the device tier receives. */
export const PEER_REPLICA_CHANGES_PATH = `${REPLICA_PREFIX}changes` as const;

/** Ranged byte pull for a sha the subscribed shape's rows claim. */
export const PEER_REPLICA_BLOB_PATH = `${REPLICA_PREFIX}blob` as const;

/** A member's signed write, executed by the origin as single writer (#929 w3). */
export const PEER_REPLICA_INTENTS_PATH = `${REPLICA_PREFIX}intents` as const;

export const PEER_REPLICA_PATHS: readonly string[] = Object.freeze([
  PEER_REPLICA_BOOTSTRAP_PATH,
  PEER_REPLICA_CHANGES_PATH,
  PEER_REPLICA_BLOB_PATH,
  PEER_REPLICA_INTENTS_PATH,
]);

/**
 * Shape ids are grant-keyed on this plane and app-keyed on the device plane.
 * The sigil is what keeps the two namespaces from ever colliding: an app id is
 * an `access_app.name`, and `buildReplicaShapes` refuses a grantee whose name
 * carries it (`assertShapeNamespaceFree`), so `@share:` can only ever have been
 * minted here.
 */
export const SHARE_SHAPE_SIGIL = "@share:";

export function shareShapeId(grantId: string): string {
  if (grantId.length === 0 || grantId.includes("/") || grantId.includes("?"))
    throw new RangeError(`a grant id cannot key a replica shape: ${grantId}`);
  return `${SHARE_SHAPE_SIGIL}${grantId}`;
}

/** The grant this shape is keyed by, or `undefined` for an app-keyed shape. */
export function shareShapeGrantId(shapeId: string): string | undefined {
  if (!shapeId.startsWith(SHARE_SHAPE_SIGIL)) return undefined;
  const grantId = shapeId.slice(SHARE_SHAPE_SIGIL.length);
  return grantId.length > 0 ? grantId : undefined;
}

/** True for a shape id no app plane may serve, and no device may ask for. */
export function isShareShapeId(shapeId: string): boolean {
  return shareShapeGrantId(shapeId) !== undefined;
}

/** Refuses a name that would let an app-keyed shape wear the share sigil. */
export function assertShapeNamespaceFree(appId: string): void {
  if (appId.includes(SHARE_SHAPE_SIGIL))
    throw new RangeError(
      `app id ${appId} would collide with the share shape namespace`
    );
}

/**
 * WHO IS PULLING, as the request states it. Proof is the peer plane's: the
 * handler re-derives the link pair and refuses when it does not stand, so
 * nothing here is trusted before that. It carries no secret on purpose — a
 * credential a relay could copy would outlive the link that authorized it.
 */
export interface ReplicaSubscriberCredential {
  /** The vault whose grant is being read. */
  originVaultId: string;
  /** The vault reading it — the audience of the share. */
  audienceVaultId: string;
  /** Which grant's shape. */
  shapeId: string;
}

export type SubscriberCredentialVerdict =
  | { state: "ok"; credential: ReplicaSubscriberCredential }
  | { state: "bad_request"; detail: string };

function readParam(
  params: { get: (name: string) => string | null },
  name: string
): string | undefined {
  const value = params.get(name);
  return value !== null && value.length > 0 ? value : undefined;
}

/**
 * Total: every input maps to a state, so a malformed subscriber request is a
 * refusal the peer plane can render, never a thrown error (the C1 shape).
 */
export function judgeSubscriberCredential(params: {
  get: (name: string) => string | null;
}): SubscriberCredentialVerdict {
  const originVaultId = readParam(params, "originVaultId");
  const audienceVaultId = readParam(params, "audienceVaultId");
  const shapeId = readParam(params, "shapeId");
  if (!originVaultId || !audienceVaultId || !shapeId)
    return {
      state: "bad_request",
      detail:
        "a subscriber names its origin vault, its audience vault and one shape",
    };
  if (originVaultId === audienceVaultId)
    return {
      state: "bad_request",
      detail: "a vault does not subscribe to itself",
    };
  if (!isShareShapeId(shapeId))
    return {
      state: "bad_request",
      detail: `${shapeId} is not a grant-keyed shape id`,
    };
  return {
    state: "ok",
    credential: { originVaultId, audienceVaultId, shapeId },
  };
}

/** The query string a subscriber sends. One builder, so the two ends agree. */
export function subscriberQuery(
  credential: ReplicaSubscriberCredential
): string {
  return new URLSearchParams({
    originVaultId: credential.originVaultId,
    audienceVaultId: credential.audienceVaultId,
    shapeId: credential.shapeId,
  }).toString();
}

/**
 * The fields a subscription MUST NOT respell. Every name here is the device
 * tier's (`packages/client/src/replica/types.ts`); a subscriber that received
 * a differently-named cursor or row version would be a second replica dialect,
 * which is the thing this issue exists to delete.
 */
export const REPLICA_POST_ADMISSION_CONTRACT: readonly string[] = Object.freeze(
  [
    "protocolVersion",
    "schemaEpoch",
    "vaultId",
    "shapes",
    "shapeId",
    "entity",
    "rowId",
    "values",
    "rowVersion",
    "commitId",
    "op",
    "cursor",
    "from",
    "to",
    "changes",
    "hasMore",
    "outcomes",
    "oversizedFields",
  ]
);
