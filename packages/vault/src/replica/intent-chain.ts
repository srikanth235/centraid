/*
 * THE OUTCOME CONTRACT (#996, rulings R23–R25) — the half of an intent's
 * answer that is about the CHAIN rather than the row.
 *
 * `intents.ts` beside this file owns the outcome ROW: admit, transition,
 * read, list, delete. This file owns what #996 added on top of it — where an
 * executed intent landed, what it produced, which intents it may not run
 * before, and how long its answer stays good. Split out because the two are
 * separate readings of the same table and together they are a god-file.
 */

import type { DatabaseSync } from "node:sqlite";

import { TERMINAL, intentRowById } from "./intents.js";
import type { IntentRow, ReplicaProducedRowWire } from "./intents.js";

/**
 * Stamp an executed outcome with the commit it produced (#996, R24).
 *
 * IN THE SAME TRANSACTION AS THE COMMIT, which is the whole point: the
 * position and the rows are read from the capture that just ran, so an
 * outcome can never name a commit that rolled back, and can never name the
 * wrong one because a later write moved the watermark between the two
 * statements. Re-reading the row versions afterwards would be a second read
 * against a moving target.
 *
 * ON EVERY PATH. The device path and the peer path both call this; an
 * outcome that carries the position on one path and not the other is worse
 * than one that carries it on neither, because the seat cannot tell which
 * kind it is holding.
 */
export function stampReplicaOutcomeCommitInTransaction(
  vault: DatabaseSync,
  intentId: string,
  captured: {
    readonly commitSeq: number;
    readonly produced: readonly {
      readonly table: string;
      readonly primaryKey: readonly unknown[];
      readonly rowVersion?: number;
    }[];
  }
): void {
  vault
    .prepare(
      `UPDATE replica_intent_outcome
          SET commit_seq = ?, produced_json = ?
        WHERE intent_id = ?`
    )
    .run(
      captured.commitSeq,
      JSON.stringify(
        captured.produced.map((row) => ({
          table: row.table,
          pk: row.primaryKey,
          ...(row.rowVersion === undefined
            ? {}
            : { rowVersion: row.rowVersion }),
        }))
      ),
      intentId
    );
}

/**
 * Stamp every intent whose invocation landed in this GROUP COMMIT (#996, R24).
 *
 * The gateway batches invocations into one transaction, so the transaction —
 * and therefore the log position and the produced set — belongs to the BATCH,
 * not to any one command inside it. This is called at that boundary, with the
 * invocation ids the batch produced, and finds each one's intent through the
 * commit marker. Intents that shared a commit share its position, which is the
 * truth: they landed together.
 */
export function stampReplicaOutcomeCommitsInTransaction(
  vault: DatabaseSync,
  invocationIds: readonly string[],
  captured: {
    readonly commitSeq: number;
    readonly produced: readonly {
      readonly table: string;
      readonly primaryKey: readonly unknown[];
      readonly rowVersion?: number;
    }[];
  }
): void {
  for (const invocationId of invocationIds) {
    const row = vault
      .prepare(
        `SELECT intent_id FROM replica_invocation_commit WHERE invocation_id = ?`
      )
      .get(invocationId) as { intent_id: string | null } | undefined;
    if (row?.intent_id)
      stampReplicaOutcomeCommitInTransaction(vault, row.intent_id, captured);
  }
}

export type ReplicaDependencyVerdict =
  | { readonly kind: "ready" }
  /** A predecessor has not executed yet; this intent waits, it does not fail. */
  | { readonly kind: "waiting"; readonly on: string; readonly reason: string }
  /** A predecessor will never execute; the dependent settles, naming it. */
  | {
      readonly kind: "abandoned";
      readonly on: string;
      readonly reason: string;
    };

/**
 * MAY THIS INTENT RUN YET (#996, R23/R25)?
 *
 * An offline chain is CAUSAL: a rename cannot execute before the create it
 * renames, and a completion cannot execute before either. The gateway is
 * where that is enforced rather than in each app's retry loop, because only
 * the gateway sees the whole chain and only the gateway can answer the
 * question atomically with executing it.
 *
 * THREE VERDICTS, NOT TWO. "Waiting" and "abandoned" are different facts and
 * lead to different screens: a dependent whose predecessor is still queued
 * reads "waiting on an earlier change" and releases on its own when the
 * predecessor lands; a dependent whose predecessor was DENIED will never run,
 * and telling the member that — naming the predecessor and its reason — is
 * the difference between a queue that drains and a queue that quietly stops.
 */
