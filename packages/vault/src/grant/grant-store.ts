/*
 * The grant plane's store (#825): a lens over the `person`/`circle` rows of
 * the one authority table, translating to `principal_kind`/`verb` here alone.
 * `share_authority` holds MEANING, `share_fulfillment` MECHANISM — where the
 * delivering strategy stands, one row per audience vault. Nothing here
 * delivers. Audience rows read LITERALLY: a party grant and a circle grant
 * containing that party differ.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import type { ShareableItemType } from "../share/closure.js";
import { listFulfillment } from "./grant-fulfillment-rows.js";
import {
  defaultDeparturePolicy,
  GRANT_SELECT,
  PRINCIPAL_OF_AUDIENCE,
  toGrant,
  UnofferableSubjectError,
} from "./grant-records.js";
import type {
  CreateShareGrantInput,
  CreateShareGrantResult,
  RevokeShareGrantResult,
  ShareGrantAudience,
  ShareGrantCapability,
  ShareGrantRecord,
  ShareGrantRow,
} from "./grant-records.js";
import { prepared } from "./prepared.js";
import { fulfillmentAnswerFor } from "./subject-registry.js";

export * from "./grant-records.js";
export * from "./grant-authority.js";
export * from "./grant-fulfillment-rows.js";

/**
 * What LIVE means for an answer (#916, review 6.1). `expires_at` was written
 * at every "until Friday" grant and read by nothing: the resolvers filtered
 * `revoked_at` alone, so a time-boxed share kept answering yes forever and the
 * end date was decoration. The clock is SQLite's, the same one the purge
 * triggers stamp with, so a resolver and a sweep can never disagree about
 * whether an answer has run out.
 */
const AUTHORITY_CLOCK = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
export const LIVE_AUTHORITY_SQL = `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${AUTHORITY_CLOCK})`;
const LIVE_AUTHORITY_A_SQL = `a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ${AUTHORITY_CLOCK})`;

export function readLiveShareGrant(
  db: DatabaseSync,
  audience: ShareGrantAudience,
  subjectType: ShareableItemType,
  subjectId: string
): ShareGrantRecord | undefined {
  const row = prepared(
    db,
    `${GRANT_SELECT}
        AND a.principal_kind = ? AND a.principal_id = ?
        AND a.subject_type = ? AND a.subject_id = ? AND ${LIVE_AUTHORITY_A_SQL}`
  ).get(
    PRINCIPAL_OF_AUDIENCE[audience.kind],
    audience.id,
    subjectType,
    subjectId
  ) as ShareGrantRow | undefined;
  return row ? toGrant(row) : undefined;
}

/**
 * A refusal is an answer, not an absent grant, and stays LIVE: that masks
 * fulfillment, and forces a later grant to revoke it first (#883).
 */
export function readLiveShareRefusal(
  db: DatabaseSync,
  input: {
    audience: ShareGrantAudience;
    subjectType: string;
    subjectId: string;
    capability: ShareGrantCapability;
  }
): string | undefined {
  const row = prepared(
    db,
    `SELECT authority_id FROM share_authority
      WHERE principal_kind = ? AND principal_id = ? AND subject_type = ?
        AND subject_id = ? AND verb = ? AND duration = 'standing'
        AND decision = 'declined' AND ${LIVE_AUTHORITY_SQL}`
  ).get(
    PRINCIPAL_OF_AUDIENCE[input.audience.kind],
    input.audience.id,
    input.subjectType,
    input.subjectId,
    input.capability
  ) as { authority_id: string } | undefined;
  return row?.authority_id;
}

