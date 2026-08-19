/*
 * The grant plane's store (issue #825). `share_grant` holds MEANING — this
 * audience may see/edit this subject — and `share_fulfillment` holds
 * MECHANISM, one row per audience vault. Nothing here delivers anything: a
 * fulfillment row is a record of where delivery stands, written by whatever
 * strategy is doing the delivering (closure reprojection for view, the
 * commons rail for edit).
 *
 * Two rules live here, at the table they constrain:
 *
 *   - The partial unique index allows ONE live grant per audience x subject.
 *     `createShareGrant` therefore reports the standing grant instead of
 *     inserting beside it or throwing: a repeated share gesture is not an
 *     error, and silently re-writing the capability of an existing grant
 *     would change what the owner decided without them saying so.
 *   - Audience rows are read LITERALLY. A party grant and a circle grant that
 *     happens to contain that party are different rows and different
 *     decisions; only `listLiveGrantsReachingParty` unions them, and it says
 *     so in its name.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import type { ShareableItemType } from "../share/closure.js";
import { fulfillmentAnswerFor } from "./subject-registry.js";

export type ShareGrantCapability = "view" | "edit";

export type ShareGrantAudienceKind = "party" | "circle";

export interface ShareGrantAudience {
  kind: ShareGrantAudienceKind;
  /** `core_party.party_id` when kind is 'party', `social_circle.circle_id`
   *  when 'circle'. Polymorphic by kind, so the column carries no FK. */
  id: string;
}

/**
 * Where delivery of one grant to one audience vault stands.
 *   - `awaiting_channel`: no live binding to deliver over yet.
 *   - `syncing`: the channel is open and the subject is on its way.
 *   - `delivered`: the peer holds the subject.
 *   - `remove_sent` / `removed`: revocation in flight, then acknowledged.
 */
export type ShareFulfillmentState =
  | "awaiting_channel"
  | "syncing"
  | "delivered"
  | "remove_sent"
  | "removed";

export interface ShareGrantRecord {
  grantId: string;
  audience: ShareGrantAudience;
  subjectType: ShareableItemType;
  subjectId: string;
  capability: ShareGrantCapability;
  grantedAt: string;
  revokedAt: string | null;
  /** The owner party who granted it. */
  grantedBy: string;
  maxSizeBytes: number | null;
}

export interface ShareFulfillmentRecord {
  grantId: string;
  peerVaultId: string;
  state: ShareFulfillmentState;
  updatedAt: string;
  detail: string | null;
}

export interface CreateShareGrantInput {
  audience: ShareGrantAudience;
  subjectType: ShareableItemType;
  subjectId: string;
  capability: ShareGrantCapability;
  grantedAt: string;
  grantedBy: string;
  maxSizeBytes?: number | null;
}

/**
 * `created` inserted a new standing grant; `exists` found one already
 * standing for this audience and subject and left it exactly as it was —
 * including its capability, which only an explicit revoke-and-regrant
 * changes.
 */
export type CreateShareGrantResult =
  | { outcome: "created"; grantId: string; grant: ShareGrantRecord }
  | { outcome: "exists"; grantId: string; grant: ShareGrantRecord };

/**
 * The #750 refusal, thrown by `createShareGrant`: no fulfillment strategy
 * answers this subject × capability pair, so recording a grant would accept a
 * gesture the vault cannot keep. Surfaces consult the subject registry BEFORE
 * drawing the verb; reaching the store with an unofferable pair is a contract
 * violation upstream, not a state this store can represent.
 */
export class UnofferableSubjectError extends Error {
  readonly subjectType: string;
  readonly capability: ShareGrantCapability;
  constructor(subjectType: string, capability: ShareGrantCapability) {
    super(
      `no fulfillment strategy answers ${subjectType} x ${capability}; the grant cannot be offered`
    );
    this.name = "UnofferableSubjectError";
    this.subjectType = subjectType;
    this.capability = capability;
  }
}

export interface RevokeShareGrantResult {
  outcome: "revoked" | "already-revoked" | "absent";
  /** Fulfillment rows standing at revocation time. Propagating a removal over
   *  them is the delivering strategy's job, not this store's. */
  fulfillment: ShareFulfillmentRecord[];
}

type ShareGrantRow = {
  grant_id: string;
  audience_kind: string;
  audience_id: string;
  subject_type: string;
  subject_id: string;
  capability: string;
  granted_at: string;
  revoked_at: string | null;
  granted_by: string;
  max_size_bytes: number | null;
};

type ShareFulfillmentRow = {
  grant_id: string;
  peer_vault_id: string;
  state: string;
  updated_at: string;
  detail: string | null;
};

