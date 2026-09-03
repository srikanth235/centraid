// governance: allow-repo-hygiene file-size-limit (#731) snapshot/tail export, invitation consent, CAS bytes, tombstones, and atomic apply form one peer bootstrap integrity boundary.
// Snapshot + tail wire for peer Commons catch-up: the snapshot is a complete
// domain closure at sequence N, the tail the ordered stream after N. Blob bytes
// travel separately by sha and are verified by CAS.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { vaultIdentityPublicKey } from "../schema/vault-identity.js";
import { CLOSURE_FORMAT_VERSION, shareOriginEntityType } from "./closure.js";
import type { WireClosure } from "./closure.js";
import type { CommonsCheckpointAttestation } from "./commons-chain.js";
import {
  assertCommonsStateDigest,
  chainColumns,
  readCommonsCheckpointAttestation,
  readCommonsVerified,
  recordCommonsVerified,
  signCommonsCheckpoint,
  verifyCommonsFrameHistory,
  verifyCommonsIncrementHistory,
} from "./commons-chain.js";
import {
  commonsTailBlobs,
  commonsTailIsContiguous,
  isCommonsReplayError,
  readCommonsTail,
  replayCommonsTail,
  stageCommonsTailBlobs,
} from "./commons-replay.js";
import type {
  CommonsReplicaExecutor,
  CommonsTailBlob,
} from "./commons-replay.js";
import {
  COMMONS_CHECKPOINT_INTERVAL,
  commonsClosure,
  COMMONS_OP_RETENTION_FLOOR,
  readCommonsGrant,
  removeCommonsFromSeat,
} from "./commons.js";
import type { ShareVaultRef } from "./placement.js";
import { projectShareClosure } from "./project-closure.js";
import { isSelfBinding } from "./self-binding.js";

export interface CommonsBootstrap {
  grantId: string;
  stewardVaultId: string;
  memberVaultId: string;
  snapshotSequence: number;
  currentSequence: number;
  closure: WireClosure;
  /** ONE chained wire version: a frame without a verifiable checkpoint, or a
   *  tail op without its hashes, is a fault the member PARKS on. */
  checkpoint: CommonsCheckpointAttestation;
  control: {
    grant: Record<string, unknown>;
    circle: Record<string, unknown>;
    members: readonly Record<string, unknown>[];
    memberStates: readonly Record<string, unknown>[];
    parties: readonly Record<string, unknown>[];
    bindings: readonly Record<string, unknown>[];
    replay: readonly Record<string, unknown>[];
    receipts: readonly Record<string, unknown>[];
  };
  tail: readonly Record<string, unknown>[];
}

export interface CommonsTombstone {
  grantId: string;
  memberVaultId: string;
  currentSequence: number;
  reason: "grant_revoked" | "member_removed";
}

/** Roster-sized rows refreshed wholesale, so a frame stays O(members). The
 * grant row travels WITHOUT `checkpoint_json`: an increment must never ship or
 * overwrite the stored closure (#750). */
export interface CommonsIncrementControl {
  grant: Record<string, unknown>;
  circle: Record<string, unknown>;
  members: readonly Record<string, unknown>[];
  memberStates: readonly Record<string, unknown>[];
  parties: readonly Record<string, unknown>[];
  bindings: readonly Record<string, unknown>[];
}

/**
 * Ops-since-cursor catch-up (#750 invariant 7). `ops` is the EXECUTABLE tail the
 * member re-runs, not a description of the rows it should end up with; `blobs`
 * are the bytes re-execution cannot derive for itself. Verified by the same
 * chain machinery a full frame uses, anchored at the member's own proven head.
 */
export interface CommonsIncrement {
  grantId: string;
  stewardVaultId: string;
  memberVaultId: string;
  fromSequence: number;
  currentSequence: number;
  ops: readonly Record<string, unknown>[];
  receipts: readonly Record<string, unknown>[];
  replay: readonly Record<string, unknown>[];
  control: CommonsIncrementControl;
  blobs: readonly CommonsTailBlob[];
}

export type CommonsSyncFrame =
  | { state: "bootstrap"; wire: CommonsBootstrap }
  | { state: "increment"; increment: CommonsIncrement }
  | { state: "tombstone"; tombstone: CommonsTombstone };

/** Not a fault and not a park: the caller re-pulls the full frame. */
export class CommonsIncrementUnusableError extends VaultShareError {
  constructor(message: string) {
    super(message);
    this.name = "CommonsIncrementUnusableError";
  }
}

export function isCommonsIncrementUnusable(
  error: unknown
): error is CommonsIncrementUnusableError {
  return error instanceof CommonsIncrementUnusableError;
}

export interface CommonsInvitationRecord {
  invitationId: string;
  grantId: string;
  stewardVaultId: string;
  memberVaultId?: string;
  memberPartyId: string;
  capability: "read" | "read+write";
  containerType: string;
  containerId: string;
  containerLabel?: string;
  currentSizeBytes: number;
  maxSizeBytes?: number;
  status: "pending" | "accepted" | "refused";
  createdAt: string;
  answeredAt?: string;
}

interface CommonsInvitationRow {
  invitation_id: string;
  grant_id: string;
  steward_vault_id: string;
  member_vault_id: string | null;
  member_party_id: string;
  capability: CommonsInvitationRecord["capability"];
  container_type: string;
  container_id: string;
  container_label: string | null;
  current_size_bytes: number;
  max_size_bytes: number | null;
  status: CommonsInvitationRecord["status"];
  created_at: string;
  answered_at: string | null;
}

function invitationRecord(row: CommonsInvitationRow): CommonsInvitationRecord {
  return {
    invitationId: row.invitation_id,
    grantId: row.grant_id,
    stewardVaultId: row.steward_vault_id,
    ...(row.member_vault_id ? { memberVaultId: row.member_vault_id } : {}),
    memberPartyId: row.member_party_id,
    capability: row.capability,
    containerType: row.container_type,
    containerId: row.container_id,
    ...(row.container_label ? { containerLabel: row.container_label } : {}),
    currentSizeBytes: row.current_size_bytes,
    ...(row.max_size_bytes === null
      ? {}
      : { maxSizeBytes: row.max_size_bytes }),
    status: row.status,
    createdAt: row.created_at,
    ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
  };
}

