/*
 * The grant plane's store (#825). `share_grant` holds MEANING,
 * `share_fulfillment` MECHANISM: one row per audience vault, recording where
 * the delivering strategy stands. Nothing here delivers. ONE live grant per
 * audience × subject, and audience rows are read LITERALLY — a party grant and
 * a circle grant containing that party are different decisions.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import type { ShareableItemType } from "../share/closure.js";
import { fulfillmentAnswerFor } from "./subject-registry.js";

export type ShareGrantCapability = "view" | "edit";

export type ShareGrantAudienceKind = "party" | "circle";

export interface ShareGrantAudience {
  kind: ShareGrantAudienceKind;
  /** Polymorphic by kind, so the column carries no FK. */
  id: string;
}

/** `awaiting_channel` has no live binding; `remove_sent` is revocation in flight. */
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
  grantedBy: string;
  maxSizeBytes: number | null;
}

export interface ShareFulfillmentRecord {
  grantId: string;
  peerVaultId: string;
  state: ShareFulfillmentState;
  updatedAt: string;
  detail: string | null;
  /**
   * When the subject FIRST reached this peer. Not derivable from `state`
   * (#846), which degrades to `syncing` on an unreachable pass: revocation
   * needs the durable fact or a degraded grant has "nothing to remove".
   */
  deliveredAt: string | null;
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

export type CreateShareGrantResult =
  | { outcome: "created"; grantId: string; grant: ShareGrantRecord }
  | { outcome: "exists"; grantId: string; grant: ShareGrantRecord };

/**
 * No strategy answers this subject × capability, so the grant would accept a
 * gesture the vault cannot keep (#750). Surfaces consult the registry BEFORE
 * drawing the verb; arriving here is an upstream bug.
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
  /** Propagating removal over these is the strategy's job. */
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
  delivered_at: string | null;
};

// CHECK constraints make the narrowing casts below sound.
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
    deliveredAt: row.delivered_at,
  };
}

const FULFILLMENT_COLUMNS = `grant_id, peer_vault_id, state, updated_at,
  detail, delivered_at`;

const GRANT_COLUMNS = `grant_id, audience_kind, audience_id, subject_type,
  subject_id, capability, granted_at, revoked_at, granted_by, max_size_bytes`;

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

/** Idempotent: a repeat reports the standing grant, never mints a rival. */
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

/** The row survives revoked; fulfillment rows come back untouched. */
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

/** EXACTLY this audience; `listLiveGrantsReachingParty` unions kinds. */
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
 * Absent-never-empty needs this: "never heard of them" and "nothing shared
 * with them" both answer `grants: []` otherwise.
 */
export function audienceExists(
  db: DatabaseSync,
  audience: ShareGrantAudience
): boolean {
  return (
    db
      .prepare(
        audience.kind === "party"
          ? "SELECT 1 FROM core_party WHERE party_id = ?"
          : "SELECT 1 FROM social_circle WHERE circle_id = ?"
      )
      .get(audience.id) !== undefined
  );
}

/** An empty circle resolves to nobody: the grant stands, reaching no one. */
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

/** The ONLY reader crossing audience kinds. */
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

export function ensureFulfillment(
  db: DatabaseSync,
  input: {
    grantId: string;
    peerVaultId: string;
    state: ShareFulfillmentState;
    updatedAt: string;
  }
): ShareFulfillmentRecord {
  // A row opened AT `delivered` carries the memory from birth (#846).
  db.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT (grant_id, peer_vault_id) DO NOTHING`
  ).run(
    input.grantId,
    input.peerVaultId,
    input.state,
    input.updatedAt,
    input.state === "delivered" ? input.updatedAt : null
  );
  const row = readFulfillment(db, input.grantId, input.peerVaultId);
  if (!row) {
    throw new Error(
      `share fulfillment ${input.grantId}/${input.peerVaultId} vanished after insert`
    );
  }
  return row;
}

/**
 * `delivered_at` is maintained HERE, never by callers (#846): `delivered`
 * stamps the FIRST instant, `removed` clears it, every other transition —
 * `syncing` included — leaves it alone, so a blip cannot erase a delivery.
 */
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
  const clearDelivered = input.state === "removed";
  const deliveredAt = input.state === "delivered" ? input.updatedAt : null;
  db.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (grant_id, peer_vault_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at,
       detail = excluded.detail,
       delivered_at = CASE
         WHEN ${clearDelivered ? 1 : 0} = 1 THEN NULL
         ELSE COALESCE(share_fulfillment.delivered_at, excluded.delivered_at)
       END`
  ).run(
    input.grantId,
    input.peerVaultId,
    input.state,
    input.updatedAt,
    detail,
    deliveredAt
  );
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
      `SELECT ${FULFILLMENT_COLUMNS}
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
        `SELECT ${FULFILLMENT_COLUMNS}
           FROM share_fulfillment WHERE grant_id = ? ORDER BY peer_vault_id`
      )
      .all(grantId) as ShareFulfillmentRow[]
  ).map(toFulfillment);
}