/** Idempotent: a repeat reports the standing grant, never a rival. */
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
    return standing.capability === input.capability
      ? { outcome: "exists", grantId: standing.grantId, grant: standing }
      : { outcome: "conflict", grantId: standing.grantId, grant: standing };
  }
  // Revoked, never deleted: "told no, then said yes" stays readable.
  revokeShareRefusal(db, {
    audience: input.audience,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    capability: input.capability,
    revokedAt: input.grantedAt,
  });
  const grantId = uuidv7();
  db.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by,
        revoked_at, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, 'standing', NULL, 'granted', ?, ?, NULL, NULL)`
  ).run(
    grantId,
    PRINCIPAL_OF_AUDIENCE[input.audience.kind],
    input.audience.id,
    input.subjectType,
    input.subjectId,
    input.capability,
    input.grantedAt,
    input.grantedBy
  );
  // Only a chosen ceiling or a non-default departure policy gets a row:
  // absence IS the default, on both halves.
  const departurePolicy =
    input.departurePolicy ?? defaultDeparturePolicy(input.subjectType);
  const ceiling = input.maxSizeBytes ?? null;
  if (ceiling !== null || departurePolicy !== "remove-member-only") {
    db.prepare(
      `INSERT INTO share_delivery_config
         (grant_id, max_size_bytes, departure_policy)
       VALUES (?, ?, ?)`
    ).run(grantId, ceiling, departurePolicy);
  }
  const grant = readShareGrant(db, grantId);
  if (!grant) throw new Error(`share grant ${grantId} vanished after insert`);
  return { outcome: "created", grantId, grant };
}

export function readShareGrant(
  db: DatabaseSync,
  grantId: string
): ShareGrantRecord | undefined {
  const row = prepared(db, `${GRANT_SELECT} AND a.authority_id = ?`).get(
    grantId
  ) as ShareGrantRow | undefined;
  return row ? toGrant(row) : undefined;
}

/** The row survives revoked; fulfillment comes back untouched. */
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
  // `revoked_at` is the ONE updatable column; the rest is immutable.
  db.prepare(
    `UPDATE share_authority SET revoked_at = ?
      WHERE authority_id = ? AND revoked_at IS NULL`
  ).run(input.revokedAt, input.grantId);
  return { outcome: "revoked", fulfillment };
}

export interface DeclineShareInput {
  audience: ShareGrantAudience;
  subjectType: ShareableItemType;
  subjectId: string;
  capability: ShareGrantCapability;
  decidedAt: string;
  decidedBy: string;
}

export type DeclineShareResult =
  | { outcome: "declined"; authorityId: string }
  | { outcome: "exists"; authorityId: string };

/**
 * The NO is a row, which makes it a REFUSAL MASK over circle membership:
 * refusing one person inside a granted circle keeps the circle (#883).
 */
export function declineShare(
  db: DatabaseSync,
  input: DeclineShareInput
): DeclineShareResult {
  const standing = readLiveShareRefusal(db, input);
  if (standing) return { outcome: "exists", authorityId: standing };
  // Saying no to what you granted ends the grant.
  const granted = readLiveShareGrant(
    db,
    input.audience,
    input.subjectType,
    input.subjectId
  );
  if (granted?.capability === input.capability)
    revokeShareGrant(db, {
      grantId: granted.grantId,
      revokedAt: input.decidedAt,
    });
  const authorityId = uuidv7();
  db.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by,
        revoked_at, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, 'standing', NULL, 'declined', ?, ?, NULL, NULL)`
  ).run(
    authorityId,
    PRINCIPAL_OF_AUDIENCE[input.audience.kind],
    input.audience.id,
    input.subjectType,
    input.subjectId,
    input.capability,
    input.decidedAt,
    input.decidedBy
  );
  return { outcome: "declined", authorityId };
}

/** Revoked, never deleted: the NO stays history. */
export function revokeShareRefusal(
  db: DatabaseSync,
  input: {
    audience: ShareGrantAudience;
    subjectType: string;
    subjectId: string;
    capability: ShareGrantCapability;
    revokedAt: string;
  }
): string | undefined {
  const standing = readLiveShareRefusal(db, input);
  if (!standing) return undefined;
  db.prepare(
    "UPDATE share_authority SET revoked_at = ? WHERE authority_id = ?"
  ).run(input.revokedAt, standing);
  return standing;
}

