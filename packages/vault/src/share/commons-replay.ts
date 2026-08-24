// Command-tail replay: the Commons catch-up engine (#750 invariant 7).
//
// A steward's `share_commons_op` log already holds the exact command and input
// of every write that changed the shared closure. Catch-up therefore ships the
// OPERATION TAIL and re-executes it on the replica, instead of walking and
// diffing the whole closure to describe the same change in rows. That is what
// makes a sync-with-changes cost O(k) for k operations rather than O(commons
// size) — the steward never projects what did not move.
//
// Two properties make re-execution converge:
//
//   * Deterministic ids. The steward invokes each Commons write under the seed
//     `commons-replica:<grantId>:<sequence>` (`replicaInvocationKey`), and the
//     replica re-invokes under the same seed, so `ctx.newId()` mints identical
//     row ids on both sides.
//   * Contiguity. A replica may only replay a tail that starts exactly at its
//     own cursor and ends at the steward's head; a gap would apply a command to
//     state it was never authored against.
//
// Replay is never load-bearing for correctness on its own. EVERY failure —
// an unknown command, a handler that refuses, a missing payload, an app whose
// version skew makes the input invalid — raises `CommonsReplayError`, and both
// rails answer that by falling back to the full scrub + re-project, which
// repairs any state. A grant can never be wedged by an operation this build
// cannot replay.

import type { DatabaseSync } from "node:sqlite";

import { recordKnownStagedBlob } from "../blob/staging-record.js";
import type { InvokeOutcome } from "../gateway/types.js";

/** Host-only replica executor; never serialized or exposed to member code. */
export type CommonsReplicaExecutor = (
  command: string,
  commandInput: Record<string, unknown>,
  invocationId: string
) => InvokeOutcome;

/** One executed row of the log, in the shape both rails carry it. */
export interface CommonsTailOperation {
  sequence: number;
  kind: string;
  command: string | null;
  input_json: string | null;
  outcome: string;
}

/**
 * Bytes a tail command claims by sha. Content-addressed bytes cannot be
 * derived from the command input the way ids can, so the manifest travels with
 * the tail and the replica stages it before replay. Sizing metadata rides
 * along because `blob_staging` is what `ctx.blobs.claimStaged` reads.
 */
export interface CommonsTailBlob {
  sha256: string;
  size: number;
  mediaType: string;
  title?: string;
}

/** A tail this replica could not re-execute. Never fatal: fall back to the
 * full projection, which is the one path that repairs arbitrary state. */
export class CommonsReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommonsReplayError";
  }
}

export function isCommonsReplayError(
  error: unknown
): error is CommonsReplayError {
  return error instanceof CommonsReplayError;
}

/**
 * The invocation identity of one Commons operation, used as BOTH the replica's
 * invocation id and the deterministic id seed on either side of the rail.
 */
export function replicaInvocationKey(
  grantId: string,
  sequence: number
): string {
  return `commons-replica:${grantId}:${sequence}`;
}

/** The operations after `afterSequence`, oldest first. */
export function readCommonsTail(
  steward: DatabaseSync,
  grantId: string,
  afterSequence: number
): CommonsTailOperation[] {
  return steward
    .prepare(
      `SELECT sequence, kind, command, input_json, outcome
         FROM share_commons_op
        WHERE grant_id = ? AND sequence > ?
        ORDER BY sequence`
    )
    .all(grantId, afterSequence) as unknown as CommonsTailOperation[];
}

/**
 * Does this tail cover `(fromSequence, headSequence]` with no gap? Compaction
 * prunes below a retention floor, so a long-absent replica's window may have
 * been reclaimed; that replica re-baselines instead of replaying a hole.
 */
export function commonsTailIsContiguous(input: {
  tail: readonly { sequence: number }[];
  fromSequence: number;
  headSequence: number;
}): boolean {
  if (input.fromSequence > input.headSequence) return false;
  if (input.tail.length !== input.headSequence - input.fromSequence)
    return false;
  return input.tail.every(
    (operation, index) => operation.sequence === input.fromSequence + index + 1
  );
}

/** Operations that carry an executable payload; control events do not. */
export function executableCommonsTail(
  tail: readonly CommonsTailOperation[]
): CommonsTailOperation[] {
  return tail.filter(
    (operation) =>
      operation.outcome === "executed" &&
      (operation.kind === "command" || operation.kind === "delete")
  );
}

/** Declared blob-claiming input key. A command that names staged bytes always
 * spells them this way, so the manifest is derived in O(k) from the tail
 * itself rather than by diffing two closures. */