// CHECK constraints are what make the narrowing casts below sound: no row can
// reach these readers holding a value outside the declared vocabulary.
function toGrant(row: ShareGrantRow): ShareGrantRecord {
  return {
    grantId: row.grant_id,
    audience: {
      kind: row.audience_kind as ShareGrantAudienceKind,
      id: row.audience_id,
    },
    subjectType: row.subject_type as ShareableItemType,
    subjectId: row.subject_id,
    capability: row.capability as ShareGrantCapability,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    grantedBy: row.granted_by,
    maxSizeBytes: row.max_size_bytes,
  };
}

function toFulfillment(row: ShareFulfillmentRow): ShareFulfillmentRecord {
  return {
    grantId: row.grant_id,
    peerVaultId: row.peer_vault_id,
    state: row.state as ShareFulfillmentState,
    updatedAt: row.updated_at,
    detail: row.detail,
  };
}

const GRANT_COLUMNS = `grant_id, audience_kind, audience_id, subject_type,
  subject_id, capability, granted_at, revoked_at, granted_by, max_size_bytes`;

/** The one live grant for this audience and subject, if any. */
export function readLiveShareGrant(
  db: DatabaseSync,
  audience: ShareGrantAudience,
  subjectType: ShareableItemType,
  subjectId: string
): ShareGrantRecord | undefined {
  const row = db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM share_grant
        WHERE audience_kind = ? AND audience_id = ?
          AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL`
    )
    .get(audience.kind, audience.id, subjectType, subjectId) as
    | ShareGrantRow
    | undefined;
  return row ? toGrant(row) : undefined;
}

/**
 * Record a standing grant. Idempotent by the live-uniqueness rule: a second
 * share of the same subject with the same audience reports the grant already
 * standing rather than minting a rival row.
 */
export function createShareGrant(
  db: DatabaseSync,
  input: CreateShareGrantInput
): CreateShareGrantResult {
  if (!fulfillmentAnswerFor(input.subjectType, input.capability)) {
    throw new UnofferableSubjectError(input.subjectType, input.capability);
  }
  const standing = readLiveShareGrant(
    db,
    input.audience,
    input.subjectType,
    input.subjectId
  );
  if (standing) {
    return { outcome: "exists", grantId: standing.grantId, grant: standing };
  }
  const grantId = uuidv7();
  db.prepare(
    `INSERT INTO share_grant
       (grant_id, audience_kind, audience_id, subject_type, subject_id,
        capability, granted_at, revoked_at, granted_by, max_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    grantId,
    input.audience.kind,
    input.audience.id,
    input.subjectType,
    input.subjectId,
    input.capability,
    input.grantedAt,
    input.grantedBy,
    input.maxSizeBytes ?? null
  );
  const grant = readShareGrant(db, grantId);
  if (!grant) throw new Error(`share grant ${grantId} vanished after insert`);
  return { outcome: "created", grantId, grant };
}

export function readShareGrant(
  db: DatabaseSync,
  grantId: string
): ShareGrantRecord | undefined {
  const row = db
    .prepare(`SELECT ${GRANT_COLUMNS} FROM share_grant WHERE grant_id = ?`)
    .get(grantId) as ShareGrantRow | undefined;
  return row ? toGrant(row) : undefined;
}

/**
 * End a standing grant. The row survives revoked — it is the record that the
 * share once stood — and the fulfillment rows are returned untouched, because
 * the removal each of them needs is a delivery act this store does not own.
 */
export function revokeShareGrant(
  db: DatabaseSync,
  input: { grantId: string; revokedAt: string }
): RevokeShareGrantResult {
  const existing = readShareGrant(db, input.grantId);
  const fulfillment = listFulfillment(db, input.grantId);
  if (!existing) return { outcome: "absent", fulfillment };
  if (existing.revokedAt !== null) {
    return { outcome: "already-revoked", fulfillment };
  }
  db.prepare(
    `UPDATE share_grant SET revoked_at = ?
      WHERE grant_id = ? AND revoked_at IS NULL`
  ).run(input.revokedAt, input.grantId);
  return { outcome: "revoked", fulfillment };
}

/**
 * Grants naming this audience EXACTLY. A party audience does not pick up the
 * circle grants that happen to contain it — see
 * `listLiveGrantsReachingParty` for the union.
 */