export function maskedPartiesForSubject(
  db: DatabaseSync,
  subjectType: string,
  subjectId: string
): Set<string> {
  return new Set(
    (
      prepared(
        db,
        `SELECT principal_id FROM share_authority
          WHERE principal_kind = 'person' AND decision = 'declined'
            AND subject_type = ? AND subject_id = ? AND ${LIVE_AUTHORITY_SQL}`
      ).all(subjectType, subjectId) as { principal_id: string }[]
    ).map((row) => row.principal_id)
  );
}

/**
 * Roster less anyone refused here. `resolveAudienceParties` stays the LITERAL
 * read, which is what the gateway's edit-refusal check asks.
 */
export function resolveGrantAudienceParties(
  db: DatabaseSync,
  grant: Pick<ShareGrantRecord, "audience" | "subjectType" | "subjectId">
): { parties: string[]; masked: string[] } {
  const roster = resolveAudienceParties(db, grant.audience);
  const masked = maskedPartiesForSubject(
    db,
    grant.subjectType,
    grant.subjectId
  );
  if (masked.size === 0) return { parties: roster, masked: [] };
  return {
    parties: roster.filter((partyId) => !masked.has(partyId)),
    masked: roster.filter((partyId) => masked.has(partyId)),
  };
}

/** EXACTLY this audience; `listLiveGrantsReachingParty` unions kinds. */
export function listShareGrantsForAudience(
  db: DatabaseSync,
  audience: ShareGrantAudience,
  options: { includeRevoked?: boolean } = {}
): ShareGrantRecord[] {
  const live =
    options.includeRevoked === true ? "" : ` AND ${LIVE_AUTHORITY_A_SQL}`;
  return (
    db
      .prepare(
        `${GRANT_SELECT}
          AND a.principal_kind = ? AND a.principal_id = ?${live}
          ORDER BY a.granted_at, a.authority_id`
      )
      .all(PRINCIPAL_OF_AUDIENCE[audience.kind], audience.id) as ShareGrantRow[]
  ).map(toGrant);
}

export function listShareGrantsForSubject(
  db: DatabaseSync,
  subjectType: ShareableItemType,
  subjectId: string,
  options: { includeRevoked?: boolean } = {}
): ShareGrantRecord[] {
  const live =
    options.includeRevoked === true ? "" : ` AND ${LIVE_AUTHORITY_A_SQL}`;
  return (
    db
      .prepare(
        `${GRANT_SELECT}
          AND a.subject_type = ? AND a.subject_id = ?${live}
          ORDER BY a.granted_at, a.authority_id`
      )
      .all(subjectType, subjectId) as ShareGrantRow[]
  ).map(toGrant);
}

/** Absent-never-empty: both cases would answer `grants: []` otherwise. */
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

/** An empty circle resolves to nobody; the grant still stands. */
export function resolveAudienceParties(
  db: DatabaseSync,
  audience: ShareGrantAudience
): string[] {
  if (audience.kind === "party") return [audience.id];
  return (
    prepared(
      db,
      `SELECT party_id FROM social_circle_member
          WHERE circle_id = ? ORDER BY party_id`
    ).all(audience.id) as { party_id: string }[]
  ).map((row) => row.party_id);
}

export function listLiveGrantsReachingParty(
  db: DatabaseSync,
  partyId: string
): ShareGrantRecord[] {
  return (
    db
      .prepare(
        `${GRANT_SELECT}
          AND ${LIVE_AUTHORITY_A_SQL}
          AND (
            (a.principal_kind = 'person' AND a.principal_id = ?)
            OR (a.principal_kind = 'circle' AND a.principal_id IN (
                  SELECT circle_id FROM social_circle_member WHERE party_id = ?
               ))
          )
          ORDER BY a.granted_at, a.authority_id`
      )
      .all(partyId, partyId) as ShareGrantRow[]
  ).map(toGrant);
}