export function replicaDependencyVerdict(
  vault: DatabaseSync,
  dependsOn: readonly string[]
): ReplicaDependencyVerdict {
  for (const predecessor of dependsOn) {
    const row = intentRowById(vault, predecessor);
    if (!row) {
      // AN UNKNOWN PREDECESSOR IS NOT AN ERROR. The seat may be sending the
      // chain out of order, or the create may still be in flight; both
      // resolve by waiting. Only a terminal non-executed answer is fatal.
      return {
        kind: "waiting",
        on: predecessor,
        reason: "waiting on an earlier change",
      };
    }
    if (row.status === "executed") continue;
    if (TERMINAL.has(row.status)) {
      return {
        kind: "abandoned",
        on: predecessor,
        reason:
          row.reason ??
          `an earlier change in this sequence ${row.status === "conflict" ? "conflicted" : row.status}`,
      };
    }
    return {
      kind: "waiting",
      on: predecessor,
      reason: "waiting on an earlier change",
    };
  }
  return { kind: "ready" };
}

/**
 * Resolve `{"$intent": "<id>"}` placeholders against the outcome table.
 *
 * AN OFFLINE CHAIN NAMES ROWS THAT DID NOT EXIST WHEN IT WAS WRITTEN. The
 * create that mints a task has not run when the rename is queued, so the
 * rename cannot carry the task's id — it carries the INTENT's id, and the
 * gateway substitutes the row the intent actually produced.
 *
 * The substitution reads `produced_json`, which is the set the commit wrote,
 * so it resolves by PLAIN EQUALITY against what that intent did — never
 * "the latest task", which is how a rename lands on someone else's row.
 *
 * WHICH of the produced rows is not guessed. A single canonical commit writes
 * the entity's own row AND the supertype mirror the membership trigger keeps
 * AND, on some paths, a revision occurrence — so "the first single-key row"
 * would resolve `core_entity` about half the time, alphabetically. Either the
 * placeholder NAMES the table it means (`{"$intent": id, "table":
 * "schedule_task"}`), or exactly one produced row survives after the engine's
 * own bookkeeping tables are set aside. Anything else is left UNRESOLVED: the
 * command's own precondition then refuses an intent id where a row id belongs,
 * which is a loud, correct failure — silently substituting a guess is not.
 */
const ENGINE_MIRROR_TABLES = new Set([
  "core_entity",
  "core_entity_revision",
  "replica_intent_outcome",
  "replica_invocation_commit",
]);

export function resolvePredecessorReferences(
  vault: DatabaseSync,
  input: unknown
): unknown {
  const resolveOne = (
    intentId: string,
    table: string | undefined
  ): string | undefined => {
    const row = intentRowById(vault, intentId);
    if (!row || row.status !== "executed" || row.produced_json === null)
      return undefined;
    const produced = JSON.parse(row.produced_json) as ReplicaProducedRowWire[];
    const single = produced.filter((entry) => entry.pk.length === 1);
    const candidates =
      table === undefined
        ? single.filter((entry) => !ENGINE_MIRROR_TABLES.has(entry.table))
        : single.filter((entry) => entry.table === table);
    if (candidates.length !== 1) return undefined;
    const key = candidates[0]?.pk[0];
    return typeof key === "string" ? key : undefined;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const shaped =
      (keys.length === 1 && keys[0] === "$intent") ||
      (keys.length === 2 && keys[0] === "$intent" && keys[1] === "table");
    if (shaped) {
      const target = record["$intent"];
      const table = record["table"];
      if (typeof target !== "string") return value;
      if (table !== undefined && typeof table !== "string") return value;
      return resolveOne(target, table) ?? value;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, walk(item)])
    );
  };
  return walk(input);
}