export function listShareGrantsForAudience(
  db: DatabaseSync,
  audience: ShareGrantAudience,
  options: { includeRevoked?: boolean } = {}
): ShareGrantRecord[] {
  const live = options.includeRevoked === true ? "" : " AND revoked_at IS NULL";
  return (
    db
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM share_grant
          WHERE audience_kind = ? AND audience_id = ?${live}
          ORDER BY granted_at, grant_id`
      )
      .all(audience.kind, audience.id) as ShareGrantRow[]
  ).map(toGrant);
}

export function listShareGrantsForSubject(
  db: DatabaseSync,
  subjectType: ShareableItemType,
  subjectId: string,
  options: { includeRevoked?: boolean } = {}
): ShareGrantRecord[] {
  const live = options.includeRevoked === true ? "" : " AND revoked_at IS NULL";
  return (
    db
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM share_grant
          WHERE subject_type = ? AND subject_id = ?${live}
          ORDER BY granted_at, grant_id`
      )
      .all(subjectType, subjectId) as ShareGrantRow[]
  ).map(toGrant);
}

/**
 * The parties an audience resolves to: itself for a party, its roster for a
 * circle. A circle with no members resolves to nobody, which is the honest
 * answer — the grant stands, it simply reaches no one yet.
 */
export function resolveAudienceParties(
  db: DatabaseSync,
  audience: ShareGrantAudience
): string[] {
  if (audience.kind === "party") return [audience.id];
  return (
    db
      .prepare(
        `SELECT party_id FROM social_circle_member
          WHERE circle_id = ? ORDER BY party_id`
      )
      .all(audience.id) as { party_id: string }[]
  ).map((row) => row.party_id);
}

/**
 * Every live grant that reaches this person — party grants naming them, plus
 * circle grants over a circle they are on the roster of. This is the only
 * reader that crosses audience kinds, and the one a "what can they see"
 * question should ask.
 */
export function listLiveGrantsReachingParty(
  db: DatabaseSync,
  partyId: string
): ShareGrantRecord[] {
  return (
    db
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM share_grant
          WHERE revoked_at IS NULL
            AND (
              (audience_kind = 'party' AND audience_id = ?)
              OR (audience_kind = 'circle' AND audience_id IN (
                    SELECT circle_id FROM social_circle_member WHERE party_id = ?
                 ))
            )
          ORDER BY granted_at, grant_id`
      )
      .all(partyId, partyId) as ShareGrantRow[]
  ).map(toGrant);
}

/**
 * Open delivery state for one audience vault without disturbing a row that
 * already exists — the write a strategy makes when it first learns which
 * vault it will be delivering into.
 */
export function ensureFulfillment(
  db: DatabaseSync,
  input: {
    grantId: string;
    peerVaultId: string;
    state: ShareFulfillmentState;
    updatedAt: string;
  }
): ShareFulfillmentRecord {
  db.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (grant_id, peer_vault_id) DO NOTHING`
  ).run(input.grantId, input.peerVaultId, input.state, input.updatedAt);
  const row = readFulfillment(db, input.grantId, input.peerVaultId);
  if (!row) {
    throw new Error(
      `share fulfillment ${input.grantId}/${input.peerVaultId} vanished after insert`
    );
  }
  return row;
}

/** Move one audience vault's delivery state. `detail` is replaced whenever it
 *  is supplied and cleared when it is explicitly null. */
export function setFulfillmentState(
  db: DatabaseSync,
  input: {
    grantId: string;
    peerVaultId: string;
    state: ShareFulfillmentState;
    updatedAt: string;
    detail?: string | null;
  }
): ShareFulfillmentRecord {
  const detail = input.detail === undefined ? null : input.detail;
  db.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (grant_id, peer_vault_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at,
       detail = excluded.detail`
  ).run(input.grantId, input.peerVaultId, input.state, input.updatedAt, detail);
  const row = readFulfillment(db, input.grantId, input.peerVaultId);
  if (!row) {
    throw new Error(
      `share fulfillment ${input.grantId}/${input.peerVaultId} vanished after write`
    );
  }
  return row;
}

export function readFulfillment(
  db: DatabaseSync,
  grantId: string,
  peerVaultId: string
): ShareFulfillmentRecord | undefined {
  const row = db
    .prepare(
      `SELECT grant_id, peer_vault_id, state, updated_at, detail
         FROM share_fulfillment WHERE grant_id = ? AND peer_vault_id = ?`
    )
    .get(grantId, peerVaultId) as ShareFulfillmentRow | undefined;
  return row ? toFulfillment(row) : undefined;
}

export function listFulfillment(
  db: DatabaseSync,
  grantId: string
): ShareFulfillmentRecord[] {
  return (
    db
      .prepare(
        `SELECT grant_id, peer_vault_id, state, updated_at, detail
           FROM share_fulfillment WHERE grant_id = ? ORDER BY peer_vault_id`
      )
      .all(grantId) as ShareFulfillmentRow[]
  ).map(toFulfillment);
}
