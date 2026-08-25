// Verifiable commons history (#731). The steward's per-grant op log is a
// hash chain; every checkpoint carries a signed digest of the projected state.
// A member verifies both before it applies anything, so a steward that rewound
// (restore-from-backup), forked, or shipped a mutated op becomes a NAMED fault
// instead of silent divergence.

import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import {
  signWithVaultIdentity,
  verifyVaultIdentitySignature,
} from "../schema/vault-identity.js";

const OP_DOMAIN = "centraid:commons-op-chain:v1";
const CHECKPOINT_DOMAIN = "centraid:commons-checkpoint:v1";
const STATE_DOMAIN = "centraid:commons-state:v1";
const GENESIS_DOMAIN = "centraid:commons-chain-genesis:v1";

/** The two ways a member can find the steward's history unusable. Both PARK
 * the grant: the replica is left exactly as it was, never scrubbed. */
export type CommonsHistoryFaultTag = "history-diverged" | "digest-mismatch";

export class CommonsHistoryError extends VaultShareError {
  constructor(
    readonly fault: CommonsHistoryFaultTag,
    message: string
  ) {
    super(message);
    this.name = "CommonsHistoryError";
  }
}

export function isCommonsHistoryError(
  error: unknown
): error is CommonsHistoryError {
  return error instanceof CommonsHistoryError;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)])
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

/** The chain's genesis: what sequence 1 links back to. Every grant is chained
 * from its creation, so this is the only unlinked hash in a commons history. */
export function commonsGenesisHash(grantId: string): string {
  return sha256({ domain: GENESIS_DOMAIN, grantId });
}

/** The op fields the chain commits to. Text columns travel verbatim (never
 * re-serialized) so steward and member hash byte-identical inputs. */
export interface CommonsOpChainFields {
  grantId: string;
  sequence: number;
  opId: string;
  kind: string;
  actorPartyId: string;
  command: string | null;
  inputJson: string | null;
  memberSignature: string | null;
  signingVaultId: string | null;
  signatureNonce: string | null;
  outcome: string;
  reason: string | null;
  createdAt: string;
}