const STAGED_SHA_KEY = "staged_sha";

function collectStagedShas(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectStagedShas(entry, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === STAGED_SHA_KEY && typeof entry === "string" && entry)
      into.add(entry);
    else collectStagedShas(entry, into);
  }
}

/**
 * The bytes a tail's commands claim, described from the STEWARD's own content
 * rows. The steward's staging rows are consumed at claim time, so the durable
 * `core_content_item` the claim minted is the surviving description of those
 * bytes — which is exactly what the replica needs to stage them again.
 */
export function commonsTailBlobs(
  steward: DatabaseSync,
  tail: readonly CommonsTailOperation[]
): CommonsTailBlob[] {
  const shas = new Set<string>();
  for (const operation of executableCommonsTail(tail))
    if (operation.input_json)
      collectStagedShas(JSON.parse(operation.input_json), shas);
  const describe = steward.prepare(
    `SELECT media_type, byte_size, title FROM core_content_item
      WHERE sha256 = ? ORDER BY created_at LIMIT 1`
  );
  const blobs: CommonsTailBlob[] = [];
  for (const sha256 of shas) {
    const row = describe.get(sha256) as
      | { media_type: string; byte_size: number; title: string | null }
      | undefined;
    // A sha the steward no longer describes cannot be staged at the replica.
    // Omitting it makes the replay fail loudly and re-baseline, which is
    // strictly better than staging bytes with invented metadata.
    if (!row) continue;
    blobs.push({
      sha256,
      size: row.byte_size,
      mediaType: row.media_type,
      ...(row.title ? { title: row.title } : {}),
    });
  }
  return blobs;
}

/**
 * Put the tail's claimed bytes back into the replica's staging band so
 * `claimStaged` resolves. The CAS bytes must already be present (placed by the
 * caller's transport); a sha the replica already owns as a content item needs
 * no staging row at all, because `promoteStagedBlob` dedupes onto it.
 */
export function stageCommonsTailBlobs(
  seat: DatabaseSync,
  blobs: readonly CommonsTailBlob[]
): void {
  for (const blob of blobs) {
    const owned = seat
      .prepare("SELECT 1 AS n FROM core_content_item WHERE sha256 = ?")
      .get(blob.sha256);
    if (owned) continue;
    recordKnownStagedBlob(seat, {
      sha256: blob.sha256,
      byteSize: blob.size,
      mediaType: blob.mediaType,
      ...(blob.title ? { filename: blob.title } : {}),
    });
  }
}

/**
 * Re-execute the tail against this replica. Callers MUST hold the seat's write
 * transaction: a partially replayed tail is not a state any seat may keep, and
 * the cursor advance that records the replay belongs in the same commit.
 *
 * `replayed` is refused deliberately. Idempotency here is owned by the seat's
 * cursor, which moves inside the same transaction as the replay — so an
 * operation whose invocation id is already spent means an earlier attempt was
 * rolled back underneath its journal record, and its rows are NOT present.
 * Re-baselining is the only honest answer.
 */
export function replayCommonsTail(input: {
  grantId: string;
  tail: readonly CommonsTailOperation[];
  execute: CommonsReplicaExecutor;
}): void {
  for (const operation of executableCommonsTail(input.tail)) {
    if (!operation.command || !operation.input_json)
      throw new CommonsReplayError(
        `commons operation ${operation.sequence} carries no executable payload`
      );
    let commandInput: unknown;
    try {
      commandInput = JSON.parse(operation.input_json);
    } catch {
      throw new CommonsReplayError(
        `commons operation ${operation.sequence} has unreadable command input`
      );
    }
    if (!commandInput || typeof commandInput !== "object")
      throw new CommonsReplayError(
        `commons operation ${operation.sequence} has invalid command input`
      );
    const invocationId = replicaInvocationKey(
      input.grantId,
      operation.sequence
    );
    let outcome: InvokeOutcome;
    try {
      outcome = input.execute(
        operation.command,
        commandInput as Record<string, unknown>,
        invocationId
      );
    } catch (error) {
      // An unregistered command, an app the replica does not host, a schema
      // this build cannot validate: all of it is version skew, all of it
      // re-baselines rather than parking the grant.
      throw new CommonsReplayError(
        `commons operation ${operation.sequence} (${operation.command}) could not be replayed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (outcome.status !== "executed")
      throw new CommonsReplayError(
        `commons operation ${operation.sequence} (${operation.command}) replayed as ${outcome.status}${
          "reason" in outcome && outcome.reason ? `: ${outcome.reason}` : ""
        }`
      );
  }
}
