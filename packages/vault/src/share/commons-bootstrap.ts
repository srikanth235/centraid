// governance: allow-repo-hygiene file-size-limit (#731) snapshot/tail export, invitation consent, CAS bytes, tombstones, and atomic apply form one peer bootstrap integrity boundary.
// Snapshot + tail wire for peer Commons catch-up. The snapshot is a complete
// domain closure at sequence N; the tail is the ordered audit/control stream
// after N. Blob bytes travel separately by sha and are verified by CAS.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import { uuidv7 } from "../ids.js";
import { placeBlob } from "./blobs.js";
import { CLOSURE_FORMAT_VERSION } from "./closure.js";
import type { WireClosure } from "./closure.js";
import {
  commonsClosure,
  readCommonsGrant,
  removeCommonsFromSeat,
} from "./commons.js";
import type { ShareVaultRef } from "./placement.js";
import { projectShareClosure } from "./project-closure.js";

export interface CommonsBootstrap {
  grantId: string;
  stewardVaultId: string;
  memberVaultId: string;
  snapshotSequence: number;
  currentSequence: number;
  closure: WireClosure;
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

export type CommonsSyncFrame =
  | { state: "bootstrap"; wire: CommonsBootstrap }
  | { state: "tombstone"; tombstone: CommonsTombstone };

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

/** Persist peer consent metadata without projecting any Commons domain row. */
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

/** Mint the bearer capability for a named party that has no vault yet. Only
 * its hash is durable/exported; the raw token is returned once to put in an
 * invite URI. Claiming still requires an authenticated approved vault link. */
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

export function exportCommonsBootstrap(input: {
  steward: DatabaseSync;
  stewardVaultId: string;
  grantId: string;
  memberVaultId: string;
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
  const bindings = input.steward
    .prepare(
      `SELECT * FROM share_party_vault_binding
        WHERE party_id IN (
          SELECT party_id FROM social_circle_member WHERE circle_id = ?
        )`
    )
    .all(grant.circleId) as Record<string, unknown>[];
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
  // An executed domain command makes the old checkpoint's rows stale. Build
  // a new complete snapshot in this background/peer-sync path; refused and
  // control-only tail entries remain cheap deterministic tail application.
  if (
    tail.some(
      (row) =>
        row["outcome"] === "executed" &&
        (row["kind"] === "command" || row["kind"] === "delete")
    )
  ) {
    closure = commonsClosure(input.steward, input.stewardVaultId, grant);
    snapshotSequence = grant.lastSequence;
    tail = [];
  }
  return {
    grantId: grant.grantId,
    stewardVaultId: input.stewardVaultId,
    memberVaultId: input.memberVaultId,
    snapshotSequence,
    currentSequence: grant.lastSequence,
    closure,
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

/** Historical bindings authorize a removed member to learn only the
 * going-forward tombstone, never the closure they no longer hold. */
export function exportCommonsSyncFrame(input: {
  steward: DatabaseSync;
  stewardVaultId: string;
  grantId: string;
  memberVaultId: string;
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
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at, ontology_version)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(party_id) DO UPDATE SET
       kind = excluded.kind, display_name = excluded.display_name,
       sort_name = excluded.sort_name, birth_date = excluded.birth_date,
       updated_at = excluded.updated_at,
       ontology_version = excluded.ontology_version`
  );
  for (const party of wire.control.parties)
    parties.run(
      sql(party["party_id"]),
      sql(party["kind"]),
      sql(party["display_name"]),
      sql(party["sort_name"]),
      sql(party["birth_date"]),
      sql(party["created_at"]),
      sql(party["updated_at"]),
      sql(party["ontology_version"])
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
  for (const row of wire.control.bindings)
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
  const grant = wire.control.grant;
  db.prepare(
    `INSERT INTO share_circle_grant
       (grant_id, circle_id, container_type, container_id, plane,
        departure_policy, implicit_circle, steward_party_id, created_at,
        revoked_at, last_sequence, checkpoint_sequence, checkpoint_json,
        max_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      sql(row["created_at"])
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
  // Never move a seat backward (issue #731). A delayed or stale frame whose
  // head is behind what this seat already holds must not regress its state, so
  // drop it before touching anything.
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
  // Fail closed BEFORE the destructive scrub (issue #731). A closure from a
  // format this build cannot project must PARK — leave the prior replica intact
  // and let the caller surface unavailable — never scrub first and then throw,
  // which would strand the member empty and re-fail every sweep. Retained seats
  // project no closure, so this only guards the projecting path.
  if (!retained && input.wire.closure.formatVersion !== CLOSURE_FORMAT_VERSION)
    throw new VaultShareError(
      `unsupported share closure format ${String(
        input.wire.closure.formatVersion
      )}`
    );
  // Scrub + re-project + control + tail + lineage + cursor are ONE atomic unit:
  // a crash between the scrub and the re-projection must never leave the commons
  // deleted on disk. Nest under a savepoint when a caller already owns the seat
  // transaction so we never double-open BEGIN.
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
           (item_type, item_id, origin_vault_id, origin_item_id,
            shared_by, shared_at)
         VALUES ('social.circle', ?, ?, ?, ?, ?)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
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
         (grant_id, item_type, item_id, origin_item_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id, item_type, item_id) DO NOTHING`
    );
    for (const item of projection.items)
      lineage.run(
        input.wire.grantId,
        item.itemType,
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
    seatDb.exec(nested ? "RELEASE apply_commons_bootstrap" : "COMMIT");
  } catch (error) {
    seatDb.exec(nested ? "ROLLBACK TO apply_commons_bootstrap" : "ROLLBACK");
    if (nested) seatDb.exec("RELEASE apply_commons_bootstrap");
    throw error;
  }
}

/** Same-machine test/transport helper: place the snapshot's bytes by sha. */
export function placeCommonsBootstrapBlobs(input: {
  source: ShareVaultRef;
  seat: ShareVaultRef;
  wire: CommonsBootstrap;
}): void {
  for (const blob of input.wire.closure.blobs)
    placeBlob(input.source.blobs.local, input.seat.blobs.local, blob.sha256);
}