/** Consent metadata only — projects no Commons domain row. */
export function queueCommonsInvitation(input: {
  seat: DatabaseSync;
  invitation: Omit<
    CommonsInvitationRecord,
    "invitationId" | "status" | "createdAt" | "answeredAt"
  > & { memberVaultId: string };
  now: string;
}): CommonsInvitationRecord {
  const invitationId = uuidv7();
  const invitation = input.invitation;
  input.seat
    .prepare(
      `INSERT INTO share_commons_invitation
         (invitation_id, grant_id, steward_vault_id, member_vault_id,
          member_party_id, capability, container_type, container_id,
          container_label, current_size_bytes, max_size_bytes,
          claim_token_hash, status, created_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)
       ON CONFLICT(grant_id, member_party_id) DO UPDATE SET
         invitation_id = excluded.invitation_id,
         steward_vault_id = excluded.steward_vault_id,
         member_vault_id = excluded.member_vault_id,
         member_party_id = excluded.member_party_id,
         capability = excluded.capability,
         container_type = excluded.container_type,
         container_id = excluded.container_id,
         container_label = excluded.container_label,
         current_size_bytes = excluded.current_size_bytes,
         max_size_bytes = excluded.max_size_bytes,
         status = 'pending', created_at = excluded.created_at,
         answered_at = NULL
       WHERE share_commons_invitation.status IN ('pending', 'refused')
          OR NOT EXISTS (
               SELECT 1 FROM share_circle_grant g
                WHERE g.grant_id = excluded.grant_id AND g.revoked_at IS NULL
             )`
    )
    .run(
      invitationId,
      invitation.grantId,
      invitation.stewardVaultId,
      invitation.memberVaultId,
      invitation.memberPartyId,
      invitation.capability,
      invitation.containerType,
      invitation.containerId,
      invitation.containerLabel ?? null,
      invitation.currentSizeBytes,
      invitation.maxSizeBytes ?? null,
      input.now
    );
  const row = input.seat
    .prepare(
      `SELECT invitation_id, grant_id, steward_vault_id, member_vault_id,
              member_party_id, capability, container_type, container_id,
              container_label, current_size_bytes, max_size_bytes,
              status, created_at, answered_at
         FROM share_commons_invitation
        WHERE grant_id = ? AND member_party_id = ?`
    )
    .get(
      invitation.grantId,
      invitation.memberPartyId
    ) as unknown as CommonsInvitationRow;
  return invitationRecord(row);
}

function claimHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Only the token's hash is durable or exported; the raw token is returned
 * once. Claiming still requires an authenticated approved vault link. */
export function createCommonsClaimInvitation(input: {
  seat: DatabaseSync;
  invitation: Omit<
    CommonsInvitationRecord,
    "invitationId" | "memberVaultId" | "status" | "createdAt" | "answeredAt"
  >;
  now: string;
}): { invitation: CommonsInvitationRecord; claimToken: string } {
  const invitationId = uuidv7();
  const claimToken = randomBytes(32).toString("base64url");
  const value = input.invitation;
  input.seat
    .prepare(
      `INSERT INTO share_commons_invitation
         (invitation_id, grant_id, steward_vault_id, member_vault_id,
          member_party_id, capability, container_type, container_id,
          container_label, current_size_bytes, max_size_bytes,
          claim_token_hash, status, created_at, answered_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
       ON CONFLICT(grant_id, member_party_id) DO UPDATE SET
         member_vault_id = NULL,
         capability = excluded.capability,
         container_type = excluded.container_type,
         container_id = excluded.container_id,
         container_label = excluded.container_label,
         current_size_bytes = excluded.current_size_bytes,
         max_size_bytes = excluded.max_size_bytes,
         claim_token_hash = excluded.claim_token_hash,
         status = 'pending', answered_at = NULL`
    )
    .run(
      invitationId,
      value.grantId,
      value.stewardVaultId,
      value.memberPartyId,
      value.capability,
      value.containerType,
      value.containerId,
      value.containerLabel ?? null,
      value.currentSizeBytes,
      value.maxSizeBytes ?? null,
      claimHash(claimToken),
      input.now
    );
  const row = input.seat
    .prepare(
      `SELECT invitation_id, grant_id, steward_vault_id, member_vault_id,
              member_party_id, capability, container_type, container_id,
              container_label, current_size_bytes, max_size_bytes,
              status, created_at, answered_at
         FROM share_commons_invitation
        WHERE grant_id = ? AND member_party_id = ?`
    )
    .get(value.grantId, value.memberPartyId) as unknown as CommonsInvitationRow;
  return { invitation: invitationRecord(row), claimToken };
}