export function commonsOpHash(
  prevHash: string,
  fields: CommonsOpChainFields
): string {
  return sha256({ domain: OP_DOMAIN, prevHash, ...fields });
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Chain fields read off a raw `share_commons_op` row (steward or wire). */
export function commonsOpChainFields(
  row: Record<string, unknown>
): CommonsOpChainFields {
  return {
    grantId: String(row["grant_id"]),
    sequence: Number(row["sequence"]),
    opId: String(row["op_id"]),
    kind: String(row["kind"]),
    actorPartyId: String(row["actor_party_id"]),
    command: text(row["command"]),
    inputJson: text(row["input_json"]),
    memberSignature: text(row["member_signature"]),
    signingVaultId: text(row["signing_vault_id"]),
    signatureNonce: text(row["signature_nonce"]),
    outcome: String(row["outcome"]),
    reason: text(row["reason"]),
    createdAt: String(row["created_at"]),
  };
}

export interface CommonsChainHead {
  sequence: number;
  hash: string;
}

/** The head survives compaction: it lives on the grant row, not on the last
 * surviving op, so pruning the verbose tail never loses the chain. */
export function readCommonsChainHead(
  db: DatabaseSync,
  grantId: string
): CommonsChainHead {
  const row = db
    .prepare(
      `SELECT chain_head_sequence, chain_head_hash
         FROM share_circle_grant WHERE grant_id = ?`
    )
    .get(grantId) as
    | { chain_head_sequence: number; chain_head_hash: string }
    | undefined;
  if (!row) throw new Error(`commons grant ${grantId} is not available`);
  return {
    sequence: Number(row.chain_head_sequence),
    hash: row.chain_head_hash,
  };
}

/** Insert one op already chained to the grant's head and advance both the
 * logical sequence and the chain head in the same statement pair. */
export function insertChainedCommonsOp(
  db: DatabaseSync,
  fields: CommonsOpChainFields
): string {
  const head = readCommonsChainHead(db, fields.grantId);
  const opHash = commonsOpHash(head.hash, fields);
  db.prepare(
    `INSERT INTO share_commons_op
       (grant_id, sequence, op_id, kind, actor_party_id, command,
        input_json, member_signature, signing_vault_id, signature_nonce,
        outcome, reason, created_at, prev_hash, op_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fields.grantId,
    fields.sequence,
    fields.opId,
    fields.kind,
    fields.actorPartyId,
    fields.command,
    fields.inputJson,
    fields.memberSignature,
    fields.signingVaultId,
    fields.signatureNonce,
    fields.outcome,
    fields.reason,
    fields.createdAt,
    head.hash,
    opHash
  );
  db.prepare(
    `UPDATE share_circle_grant
        SET last_sequence = ?, chain_head_sequence = ?, chain_head_hash = ?
      WHERE grant_id = ?`
  ).run(fields.sequence, fields.sequence, opHash, fields.grantId);
  return opHash;
}

/** SHA-256 over the canonical form of the closure the steward projects. The
 * member digests the same closure it stored, so the two agree byte for byte
 * without either side re-deriving the other's row order. */
export function commonsStateDigest(closure: unknown): string {
  return sha256({ domain: STATE_DOMAIN, closure });
}

export interface CommonsCheckpointAttestation {
  sequence: number;
  opHash: string;
  stateDigest: string;
  signerVaultId: string;
  signature: string;
}

/** Exactly the fields the steward attests to — never the seed or the
 * signature itself, which are not part of what is being signed. */
function checkpointBytes(input: {
  grantId: string;
  sequence: number;
  opHash: string;
  stateDigest: string;
  signerVaultId: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify(
      canonical({
        domain: CHECKPOINT_DOMAIN,
        grantId: input.grantId,
        sequence: input.sequence,
        opHash: input.opHash,
        stateDigest: input.stateDigest,
        signerVaultId: input.signerVaultId,
      })
    ),
    "utf8"
  );
}

export function attestCommonsCheckpoint(input: {
  identitySeed: Buffer;
  signerVaultId: string;
  grantId: string;
  sequence: number;
  opHash: string;
  stateDigest: string;
}): CommonsCheckpointAttestation {
  return {
    sequence: input.sequence,
    opHash: input.opHash,
    stateDigest: input.stateDigest,
    signerVaultId: input.signerVaultId,
    signature: signWithVaultIdentity(
      input.identitySeed,
      checkpointBytes(input)
    ).toString("base64"),
  };
}

export function verifyCommonsCheckpoint(
  publicKey: Buffer,
  grantId: string,
  attestation: CommonsCheckpointAttestation
): boolean {
  try {
    const signature = Buffer.from(attestation.signature, "base64");
    return (
      publicKey.length === 32 &&
      signature.length === 64 &&
      verifyVaultIdentitySignature(
        publicKey,
        checkpointBytes({ grantId, ...attestation }),
        signature
      )
    );
  } catch {
    return false;
  }
}

/** Sign the (op_hash, state_digest, sequence) triple for a snapshot the
 * steward is about to store or ship. A snapshot that cannot be attested is
 * never shipped unsigned — it is a steward-side failure. */
export function signCommonsCheckpoint(input: {
  db: DatabaseSync;
  identitySeed: Buffer;
  signerVaultId: string;
  grantId: string;
  sequence: number;
  closure: unknown;
}): CommonsCheckpointAttestation {
  const head = readCommonsChainHead(input.db, input.grantId);
  if (head.sequence !== input.sequence)
    throw new Error(
      `commons checkpoint at ${input.sequence} does not match chain head ${head.sequence}`
    );
  return attestCommonsCheckpoint({
    identitySeed: input.identitySeed,
    signerVaultId: input.signerVaultId,
    grantId: input.grantId,
    sequence: input.sequence,
    opHash: head.hash,
    stateDigest: commonsStateDigest(input.closure),
  });
}

/** Sign and store the attestation for the checkpoint just written. */
export function attestCommonsCheckpointState(input: {
  steward: { vault: DatabaseSync; identitySeed?: Buffer };
  stewardVaultId: string;
  grantId: string;
  sequence: number;
  closure: unknown;
}): CommonsCheckpointAttestation {
  if (!input.steward.identitySeed)
    throw new Error("commons steward vault has no identity seed to sign with");
  const attestation = signCommonsCheckpoint({
    db: input.steward.vault,
    identitySeed: input.steward.identitySeed,
    signerVaultId: input.stewardVaultId,
    grantId: input.grantId,
    sequence: input.sequence,
    closure: input.closure,
  });
  storeCommonsCheckpointAttestation(
    input.steward.vault,
    input.grantId,
    attestation
  );
  return attestation;
}

/** Persist the checkpoint attestation next to the checkpoint it covers. */
export function storeCommonsCheckpointAttestation(
  db: DatabaseSync,
  grantId: string,
  attestation: CommonsCheckpointAttestation
): void {
  db.prepare(
    `UPDATE share_circle_grant
        SET checkpoint_op_hash = ?, checkpoint_state_digest = ?,
            checkpoint_signature = ?, checkpoint_signer_vault_id = ?
      WHERE grant_id = ?`
  ).run(
    attestation.opHash,
    attestation.stateDigest,
    attestation.signature,
    attestation.signerVaultId,
    grantId
  );
}

export function readCommonsCheckpointAttestation(
  db: DatabaseSync,
  grantId: string
): CommonsCheckpointAttestation | undefined {
  const row = db
    .prepare(
      `SELECT checkpoint_sequence, checkpoint_op_hash, checkpoint_state_digest,
              checkpoint_signature, checkpoint_signer_vault_id
         FROM share_circle_grant WHERE grant_id = ?`
    )
    .get(grantId) as
    | {
        checkpoint_sequence: number;
        checkpoint_op_hash: string | null;
        checkpoint_state_digest: string | null;
        checkpoint_signature: string | null;
        checkpoint_signer_vault_id: string | null;
      }
    | undefined;
  if (
    !row?.checkpoint_op_hash ||
    !row.checkpoint_state_digest ||
    !row.checkpoint_signature ||
    !row.checkpoint_signer_vault_id
  )
    return undefined;
  return {
    sequence: Number(row.checkpoint_sequence),
    opHash: row.checkpoint_op_hash,
    stateDigest: row.checkpoint_state_digest,
    signerVaultId: row.checkpoint_signer_vault_id,
    signature: row.checkpoint_signature,
  };
}

export interface CommonsVerifiedPoint {
  sequence: number;
  opHash: string;
}

export function readCommonsVerified(
  db: DatabaseSync,
  grantId: string
): CommonsVerifiedPoint | undefined {
  const row = db
    .prepare(
      "SELECT sequence, op_hash FROM share_commons_verified WHERE grant_id = ?"
    )
    .get(grantId) as { sequence: number; op_hash: string } | undefined;
  return row
    ? { sequence: Number(row.sequence), opHash: row.op_hash }
    : undefined;
}

/** Monotonic: a verified point never moves backward, so a later frame cannot
 * quietly lower the bar a rewound steward has to clear. */
export function recordCommonsVerified(input: {
  db: DatabaseSync;
  grantId: string;
  sequence: number;
  opHash: string;
  now: string;
}): void {
  input.db
    .prepare(
      `INSERT INTO share_commons_verified
         (grant_id, sequence, op_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         sequence = excluded.sequence, op_hash = excluded.op_hash,
         updated_at = excluded.updated_at
       WHERE excluded.sequence >= share_commons_verified.sequence`
    )
    .run(input.grantId, input.sequence, input.opHash, input.now);
}

/** The steward vault's Ed25519 public key as this seat already knows it.
 * Preferring the seat's own binding over the incoming frame means a rewound
 * or impersonating steward cannot hand us the key that validates its story. */
export function stewardIdentityKey(
  db: DatabaseSync,
  stewardVaultId: string
): Buffer | undefined {
  const row = db
    .prepare(
      `SELECT vault_public_key FROM share_party_vault_binding
        WHERE vault_id = ? AND revoked_at IS NULL AND vault_public_key IS NOT NULL`
    )
    .get(stewardVaultId) as { vault_public_key: string } | undefined;
  return row ? Buffer.from(row.vault_public_key, "base64") : undefined;
}

function diverged(message: string): never {
  throw new CommonsHistoryError("history-diverged", message);
}

/** Hashes this seat already holds, by sequence — the tail rows a previous
 * frame landed. Overlapping sequences must agree hash-for-hash. */
function heldHashes(db: DatabaseSync, grantId: string): Map<number, string> {
  const rows = db
    .prepare(
      "SELECT sequence, op_hash FROM share_commons_op WHERE grant_id = ?"
    )
    .all(grantId) as { sequence: number; op_hash: string }[];
  return new Map(rows.map((row) => [Number(row.sequence), row.op_hash]));
}

export interface CommonsFrameHistory {
  /** Sequence + hash to record once the frame has been applied intact. */
  verified: CommonsVerifiedPoint;
  /** Digest the member must be able to recompute over its own replica. */
  stateDigest: string;
}

/**
 * Verify a frame's history against what this seat already proved, BEFORE any
 * destructive apply. Throws `CommonsHistoryError` — never returns a partial
 * verdict — so the caller's park path is the only outcome of a bad frame.
 */
export function verifyCommonsFrameHistory(input: {
  seat: DatabaseSync;
  grantId: string;
  stewardVaultId: string;
  currentSequence: number;
  snapshotSequence: number;
  tail: readonly Record<string, unknown>[];
  checkpoint?: CommonsCheckpointAttestation;
  /** Keys the frame carries, used on a first bootstrap when this seat holds
   * no binding for the steward yet. */
  bindings?: readonly Record<string, unknown>[];
}): CommonsFrameHistory {
  const verified = readCommonsVerified(input.seat, input.grantId);
  const held = heldHashes(input.seat, input.grantId);
  const checkpoint = input.checkpoint;
  if (!checkpoint) diverged("commons frame carries no signed checkpoint");
  if (checkpoint.sequence !== input.snapshotSequence)
    diverged("commons checkpoint does not cover the snapshot it travels with");
  const key =
    stewardIdentityKey(input.seat, input.stewardVaultId) ??
    frameKey(input.bindings, input.stewardVaultId);
  if (!key) diverged("commons steward has no identity key to verify against");
  if (!verifyCommonsCheckpoint(key, input.grantId, checkpoint))
    diverged("commons checkpoint is not signed by this steward");
  rewound(held, verified, checkpoint.sequence, checkpoint.opHash);

  let previous = { sequence: checkpoint.sequence, hash: checkpoint.opHash };
  for (const row of input.tail) {
    const fields = commonsOpChainFields(row);
    const prevHash = row["prev_hash"];
    const claimed = row["op_hash"];
    if (typeof prevHash !== "string" || typeof claimed !== "string")
      diverged(`commons operation ${fields.sequence} carries no chain hash`);
    if (commonsOpHash(prevHash, fields) !== claimed)
      diverged(
        `commons operation ${fields.sequence} does not match its own hash`
      );
    if (fields.sequence !== previous.sequence + 1)
      diverged(`commons tail skips sequence ${previous.sequence + 1}`);
    if (prevHash !== previous.hash)
      diverged(`commons tail forks at sequence ${fields.sequence}`);
    if (
      verified &&
      fields.sequence === verified.sequence + 1 &&
      prevHash !== verified.opHash
    )
      diverged(
        `commons tail does not extend the verified head at ${verified.sequence}`
      );
    rewound(held, verified, fields.sequence, claimed);
    previous = { sequence: fields.sequence, hash: claimed };
  }
  if (previous.sequence !== input.currentSequence)
    diverged(
      `commons frame ends at ${previous.sequence}, not its declared head ${input.currentSequence}`
    );
  // A steward whose head is BEHIND a point we already verified has lost
  // history (restore-from-backup); there is no honest frame like this.
  if (verified && input.currentSequence < verified.sequence)
    diverged(
      `commons steward head ${input.currentSequence} is behind verified ${verified.sequence}`
    );
  return {
    verified: { sequence: previous.sequence, opHash: previous.hash },
    stateDigest: checkpoint.stateDigest,
  };
}

/**
 * Verify an increment's ops-since-cursor against the point this seat already
 * PROVED, before anything is applied (#750 invariant 7). The anchor is
 * the seat's own `share_commons_verified` head — which itself chains back to
 * a signed checkpoint from the last full bootstrap — so an increment needs no
 * checkpoint of its own: it either extends the proven chain hash-for-hash or
 * it throws `CommonsHistoryError` and the caller parks, exactly as a bad full
 * frame would. The caller must have already matched `anchor.sequence` to the
 * frame's `fromSequence`; a frame built for another cursor is a FALLBACK
 * (re-baseline), not a fault, and never reaches this function.
 */
export function verifyCommonsIncrementHistory(input: {
  seat: DatabaseSync;
  grantId: string;
  anchor: CommonsVerifiedPoint;
  currentSequence: number;
  ops: readonly Record<string, unknown>[];
}): CommonsVerifiedPoint {
  const verified = readCommonsVerified(input.seat, input.grantId);
  const held = heldHashes(input.seat, input.grantId);
  let previous = { sequence: input.anchor.sequence, hash: input.anchor.opHash };
  for (const row of input.ops) {
    const fields = commonsOpChainFields(row);
    const prevHash = row["prev_hash"];
    const claimed = row["op_hash"];
    if (typeof prevHash !== "string" || typeof claimed !== "string")
      diverged(`commons operation ${fields.sequence} carries no chain hash`);
    if (commonsOpHash(prevHash, fields) !== claimed)
      diverged(
        `commons operation ${fields.sequence} does not match its own hash`
      );
    if (fields.sequence !== previous.sequence + 1)
      diverged(`commons increment skips sequence ${previous.sequence + 1}`);
    if (prevHash !== previous.hash)
      diverged(`commons increment forks at sequence ${fields.sequence}`);
    rewound(held, verified, fields.sequence, claimed);
    previous = { sequence: fields.sequence, hash: claimed };
  }
  if (previous.sequence !== input.currentSequence)
    diverged(
      `commons increment ends at ${previous.sequence}, not its declared head ${input.currentSequence}`
    );
  if (verified && input.currentSequence < verified.sequence)
    diverged(
      `commons steward head ${input.currentSequence} is behind verified ${verified.sequence}`
    );
  return { sequence: previous.sequence, opHash: previous.hash };
}

/** One sequence, two different hashes — the steward's log was rewound or
 * forked under a point this seat already holds or already proved. */
function rewound(
  held: Map<number, string>,
  verified: CommonsVerifiedPoint | undefined,
  sequence: number,
  hash: string
): void {
  const local = held.get(sequence);
  if (
    (local && local !== hash) ||
    (verified?.sequence === sequence && verified.opHash !== hash)
  )
    diverged(`commons history rewound at sequence ${sequence}`);
}

function frameKey(
  bindings: readonly Record<string, unknown>[] | undefined,
  stewardVaultId: string
): Buffer | undefined {
  const row = bindings?.find(
    (entry) =>
      entry["vault_id"] === stewardVaultId &&
      entry["revoked_at"] === null &&
      typeof entry["vault_public_key"] === "string"
  );
  return row
    ? Buffer.from(String(row["vault_public_key"]), "base64")
    : undefined;
}

/** Recompute the state digest over what this seat actually stored and refuse
 * to keep a replica whose bytes disagree with the signed checkpoint. */
export function assertCommonsStateDigest(input: {
  seat: DatabaseSync;
  grantId: string;
  expected: string;
}): void {
  const row = input.seat
    .prepare(
      "SELECT checkpoint_json FROM share_circle_grant WHERE grant_id = ?"
    )
    .get(input.grantId) as { checkpoint_json: string | null } | undefined;
  const digest = row?.checkpoint_json
    ? commonsStateDigest(JSON.parse(row.checkpoint_json))
    : undefined;
  if (digest !== input.expected)
    throw new CommonsHistoryError(
      "digest-mismatch",
      `commons replica digest ${String(digest)} does not match the signed checkpoint`
    );
}

/** Copy chain columns verbatim between vaults (same-machine compile, tail
 * projection). Recomputing here would launder a tampered op into a valid one. */
export function chainColumns(
  row: Record<string, unknown>
): [SQLInputValue, SQLInputValue] {
  return [text(row["prev_hash"]), text(row["op_hash"])];
}
