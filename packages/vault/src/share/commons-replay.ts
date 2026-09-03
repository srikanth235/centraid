import type { DatabaseSync } from "node:sqlite";

import { recordKnownStagedBlob } from "../blob/staging-record.js";
import type { InvokeOutcome } from "../gateway/types.js";

export type CommonsReplicaExecutor = (
  command: string,
  commandInput: Record<string, unknown>,
  invocationId: string
) => InvokeOutcome;

export interface CommonsTailOperation {
  sequence: number;
  kind: string;
  command: string | null;
  input_json: string | null;
  outcome: string;
}

export interface CommonsTailBlob {
  sha256: string;
  size: number;
  mediaType: string;
  title?: string;
}

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

export function replicaInvocationKey(
  grantId: string,
  sequence: number
): string {
  return `commons-replica:${grantId}:${sequence}`;
}

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

export function executableCommonsTail(
  tail: readonly CommonsTailOperation[]
): CommonsTailOperation[] {
  return tail.filter(
    (operation) =>
      operation.outcome === "executed" &&
      (operation.kind === "command" || operation.kind === "delete")
  );
}

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