export function claimCommonsInvitation(input: {
  steward: DatabaseSync;
  claimToken: string;
  memberVaultId: string;
  memberVaultPublicKey: string;
  now: string;
}): CommonsInvitationRecord {
  const held = input.steward
    .prepare(
      `SELECT invitation_id, grant_id, steward_vault_id, member_vault_id,
              member_party_id, capability, container_type, container_id,
              container_label, current_size_bytes, max_size_bytes,
              status, created_at, answered_at
         FROM share_commons_invitation
        WHERE claim_token_hash = ? AND status = 'pending'
          AND member_vault_id IS NULL`
    )
    .get(claimHash(input.claimToken)) as unknown as
    | CommonsInvitationRow
    | undefined;
  if (!held)
    throw new Error("commons invitation claim is invalid or already used");
  input.steward.exec("BEGIN IMMEDIATE");
  try {
    input.steward
      .prepare(
        `UPDATE share_commons_invitation
            SET member_vault_id = ?, claim_token_hash = NULL
          WHERE invitation_id = ?`
      )
      .run(input.memberVaultId, held.invitation_id);
    input.steward
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(party_id, vault_id) DO UPDATE SET
           vault_public_key = excluded.vault_public_key,
           linked_at = excluded.linked_at, revoked_at = NULL`
      )
      .run(
        uuidv7(),
        held.member_party_id,
        input.memberVaultId,
        input.memberVaultPublicKey,
        input.now
      );
    input.steward.exec("COMMIT");
  } catch (error) {
    input.steward.exec("ROLLBACK");
    throw error;
  }
  return { ...invitationRecord(held), memberVaultId: input.memberVaultId };
}

export function listCommonsInvitations(input: {
  seat: DatabaseSync;
  memberVaultId: string;
}): CommonsInvitationRecord[] {
  return (
    input.seat
      .prepare(
        `SELECT invitation_id, grant_id, steward_vault_id, member_vault_id,
                member_party_id, capability, container_type, container_id,
                container_label, current_size_bytes, max_size_bytes,
                status, created_at, answered_at
           FROM share_commons_invitation
          WHERE member_vault_id = ?
          ORDER BY created_at, invitation_id`
      )
      .all(input.memberVaultId) as unknown as CommonsInvitationRow[]
  ).map(invitationRecord);
}

export function answerCommonsInvitation(input: {
  seat: ShareVaultRef;
  invitationId: string;
  memberVaultId: string;
  answer: "accept" | "refuse";
  now: string;
}): CommonsInvitationRecord {
  const held = input.seat.vault
    .prepare(
      `SELECT invitation_id, grant_id, steward_vault_id, member_vault_id,
              member_party_id, capability, container_type, container_id,
              container_label, current_size_bytes, max_size_bytes,
              status, created_at, answered_at
         FROM share_commons_invitation WHERE invitation_id = ?`
    )
    .get(input.invitationId) as unknown as CommonsInvitationRow | undefined;
  if (!held || held.member_vault_id !== input.memberVaultId)
    throw new Error("commons invitation is not available for this vault");
  if (held.status === "pending")
    input.seat.vault
      .prepare(
        `UPDATE share_commons_invitation
            SET status = ?, answered_at = ? WHERE invitation_id = ?`
      )
      .run(
        input.answer === "accept" ? "accepted" : "refused",
        input.now,
        input.invitationId
      );
  const row = input.seat.vault
    .prepare(
      `SELECT invitation_id, grant_id, steward_vault_id, member_vault_id,
              member_party_id, capability, container_type, container_id,
              container_label, current_size_bytes, max_size_bytes,
              status, created_at, answered_at
         FROM share_commons_invitation WHERE invitation_id = ?`
    )
    .get(input.invitationId) as unknown as CommonsInvitationRow;
  return invitationRecord(row);
}

function sql(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  )
    return value;
  throw new Error("commons bootstrap contains a non-SQL value");
}

/**
 * The roster bindings a wire carries, PLUS the steward's own identity (#916,
 * R9). The steward's public key used to ride a `share_party_vault_binding` row
 * naming its own vault — a self-binding, which the schema now refuses because
 * it makes the member their own peer. The key is still what a member verifies
 * the chain against, so it travels explicitly, derived from the vault's own
 * identity seed rather than read back out of a row about someone else.
 */
function wireBindings(
  steward: DatabaseSync,
  circleId: string,
  stewardVaultId: string,
  identitySeed: Buffer,
  now: string
): Record<string, unknown>[] {
  const rows = steward
    .prepare(
      `SELECT * FROM share_party_vault_binding
        WHERE party_id IN (
          SELECT party_id FROM social_circle_member WHERE circle_id = ?
        )`
    )
    .all(circleId) as Record<string, unknown>[];
  const self = steward
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!self?.self_party_id) return rows;
  return [
    ...rows,
    {
      binding_id: `self:${stewardVaultId}`,
      party_id: self.self_party_id,
      vault_id: stewardVaultId,
      vault_public_key: vaultIdentityPublicKey(identitySeed).toString("base64"),
      linked_at: now,
      revoked_at: null,
    },
  ];
}

export function exportCommonsBootstrap(input: {
  steward: DatabaseSync;
  stewardVaultId: string;
  grantId: string;
  memberVaultId: string;
  identitySeed: Buffer;
}): CommonsBootstrap {
  const grant = readCommonsGrant(input.steward, input.grantId);
  if (grant.revokedAt) throw new Error("commons grant is revoked");
  const membership = input.steward
    .prepare(
      `SELECT 1 AS n FROM social_circle_member m
       JOIN share_commons_member_state s
         ON s.grant_id = ? AND s.party_id = m.party_id AND s.status = 'current'
       JOIN share_party_vault_binding b ON b.party_id = m.party_id
       WHERE m.circle_id = ? AND b.vault_id = ? AND b.revoked_at IS NULL`
    )
    .get(grant.grantId, grant.circleId, input.memberVaultId);
  if (!membership)
    throw new Error("member vault is not joined to this commons");
  const rawGrant = input.steward
    .prepare("SELECT * FROM share_circle_grant WHERE grant_id = ?")
    .get(grant.grantId) as Record<string, unknown>;
  const rawCircle = input.steward
    .prepare("SELECT * FROM social_circle WHERE circle_id = ?")
    .get(grant.circleId) as Record<string, unknown>;
  const members = input.steward
    .prepare(
      "SELECT * FROM social_circle_member WHERE circle_id = ? ORDER BY added_at, member_id"
    )
    .all(grant.circleId) as Record<string, unknown>[];
  const partyIds = members.map((member) => String(member["party_id"]));
  const parties = partyIds.map(
    (partyId) =>
      input.steward
        .prepare("SELECT * FROM core_party WHERE party_id = ?")
        .get(partyId) as Record<string, unknown>
  );
  const bindings = wireBindings(
    input.steward,
    grant.circleId,
    input.stewardVaultId,
    input.identitySeed,
    new Date().toISOString()
  );
  const memberStates = input.steward
    .prepare(
      "SELECT * FROM share_commons_member_state WHERE grant_id = ? ORDER BY party_id"
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const replay = input.steward
    .prepare(
      `SELECT * FROM share_commons_replay
        WHERE grant_id = ? ORDER BY sequence, signing_vault_id, signature_nonce`
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const receipts = input.steward
    .prepare(
      `SELECT * FROM share_commons_receipt
        WHERE grant_id = ? ORDER BY sequence`
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const stored = rawGrant["checkpoint_json"];
  const attested = readCommonsCheckpointAttestation(
    input.steward,
    grant.grantId
  );
  let snapshotSequence = Number(rawGrant["checkpoint_sequence"] ?? 0);
  let closure =
    typeof stored === "string"
      ? (JSON.parse(stored) as WireClosure)
      : commonsClosure(input.steward, input.stewardVaultId, grant);
  let tail = input.steward
    .prepare(
      `SELECT * FROM share_commons_op
        WHERE grant_id = ? AND sequence > ? ORDER BY sequence`
    )
    .all(grant.grantId, snapshotSequence) as Record<string, unknown>[];
  // An executed domain command, or a checkpoint the steward cannot attest to,
  // makes the snapshot stale and forces a rebuild at the head. Refused and
  // control-only tail entries stay cheap deterministic tail application.
  const staleSnapshot =
    attested?.sequence !== snapshotSequence ||
    tail.some(
      (row) =>
        row["outcome"] === "executed" &&
        (row["kind"] === "command" || row["kind"] === "delete")
    );
  if (staleSnapshot) {
    closure = commonsClosure(input.steward, input.stewardVaultId, grant);
    snapshotSequence = grant.lastSequence;
    tail = [];
  }
  // The attestation covers the snapshot actually shipped, stored or rebuilt.
  const checkpoint = staleSnapshot
    ? signCommonsCheckpoint({
        db: input.steward,
        identitySeed: input.identitySeed,
        signerVaultId: input.stewardVaultId,
        grantId: grant.grantId,
        sequence: snapshotSequence,
        closure,
      })
    : attested;
  return {
    grantId: grant.grantId,
    stewardVaultId: input.stewardVaultId,
    memberVaultId: input.memberVaultId,
    snapshotSequence,
    currentSequence: grant.lastSequence,
    closure,
    checkpoint,
    control: {
      grant: rawGrant,
      circle: rawCircle,
      members,
      memberStates,
      parties,
      bindings,
      replay,
      receipts,
    },
    tail,
  };
}

/**
 * `undefined` means "full bootstrap", never an error: it is the right answer for
 * a cursor ahead of the head and for one whose ops compaction reclaimed.
 * Nothing here reads the closure — that is invariant 7 (#750): a
 * sync-with-changes costs the ops missed, never the size of the commons.
 */
export function exportCommonsIncrement(input: {
  steward: DatabaseSync;
  stewardVaultId: string;
  grantId: string;
  memberVaultId: string;
  afterSequence: number;
  identitySeed: Buffer;
}): CommonsIncrement | undefined {
  const grant = readCommonsGrant(input.steward, input.grantId);
  if (grant.revokedAt) return undefined;
  const membership = input.steward
    .prepare(
      `SELECT 1 AS n FROM social_circle_member m
       JOIN share_commons_member_state s
         ON s.grant_id = ? AND s.party_id = m.party_id AND s.status = 'current'
       JOIN share_party_vault_binding b ON b.party_id = m.party_id
       WHERE m.circle_id = ? AND b.vault_id = ? AND b.revoked_at IS NULL`
    )
    .get(grant.grantId, grant.circleId, input.memberVaultId);
  if (!membership) return undefined;
  if (input.afterSequence > grant.lastSequence) return undefined;
  const ops = input.steward
    .prepare(
      `SELECT * FROM share_commons_op
        WHERE grant_id = ? AND sequence > ? ORDER BY sequence`
    )
    .all(grant.grantId, input.afterSequence) as Record<string, unknown>[];
  // Chain verification and replay both need contiguity from the member's
  // cursor; a pruned window re-baselines instead.
  if (
    !commonsTailIsContiguous({
      tail: ops.map((op) => ({ sequence: Number(op["sequence"]) })),
      fromSequence: input.afterSequence,
      headSequence: grant.lastSequence,
    })
  )
    return undefined;
  const receipts = input.steward
    .prepare(
      `SELECT * FROM share_commons_receipt
        WHERE grant_id = ? AND sequence > ? ORDER BY sequence`
    )
    .all(grant.grantId, input.afterSequence) as Record<string, unknown>[];
  const replay = input.steward
    .prepare(
      `SELECT * FROM share_commons_replay
        WHERE grant_id = ? AND sequence > ?
        ORDER BY sequence, signing_vault_id, signature_nonce`
    )
    .all(grant.grantId, input.afterSequence) as Record<string, unknown>[];
  const { checkpoint_json: _checkpointJson, ...grantRow } = input.steward
    .prepare("SELECT * FROM share_circle_grant WHERE grant_id = ?")
    .get(grant.grantId) as Record<string, unknown>;
  const circle = input.steward
    .prepare("SELECT * FROM social_circle WHERE circle_id = ?")
    .get(grant.circleId) as Record<string, unknown>;
  const members = input.steward
    .prepare(
      "SELECT * FROM social_circle_member WHERE circle_id = ? ORDER BY added_at, member_id"
    )
    .all(grant.circleId) as Record<string, unknown>[];
  const parties = members.map(
    (member) =>
      input.steward
        .prepare("SELECT * FROM core_party WHERE party_id = ?")
        .get(String(member["party_id"])) as Record<string, unknown>
  );
  const bindings = wireBindings(
    input.steward,
    grant.circleId,
    input.stewardVaultId,
    input.identitySeed,
    new Date().toISOString()
  );
  const memberStates = input.steward
    .prepare(
      "SELECT * FROM share_commons_member_state WHERE grant_id = ? ORDER BY party_id"
    )
    .all(grant.grantId) as Record<string, unknown>[];
  return {
    grantId: grant.grantId,
    stewardVaultId: input.stewardVaultId,
    memberVaultId: input.memberVaultId,
    fromSequence: input.afterSequence,
    currentSequence: grant.lastSequence,
    ops,
    receipts,
    replay,
    control: {
      grant: grantRow,
      circle,
      members,
      memberStates,
      parties,
      bindings,
    },
    blobs: commonsTailBlobs(
      input.steward,
      readCommonsTail(input.steward, grant.grantId, input.afterSequence)
    ),
  };
}

/** A removed member learns only the tombstone, never the closure it no longer holds. */
export function exportCommonsSyncFrame(input: {
  steward: DatabaseSync;
  stewardVaultId: string;
  grantId: string;
  memberVaultId: string;
  identitySeed: Buffer;
  /** On the retained op chain, this makes the frame an increment (#750). */
  afterSequence?: number;
}): CommonsSyncFrame {
  const grant = readCommonsGrant(input.steward, input.grantId);
  const bound = input.steward
    .prepare(
      `SELECT party_id FROM share_party_vault_binding
        WHERE vault_id = ? AND revoked_at IS NULL`
    )
    .get(input.memberVaultId) as { party_id: string } | undefined;
  if (!bound) throw new Error("member vault was never bound to this commons");
  const currentMember = input.steward
    .prepare(
      "SELECT 1 AS n FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
    )
    .get(grant.circleId, bound.party_id);
  const historicalMember =
    currentMember ??
    input.steward
      .prepare(
        `SELECT 1 AS n FROM share_commons_op
          WHERE grant_id = ? AND kind = 'member_removed'
            AND json_extract(input_json, '$.partyId') = ? LIMIT 1`
      )
      .get(grant.grantId, bound.party_id);
  if (!historicalMember)
    throw new Error("member vault was never joined to this commons");
  if (grant.revokedAt || !currentMember)
    return {
      state: "tombstone",
      tombstone: {
        grantId: grant.grantId,
        memberVaultId: input.memberVaultId,
        currentSequence: grant.lastSequence,
        reason: grant.revokedAt ? "grant_revoked" : "member_removed",
      },
    };
  if (input.afterSequence !== undefined) {
    const increment = exportCommonsIncrement({
      steward: input.steward,
      stewardVaultId: input.stewardVaultId,
      grantId: input.grantId,
      memberVaultId: input.memberVaultId,
      afterSequence: input.afterSequence,
      identitySeed: input.identitySeed,
    });
    if (increment) return { state: "increment", increment };
  }
  return { state: "bootstrap", wire: exportCommonsBootstrap(input) };
}

export function applyCommonsTombstone(input: {
  seat: ShareVaultRef;
  tombstone: CommonsTombstone;
}): number {
  const localVaultId = input.seat.vault
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string } | undefined;
  if (localVaultId?.vault_id !== input.tombstone.memberVaultId)
    throw new Error("commons tombstone targets another vault");
  return removeCommonsFromSeat({
    seat: input.seat,
    grantId: input.tombstone.grantId,
  });
}

function projectControl(db: DatabaseSync, wire: CommonsBootstrap): void {
  const parties = db.prepare(
    // No `ontology_version` (#916, ruling ONT-04): the version is a property
    // of the file and of the command contract, never of a projected row. A
    // wire payload from a peer on an older build may still carry the key; it
    // is simply not read.
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(party_id) DO UPDATE SET
       kind = excluded.kind, display_name = excluded.display_name,
       sort_name = excluded.sort_name, birth_date = excluded.birth_date,
       updated_at = excluded.updated_at`
  );
  for (const party of wire.control.parties)
    parties.run(
      sql(party["party_id"]),
      sql(party["kind"]),
      sql(party["display_name"]),
      sql(party["sort_name"]),
      sql(party["birth_date"]),
      sql(party["created_at"]),
      sql(party["updated_at"])
    );
  const circle = wire.control.circle;
  db.prepare(
    `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(circle_id) DO UPDATE SET
       owner_party_id = excluded.owner_party_id,
       name = excluded.name, kind = excluded.kind`
  ).run(
    sql(circle["circle_id"]),
    sql(circle["owner_party_id"]),
    sql(circle["name"]),
    sql(circle["kind"])
  );
  db.prepare("DELETE FROM social_circle_member WHERE circle_id = ?").run(
    sql(circle["circle_id"])
  );
  const member = db.prepare(
    `INSERT INTO social_circle_member
       (member_id, circle_id, party_id, added_at, capability)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const row of wire.control.members)
    member.run(
      sql(row["member_id"]),
      sql(row["circle_id"]),
      sql(row["party_id"]),
      sql(row["added_at"]),
      sql(row["capability"])
    );
  for (const row of wire.control.bindings) {
    if (
      isSelfBinding(
        db,
        sql(row["party_id"]) as string,
        sql(row["vault_id"]) as string
      )
    )
      continue;
    db.prepare(
      `INSERT INTO share_party_vault_binding
         (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(party_id, vault_id) DO UPDATE SET
         vault_public_key = excluded.vault_public_key,
         linked_at = excluded.linked_at, revoked_at = excluded.revoked_at`
    ).run(
      sql(row["binding_id"]),
      sql(row["party_id"]),
      sql(row["vault_id"]),
      sql(row["vault_public_key"]),
      sql(row["linked_at"]),
      sql(row["revoked_at"])
    );
  }
  const grant = wire.control.grant;
  db.prepare(
    `INSERT INTO share_circle_grant
       (grant_id, circle_id, container_type, container_id, plane,
        departure_policy, implicit_circle, steward_party_id, created_at,
        revoked_at, last_sequence, checkpoint_sequence, checkpoint_json,
        chain_head_sequence, chain_head_hash, max_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id) DO UPDATE SET
       circle_id = excluded.circle_id,
       container_type = excluded.container_type,
       container_id = excluded.container_id, plane = excluded.plane,
       departure_policy = excluded.departure_policy,
       implicit_circle = excluded.implicit_circle,
       steward_party_id = excluded.steward_party_id,
       created_at = excluded.created_at, revoked_at = excluded.revoked_at,
       last_sequence = excluded.last_sequence,
       checkpoint_sequence = excluded.checkpoint_sequence,
       checkpoint_json = excluded.checkpoint_json,
       chain_head_sequence = excluded.chain_head_sequence,
       chain_head_hash = excluded.chain_head_hash,
       max_size_bytes = excluded.max_size_bytes`
  ).run(
    sql(grant["grant_id"]),
    sql(grant["circle_id"]),
    sql(grant["container_type"]),
    sql(grant["container_id"]),
    sql(grant["plane"]),
    sql(grant["departure_policy"]),
    sql(grant["implicit_circle"]),
    sql(grant["steward_party_id"]),
    sql(grant["created_at"]),
    sql(grant["revoked_at"]),
    wire.currentSequence,
    wire.snapshotSequence,
    JSON.stringify(wire.closure),
    sql(grant["chain_head_sequence"]),
    sql(grant["chain_head_hash"]),
    sql(grant["max_size_bytes"])
  );
  db.prepare("DELETE FROM share_commons_member_state WHERE grant_id = ?").run(
    wire.grantId
  );
  const state = db.prepare(
    `INSERT INTO share_commons_member_state
       (grant_id, party_id, status, accepted_at) VALUES (?, ?, ?, ?)`
  );
  for (const row of wire.control.memberStates)
    state.run(
      sql(row["grant_id"]),
      sql(row["party_id"]),
      sql(row["status"]),
      sql(row["accepted_at"])
    );
  db.prepare("DELETE FROM share_commons_replay WHERE grant_id = ?").run(
    wire.grantId
  );
  const replay = db.prepare(
    `INSERT INTO share_commons_replay
       (grant_id, signing_vault_id, signature_nonce, sequence, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const row of wire.control.replay)
    replay.run(
      sql(row["grant_id"]),
      sql(row["signing_vault_id"]),
      sql(row["signature_nonce"]),
      sql(row["sequence"]),
      sql(row["outcome"]),
      sql(row["reason"])
    );
  db.prepare("DELETE FROM share_commons_receipt WHERE grant_id = ?").run(
    wire.grantId
  );
  const receipt = db.prepare(
    `INSERT INTO share_commons_receipt
       (grant_id, sequence, kind, actor_party_id, outcome, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of wire.control.receipts)
    receipt.run(
      sql(row["grant_id"]),
      sql(row["sequence"]),
      sql(row["kind"]),
      sql(row["actor_party_id"]),
      sql(row["outcome"]),
      sql(row["reason"]),
      sql(row["created_at"])
    );
}

function projectTail(db: DatabaseSync, wire: CommonsBootstrap): void {
  db.prepare(
    "DELETE FROM share_commons_op WHERE grant_id = ? AND sequence <= ?"
  ).run(wire.grantId, wire.snapshotSequence);
  const insert = db.prepare(
    `INSERT INTO share_commons_op
       (grant_id, sequence, op_id, kind, actor_party_id, command, input_json,
        member_signature, signing_vault_id, signature_nonce, outcome, reason,
        created_at, prev_hash, op_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id, sequence) DO NOTHING`
  );
  for (const row of wire.tail)
    insert.run(
      sql(row["grant_id"]),
      sql(row["sequence"]),
      sql(row["op_id"]),
      sql(row["kind"]),
      sql(row["actor_party_id"]),
      sql(row["command"]),
      sql(row["input_json"]),
      sql(row["member_signature"]),
      sql(row["signing_vault_id"]),
      sql(row["signature_nonce"]),
      sql(row["outcome"]),
      sql(row["reason"]),
      sql(row["created_at"]),
      ...chainColumns(row)
    );
}

export function applyCommonsBootstrap(input: {
  seat: ShareVaultRef;
  wire: CommonsBootstrap;
  now: string;
}): void {
  const seatDb = input.seat.vault;
  const localVaultId = seatDb
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string } | undefined;
  if (localVaultId?.vault_id !== input.wire.memberVaultId)
    throw new Error("commons bootstrap targets another vault");
  // Never move a seat backward (#731): a stale frame is dropped before any write.
  const cursor = seatDb
    .prepare(
      `SELECT sequence FROM share_commons_cursor
        WHERE grant_id = ? AND member_vault_id = ?`
    )
    .get(input.wire.grantId, input.wire.memberVaultId) as
    | { sequence: number }
    | undefined;
  if (cursor && input.wire.currentSequence < cursor.sequence) return;
  const retained = seatDb
    .prepare(
      "SELECT 1 AS n FROM share_commons_retained WHERE grant_id = ? LIMIT 1"
    )
    .get(input.wire.grantId);
  // Fail closed BEFORE the destructive scrub (#731): a closure this build
  // cannot project must PARK with the prior replica intact, never scrub first
  // and throw, which would strand the member empty. Retained seats project none.
  if (!retained && input.wire.closure.formatVersion !== CLOSURE_FORMAT_VERSION)
    throw new VaultShareError(
      `unsupported share closure format ${String(
        input.wire.closure.formatVersion
      )}`
    );
  // Same fail-closed shape for history (#731): a tampered op, a forked chain
  // or a rewound log parks BEFORE the scrub, replica untouched.
  const history = verifyCommonsFrameHistory({
    seat: seatDb,
    grantId: input.wire.grantId,
    stewardVaultId: input.wire.stewardVaultId,
    currentSequence: input.wire.currentSequence,
    snapshotSequence: input.wire.snapshotSequence,
    tail: input.wire.tail,
    checkpoint: input.wire.checkpoint,
    bindings: input.wire.control.bindings,
  });
  // Scrub, re-project, control, tail, lineage and cursor are ONE atomic unit: a
  // crash between scrub and re-projection must never leave the commons deleted.
  // Nested under a savepoint when the caller already owns the transaction.
  const nested = seatDb.isTransaction;
  seatDb.exec(nested ? "SAVEPOINT apply_commons_bootstrap" : "BEGIN IMMEDIATE");
  try {
    removeCommonsFromSeat({
      seat: input.seat,
      grantId: input.wire.grantId,
      preserveControlState: true,
    });
    const projection = retained
      ? { items: [] }
      : projectShareClosure(seatDb, input.wire.closure, {
          sharedBy: `commons:${input.wire.grantId}`,
          now: () => Date.parse(input.now),
        });
    projectControl(seatDb, input.wire);
    seatDb
      .prepare(
        `INSERT INTO core_share_origin
           (target_type, target_id, origin_vault_id, origin_item_id,
            shared_by, shared_at)
         VALUES ('social.circle', ?, ?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           origin_vault_id = excluded.origin_vault_id,
           origin_item_id = excluded.origin_item_id,
           shared_by = excluded.shared_by,
           shared_at = excluded.shared_at`
      )
      .run(
        sql(input.wire.control.circle["circle_id"]),
        input.wire.stewardVaultId,
        sql(input.wire.control.circle["circle_id"]),
        `commons:${input.wire.grantId}`,
        Date.parse(input.now)
      );
    projectTail(seatDb, input.wire);
    const lineage = seatDb.prepare(
      `INSERT INTO share_commons_lineage
         (grant_id, target_type, target_id, origin_item_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id, target_type, target_id) DO NOTHING`
    );
    for (const item of projection.items)
      lineage.run(
        input.wire.grantId,
        shareOriginEntityType(item.itemType),
        item.itemId,
        item.originItemId
      );
    seatDb
      .prepare(
        `INSERT INTO share_commons_cursor
           (grant_id, member_vault_id, sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
           sequence = MAX(sequence, excluded.sequence),
           updated_at = excluded.updated_at`
      )
      .run(
        input.wire.grantId,
        input.wire.memberVaultId,
        input.wire.currentSequence,
        input.now
      );
    // Recomputed over what this seat STORED, in the same transaction: a
    // mismatch rolls the whole apply back.
    assertCommonsStateDigest({
      seat: seatDb,
      grantId: input.wire.grantId,
      expected: history.stateDigest,
    });
    recordCommonsVerified({
      db: seatDb,
      grantId: input.wire.grantId,
      sequence: history.verified.sequence,
      opHash: history.verified.opHash,
      now: input.now,
    });
    seatDb.exec(nested ? "RELEASE apply_commons_bootstrap" : "COMMIT");
  } catch (error) {
    seatDb.exec(nested ? "ROLLBACK TO apply_commons_bootstrap" : "ROLLBACK");
    if (nested) seatDb.exec("RELEASE apply_commons_bootstrap");
    throw error;
  }
}

/** The grant row is refreshed WITHOUT the stored checkpoint pair: an increment
 * moves the head, never the baseline. */
function projectIncrementControl(
  db: DatabaseSync,
  increment: CommonsIncrement
): void {
  const control = increment.control;
  const parties = db.prepare(
    // No `ontology_version` (#916, ruling ONT-04): the version is a property
    // of the file and of the command contract, never of a projected row. A
    // wire payload from a peer on an older build may still carry the key; it
    // is simply not read.
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(party_id) DO UPDATE SET
       kind = excluded.kind, display_name = excluded.display_name,
       sort_name = excluded.sort_name, birth_date = excluded.birth_date,
       updated_at = excluded.updated_at`
  );
  for (const party of control.parties)
    parties.run(
      sql(party["party_id"]),
      sql(party["kind"]),
      sql(party["display_name"]),
      sql(party["sort_name"]),
      sql(party["birth_date"]),
      sql(party["created_at"]),
      sql(party["updated_at"])
    );
  const circle = control.circle;
  db.prepare(
    `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(circle_id) DO UPDATE SET
       owner_party_id = excluded.owner_party_id,
       name = excluded.name, kind = excluded.kind`
  ).run(
    sql(circle["circle_id"]),
    sql(circle["owner_party_id"]),
    sql(circle["name"]),
    sql(circle["kind"])
  );
  db.prepare("DELETE FROM social_circle_member WHERE circle_id = ?").run(
    sql(circle["circle_id"])
  );
  const member = db.prepare(
    `INSERT INTO social_circle_member
       (member_id, circle_id, party_id, added_at, capability)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const row of control.members)
    member.run(
      sql(row["member_id"]),
      sql(row["circle_id"]),
      sql(row["party_id"]),
      sql(row["added_at"]),
      sql(row["capability"])
    );
  for (const row of control.bindings) {
    if (
      isSelfBinding(
        db,
        sql(row["party_id"]) as string,
        sql(row["vault_id"]) as string
      )
    )
      continue;
    db.prepare(
      `INSERT INTO share_party_vault_binding
         (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(party_id, vault_id) DO UPDATE SET
         vault_public_key = excluded.vault_public_key,
         linked_at = excluded.linked_at, revoked_at = excluded.revoked_at`
    ).run(
      sql(row["binding_id"]),
      sql(row["party_id"]),
      sql(row["vault_id"]),
      sql(row["vault_public_key"]),
      sql(row["linked_at"]),
      sql(row["revoked_at"])
    );
  }
  const grant = control.grant;
  db.prepare(
    `UPDATE share_circle_grant SET
       circle_id = ?, container_type = ?, container_id = ?, plane = ?,
       departure_policy = ?, implicit_circle = ?, steward_party_id = ?,
       created_at = ?, revoked_at = ?, last_sequence = ?,
       chain_head_sequence = ?, chain_head_hash = ?, max_size_bytes = ?
     WHERE grant_id = ?`
  ).run(
    sql(grant["circle_id"]),
    sql(grant["container_type"]),
    sql(grant["container_id"]),
    sql(grant["plane"]),
    sql(grant["departure_policy"]),
    sql(grant["implicit_circle"]),
    sql(grant["steward_party_id"]),
    sql(grant["created_at"]),
    sql(grant["revoked_at"]),
    increment.currentSequence,
    sql(grant["chain_head_sequence"]),
    sql(grant["chain_head_hash"]),
    sql(grant["max_size_bytes"]),
    increment.grantId
  );
  db.prepare("DELETE FROM share_commons_member_state WHERE grant_id = ?").run(
    increment.grantId
  );
  const state = db.prepare(
    `INSERT INTO share_commons_member_state
       (grant_id, party_id, status, accepted_at) VALUES (?, ?, ?, ?)`
  );
  for (const row of control.memberStates)
    state.run(
      sql(row["grant_id"]),
      sql(row["party_id"]),
      sql(row["status"]),
      sql(row["accepted_at"])
    );
  const replay = db.prepare(
    `INSERT INTO share_commons_replay
       (grant_id, signing_vault_id, signature_nonce, sequence, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id, signing_vault_id, signature_nonce) DO NOTHING`
  );
  for (const row of increment.replay)
    replay.run(
      sql(row["grant_id"]),
      sql(row["signing_vault_id"]),
      sql(row["signature_nonce"]),
      sql(row["sequence"]),
      sql(row["outcome"]),
      sql(row["reason"])
    );
  const receipt = db.prepare(
    `INSERT INTO share_commons_receipt
       (grant_id, sequence, kind, actor_party_id, outcome, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id, sequence) DO NOTHING`
  );
  for (const row of increment.receipts)
    receipt.run(
      sql(row["grant_id"]),
      sql(row["sequence"]),
      sql(row["kind"]),
      sql(row["actor_party_id"]),
      sql(row["outcome"]),
      sql(row["reason"]),
      sql(row["created_at"])
    );
}

/**
 * Operations this seat's DOMAIN state stands on top of the last sequence it
 * proved against the steward's signed digest. At a member `checkpoint_sequence`
 * is exactly that proven point, and everything after it is unproven.
 */
function unprovenStateRun(
  seat: DatabaseSync,
  increment: CommonsIncrement
): number {
  return (
    increment.currentSequence -
    readCommonsGrant(seat, increment.grantId).checkpointSequence
  );
}

/**
 * Apply an increment (#750 invariant 7) by REPLAYING its executable tail,
 * verified against this seat's own proven head before any write. A
 * diverged/forked/tampered frame PARKS like a bad full frame; anything that
 * merely does not fit this replica throws `CommonsIncrementUnusableError`,
 * meaning "re-pull the full frame" with the replica untouched. Replay, control
 * projection, op insert, cursor advance and the verified point are ONE
 * transaction — a partially replayed tail is not a state any seat may keep.
 *
 * THE CHAIN PROVES THE HISTORY, NEVER THE ROWS THE REPLAY PRODUCED. No member
 * can recompute the attested digest, which hashes the STEWARD's closure bytes
 * while a member's projection re-owns and re-ids what it stores; a
 * per-operation digest would cost O(commons size) per write, the very thing
 * invariant 7 removes. So state proof is CHECKPOINT-BOUNDED BY REFUSAL: a seat
 * may stand at most `COMMONS_CHECKPOINT_INTERVAL` ops on top of its last proven
 * state, then the increment is refused and the caller re-baselines through the
 * full frame, whose digest IS asserted. Between those points the replica is
 * history-verified but NOT state-verified: divergence is bounded, not detected.
 */
export function applyCommonsIncrement(input: {
  seat: ShareVaultRef;
  increment: CommonsIncrement;
  now: string;
  /** Without one this replica cannot replay: every increment is unusable. */
  applyCommand?: CommonsReplicaExecutor;
}): void {
  const seatDb = input.seat.vault;
  const increment = input.increment;
  const localVaultId = seatDb
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string } | undefined;
  if (localVaultId?.vault_id !== increment.memberVaultId)
    throw new Error("commons increment targets another vault");
  const cursor = seatDb
    .prepare(
      `SELECT sequence FROM share_commons_cursor
        WHERE grant_id = ? AND member_vault_id = ?`
    )
    .get(increment.grantId, increment.memberVaultId) as
    | { sequence: number }
    | undefined;
  // The cursor IS the replay idempotency boundary (#750): it advances in the
  // same transaction as its tail, so a redelivered frame is a no-op.
  if (cursor && increment.currentSequence <= cursor.sequence) return;
  const verified = readCommonsVerified(seatDb, increment.grantId);
  if (!verified || verified.sequence !== increment.fromSequence)
    throw new CommonsIncrementUnusableError(
      `commons increment starts at ${increment.fromSequence}, not this seat's verified head ${String(verified?.sequence)}`
    );
  const hasProjection = seatDb
    .prepare(
      "SELECT 1 AS n FROM share_commons_lineage WHERE grant_id = ? LIMIT 1"
    )
    .get(increment.grantId);
  const retained = seatDb
    .prepare(
      "SELECT 1 AS n FROM share_commons_retained WHERE grant_id = ? LIMIT 1"
    )
    .get(increment.grantId);
  if (!hasProjection && !retained)
    throw new CommonsIncrementUnusableError(
      "commons increment needs an existing projection to apply onto"
    );
  // A retained root is receiver-authored: nothing replays onto it, so it needs
  // no executor; every other seat does.
  if (!retained && !input.applyCommand)
    throw new CommonsIncrementUnusableError(
      "commons increment needs a replica command executor to replay its tail"
    );
  // Fail closed BEFORE any write: a chain that does not extend this seat's
  // proven head parks with the replica untouched.
  const proven = verifyCommonsIncrementHistory({
    seat: seatDb,
    grantId: increment.grantId,
    anchor: verified,
    currentSequence: increment.currentSequence,
    ops: increment.ops,
  });
  // Refuse BEFORE any write: a seat a full checkpoint interval past its last
  // proven state re-baselines instead of piling on another unproven op. A
  // retained root is exempt — the steward's digest never covered those rows.
  const unproven = retained ? 0 : unprovenStateRun(seatDb, increment);
  if (unproven >= COMMONS_CHECKPOINT_INTERVAL)
    throw new CommonsIncrementUnusableError(
      `commons increment would stand ${unproven} operations past this seat's last proven state`
    );
  // Bytes claimed by sha cannot be re-derived from a command's input, so the
  // caller has already placed them in CAS; only staging rows are written here.
  const tail = increment.ops.map((row) => ({
    sequence: Number(row["sequence"]),
    kind: String(row["kind"]),
    command: (row["command"] ?? null) as string | null,
    input_json: (row["input_json"] ?? null) as string | null,
    outcome: String(row["outcome"]),
  }));
  const nested = seatDb.isTransaction;
  seatDb.exec(nested ? "SAVEPOINT apply_commons_increment" : "BEGIN IMMEDIATE");
  try {
    const replicaCommit = beginReplicaCommit(seatDb);
    // Control truth still flows onto a retained root; commands never re-execute.
    if (!retained) {
      stageCommonsTailBlobs(seatDb, increment.blobs);
      replayCommonsTail({
        grantId: increment.grantId,
        tail,
        execute: input.applyCommand!,
      });
    }
    projectIncrementControl(seatDb, increment);
    const insertOp = seatDb.prepare(
      `INSERT INTO share_commons_op
         (grant_id, sequence, op_id, kind, actor_party_id, command, input_json,
          member_signature, signing_vault_id, signature_nonce, outcome, reason,
          created_at, prev_hash, op_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id, sequence) DO NOTHING`
    );
    for (const row of increment.ops)
      insertOp.run(
        sql(row["grant_id"]),
        sql(row["sequence"]),
        sql(row["op_id"]),
        sql(row["kind"]),
        sql(row["actor_party_id"]),
        sql(row["command"]),
        sql(row["input_json"]),
        sql(row["member_signature"]),
        sql(row["signing_vault_id"]),
        sql(row["signature_nonce"]),
        sql(row["outcome"]),
        sql(row["reason"]),
        sql(row["created_at"]),
        ...chainColumns(row)
      );
    // Increments must not let the op replica grow forever: same retention floor
    // as the steward, and the verified point outlives the pruned rows.
    seatDb
      .prepare(
        "DELETE FROM share_commons_op WHERE grant_id = ? AND sequence <= ?"
      )
      .run(
        increment.grantId,
        increment.currentSequence - COMMONS_OP_RETENTION_FLOOR
      );
    seatDb
      .prepare(
        `INSERT INTO share_commons_cursor
           (grant_id, member_vault_id, sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
           sequence = MAX(sequence, excluded.sequence),
           updated_at = excluded.updated_at`
      )
      .run(
        increment.grantId,
        increment.memberVaultId,
        increment.currentSequence,
        input.now
      );
    recordCommonsVerified({
      db: seatDb,
      grantId: increment.grantId,
      sequence: proven.sequence,
      opHash: proven.opHash,
      now: input.now,
    });
    endReplicaCommit(seatDb, replicaCommit);
    seatDb.exec(nested ? "RELEASE apply_commons_increment" : "COMMIT");
  } catch (error) {
    seatDb.exec(nested ? "ROLLBACK TO apply_commons_increment" : "ROLLBACK");
    if (nested) seatDb.exec("RELEASE apply_commons_increment");
    // A tail this replica could not re-execute is a re-baseline signal, not a
    // fault, and deliberately NOT a park: the steward's history verified fine.
    if (isCommonsReplayError(error))
      throw new CommonsIncrementUnusableError(error.message);
    throw error;
  }
}