/**
 * The row versions a chain's predecessors PRODUCED, keyed `table\0primaryKey`.
 *
 * WHY A CHAINED WRITE NEEDS THIS (#1014, R18). The seat states the version it
 * OBSERVED on the row — the only honest number it has — but by the time a
 * chained write runs, its own predecessor has already bumped that row. Without
 * this the gateway would refuse every second edit of a row as a conflict with
 * the member's own first edit, which is why the seat used to drop the base
 * version entirely and why nothing was left guarding the write. The rebase is
 * what makes carrying the base version correct AND useful: the child is
 * checked against the version its parent produced, so a THIRD party's edit
 * landing between the two is still a conflict.
 *
 * ORDERED BY COMMIT POSITION so the LAST predecessor to touch a row wins — a
 * chain of three edits on one row rebases onto the third, not whichever id
 * sorted first. A predecessor that has not executed, or that produced no
 * version for the row, contributes nothing and the seat's own number stands.
 */
export function replicaPredecessorRowVersions(
  vault: DatabaseSync,
  dependsOn: readonly string[]
): Map<string, number> {
  const versions = new Map<string, number>();
  const rows = dependsOn
    .map((intentId) => intentRowById(vault, intentId))
    .filter(
      (row): row is IntentRow =>
        row !== undefined &&
        row.status === "executed" &&
        row.produced_json !== null
    )
    .sort((left, right) => (left.commit_seq ?? 0) - (right.commit_seq ?? 0));
  for (const row of rows) {
    const produced = JSON.parse(
      row.produced_json as string
    ) as ReplicaProducedRowWire[];
    for (const entry of produced) {
      if (entry.rowVersion === undefined || entry.pk.length !== 1) continue;
      const key = entry.pk[0];
      if (typeof key !== "string") continue;
      versions.set(producedRowKey(entry.table, key), entry.rowVersion);
    }
  }
  return versions;
}

/** The key `replicaPredecessorRowVersions` answers by: physical table, NUL, id. */
export function producedRowKey(table: string, rowId: string): string {
  return `${table}\u0000${rowId}`;
}

export interface ExpiredOutcomeRecovery {
  readonly intentId: string;
  readonly reason: string;
  /** What the member's seat should do about it, in the protocol's words. */
  readonly recovery: "resubmit-as-new-intent";
}

/**
 * Has this intent's answer aged out of the idempotency window (#996, R24)?
 *
 * "I no longer know" is a real answer and the only safe one: the retained
 * outcome is what makes a retry idempotent, so once it is gone a re-execution
 * could duplicate an effect the member already has. The seat is told to mint
 * a NEW intent id against a freshly observed base rather than retry this one
 * — which is the same move a conflict asks for, for the same reason.
 */
export function expiredOutcomeRecovery(
  vault: DatabaseSync,
  intentId: string,
  now: Date = new Date()
): ExpiredOutcomeRecovery | undefined {
  const row = intentRowById(vault, intentId);
  if (!row || row.expires_at === null) return undefined;
  if (new Date(row.expires_at).getTime() > now.getTime()) return undefined;
  return {
    intentId,
    reason:
      "this operation's durable answer has aged out; the gateway can no longer prove whether it ran",
    recovery: "resubmit-as-new-intent",
  };
}

/**
 * Drop outcomes past their window — but NEVER one a seat has not caught up to.
 *
 * The same rule the log's floor obeys (OQ-13), for the same reason: a seat
 * whose applied cursor is still behind an outcome's `commit_seq` is a seat
 * that has not yet cleared the pending projection that outcome answers.
 * Pruning it turns a badge that would have cleared into one that never does.
 */
export function pruneReplicaIntentOutcomes(
  vault: DatabaseSync,
  options: { now?: Date; holdAtOrAbove?: number } = {}
): { pruned: number; heldBySeat: number | undefined } {
  const now = (options.now ?? new Date()).toISOString();
  const held = options.holdAtOrAbove;
  const pruned = Number(
    vault
      .prepare(
        `DELETE FROM replica_intent_outcome
          WHERE expires_at IS NOT NULL AND expires_at <= ?
            AND (? IS NULL OR commit_seq IS NULL OR commit_seq <= ?)`
      )
      .run(now, held ?? null, held ?? 0).changes
  );
  return { pruned, heldBySeat: held };
}
