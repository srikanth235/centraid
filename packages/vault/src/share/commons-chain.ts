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

export function commonsGenesisHash(grantId: string): string {
  return sha256({ domain: GENESIS_DOMAIN, grantId });
}

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

function heldHashes(db: DatabaseSync, grantId: string): Map<number, string> {
  const rows = db
    .prepare(
      "SELECT sequence, op_hash FROM share_commons_op WHERE grant_id = ?"
    )
    .all(grantId) as { sequence: number; op_hash: string }[];
  return new Map(rows.map((row) => [Number(row.sequence), row.op_hash]));
}

export interface CommonsFrameHistory {
  verified: CommonsVerifiedPoint;
  stateDigest: string;
}

export function verifyCommonsFrameHistory(input: {
  seat: DatabaseSync;
  grantId: string;
  stewardVaultId: string;
  currentSequence: number;
  snapshotSequence: number;
  tail: readonly Record<string, unknown>[];
  checkpoint?: CommonsCheckpointAttestation;
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
  if (verified && input.currentSequence < verified.sequence)
    diverged(
      `commons steward head ${input.currentSequence} is behind verified ${verified.sequence}`
    );
  return {
    verified: { sequence: previous.sequence, opHash: previous.hash },
    stateDigest: checkpoint.stateDigest,
  };
}

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

export function chainColumns(
  row: Record<string, unknown>
): [SQLInputValue, SQLInputValue] {
  return [text(row["prev_hash"]), text(row["op_hash"])];
}
