/*
 * THE BRACKET, AS A CALLABLE (#1014, findings N1/G4/G5/G22/G24).
 *
 * `beginReplicaCommit`/`endReplicaCommit` (replica/change-log.ts) is the only
 * choke point session capture has: a write outside the pair reaches the trigger
 * log but never a seat's file. Before #1014 the pair was hand-written at every
 * canonical call site and simply MISSING from four of them — the notices store,
 * the standing sweep, post-rollback bookkeeping, and every connection a worker
 * subprocess opens by path. Each omission was a silent loss, not an error.
 *
 * So the pair stops being a convention a writer remembers and becomes a
 * function a writer calls. `withReplicaCommit` is that function; the law rule
 * `bracketed-replica-writes` is the same invariant read off the diff.
 */

import type {
  DatabaseSync,
  SQLInputValue,
  StatementResultingChanges,
  StatementSync,
} from "node:sqlite";

import type { ReplicaCommitHandle } from "../replica/change-log.js";
import {
  abandonReplicaCommit,
  beginReplicaCommit,
  endReplicaCommit,
} from "../replica/change-log.js";
import { notifyReplicaCommit } from "../replica/doorbell.js";

export interface WithReplicaCommitOptions {
  /** What produced the commit, carried onto every `replica_log` row. */
  readonly producer?: string;
  /**
   * Ring the doorbell after COMMIT. Default true, and deliberately AFTER the
   * commit, never inside it: a listener that throws must not fail a committed
   * write (`notifyReplicaCommit` swallows, this only controls WHEN).
   */
  readonly notify?: boolean;
}

/**
 * Run `body` inside one bracketed replica commit on `vault`.
 *
 * Owning the transaction is the point: `BEGIN IMMEDIATE` … `COMMIT` with the
 * pair inside it, so the mutation and its log rows land together. On a throw
 * the sessions are ABANDONED before the ROLLBACK — a rolled-back change stays
 * in an open session otherwise, and the next commit would decode work that
 * never happened.
 *
 * NESTING IS A NO-OP BY DESIGN. Called with a transaction already open, this
 * neither begins nor commits; it only makes sure a pair is open, and leaves
 * ending it to whoever owns the transaction. That is what lets a helper bracket
 * itself without knowing whether its caller already did.
 */
export function withReplicaCommit<T>(
  vault: DatabaseSync,
  body: () => T,
  options: WithReplicaCommitOptions = {}
): T {
  const begun =
    options.producer === undefined ? {} : { producer: options.producer };
  if (vault.isTransaction) {
    const nested = beginReplicaCommit(vault, begun);
    const result = body();
    // A no-op unless this call opened the pair; the enclosing transaction's
    // COMMIT is what makes it durable either way.
    endReplicaCommit(vault, nested);
    return result;
  }
  vault.exec("BEGIN IMMEDIATE");
  let handle: ReplicaCommitHandle | undefined;
  try {
    handle = beginReplicaCommit(vault, begun);
    const result = body();
    endReplicaCommit(vault, handle);
    vault.exec("COMMIT");
    if (options.notify !== false) notifyReplicaCommit(vault);
    return result;
  } catch (error) {
    if (handle?.owner) abandonReplicaCommit(vault);
    vault.exec("ROLLBACK");
    throw error;
  }
}

/**
 * True when this connection can carry the pair at all.
 *
 * A by-path opener may be looking at a file `migrateVault` has never touched —
 * a bare database in a test, a workspace mid-creation. `replica_meta` missing
 * means there is no log to write to, and bracketing would only turn a working
 * write into a thrown error.
 */
function replicaPlanePresent(vault: DatabaseSync): boolean {
  const row = vault
    .prepare(
      `SELECT 1 AS present FROM sqlite_schema
        WHERE type = 'table' AND name = 'replica_meta'`
    )
    .get() as { present: number } | undefined;
  return row !== undefined;
}

/** Statement kinds the bracket has to react to, by first keyword. */
export type ReplicaSqlKind =
  | "mutating"
  | "begin"
  | "commit"
  | "rollback"
  | "rollback-to"
  | "savepoint"
  | "release"
  | "other";

/**
 * Classify by LEADING KEYWORD, after stripping comments.
 *
 * Deliberately coarse. The cost of calling a read "mutating" is one empty
 * commit; the cost of missing a write is a row that never reaches a seat, so
 * every ambiguity resolves towards bracketing.
 */
export function classifyReplicaSql(sql: string): ReplicaSqlKind {
  const stripped = sql
    .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
    .replaceAll(/--[^\n]*/gu, " ")
    .trim();
  const head = /^\s*(?<first>[A-Za-z]+)(?:\s+(?<second>[A-Za-z]+))?/u.exec(
    stripped
  );
  if (!head) return "other";
  const first = (head.groups?.first ?? "").toUpperCase();
  const second = (head.groups?.second ?? "").toUpperCase();
  if (
    first === "INSERT" ||
    first === "UPDATE" ||
    first === "DELETE" ||
    first === "REPLACE"
  )
    return "mutating";
  // A CTE that ends in a write is a write.
  if (first === "WITH")
    return /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(stripped)
      ? "mutating"
      : "other";
  if (first === "BEGIN") return "begin";
  if (first === "COMMIT" || first === "END") return "commit";
  if (first === "SAVEPOINT") return "savepoint";
  if (first === "RELEASE") return "release";
  if (first === "ROLLBACK") return second === "TO" ? "rollback-to" : "rollback";
  return "other";
}

interface BracketState {
  /** Transaction/savepoint nesting this wrapper has seen on this connection. */
  depth: number;
  /** The pair this wrapper opened, while it holds one. */
  handle: ReplicaCommitHandle | undefined;
  /** True while the bracket's own statements are running (never re-entered). */
  internal: boolean;
  producer: string;
}

const BRACKETED = new WeakMap<DatabaseSync, BracketState>();

/** True when {@link bracketReplicaWrites} has already wrapped this handle. */
export function replicaWritesBracketed(vault: DatabaseSync): boolean {
  return BRACKETED.has(vault);
}

/**
 * Make a by-path connection bracket its own writes (#1014, G4/G22).
 *
 * A worker subprocess reaches `vault.db` through its own `DatabaseSync` and
 * writes the conversation-ledger band — `conversations`, `turns`, `items`,
 * `attachments`, all replicated — across dozens of statements in eight modules.
 * Sessions are per CONNECTION, so nothing the gateway's handle holds open sees
 * any of it: every worker-written conversation was expected on the seat and
 * never logged.
 *
 * THE PAIR BELONGS ON THE CONNECTION THAT DOES THE WRITING, so this installs it
 * there rather than routing the writes to another process: `prepare` and `exec`
 * are wrapped, a mutating statement outside a transaction gets its own
 * bracketed commit, and one inside a transaction opens the pair that the
 * matching COMMIT — or the outermost RELEASE — closes. `replica_meta.commit_seq`
 * is allocated inside that write transaction, so a second connection takes it
 * under the same lock the gateway's own writer does.
 *
 * The doorbell is keyed by connection handle (`replica/doorbell.ts`), so this
 * rings THIS connection's listeners after each commit; a stream that wants a
 * worker's writes subscribes to the handle its provider returns.
 *
 * Idempotent per connection, and a no-op on a file with no replica plane.
 */
export function bracketReplicaWrites(
  vault: DatabaseSync,
  options: { producer?: string } = {}
): DatabaseSync {
  if (BRACKETED.has(vault)) return vault;
  if (!replicaPlanePresent(vault)) return vault;
  const state: BracketState = {
    depth: 0,
    handle: undefined,
    internal: false,
    producer: options.producer ?? "gateway",
  };
  BRACKETED.set(vault, state);

  const rawExec = vault.exec.bind(vault);
  const rawPrepare = vault.prepare.bind(vault);

  /** Run the bracket's own statements without re-entering the wrapper. */
  const internally = <T>(fn: () => T): T => {
    state.internal = true;
    try {
      return fn();
    } finally {
      state.internal = false;
    }
  };
  const openPair = (): void => {
    if (state.handle) return;
    internally(() => {
      const handle = beginReplicaCommit(vault, { producer: state.producer });
      if (handle.owner) state.handle = handle;
    });
  };
  const closePair = (): void => {
    const handle = state.handle;
    if (!handle) return;
    state.handle = undefined;
    internally(() => endReplicaCommit(vault, handle));
  };
  const dropPair = (): void => {
    if (!state.handle) return;
    state.handle = undefined;
    internally(() => abandonReplicaCommit(vault));
  };

  /** The one place a statement's SQL decides what happens around it. */
  const around = <T>(sql: string, run: () => T): T => {
    if (state.internal) return run();
    switch (classifyReplicaSql(sql)) {
      case "mutating": {
        if (vault.isTransaction) {
          openPair();
          return run();
        }
        rawExec("BEGIN IMMEDIATE");
        state.depth = 1;
        try {
          openPair();
          const result = run();
          closePair();
          rawExec("COMMIT");
          state.depth = 0;
          notifyReplicaCommit(vault);
          return result;
        } catch (error) {
          dropPair();
          rawExec("ROLLBACK");
          state.depth = 0;
          throw error;
        }
      }
      case "begin":
      case "savepoint": {
        const result = run();
        state.depth += 1;
        return result;
      }
      case "commit": {
        closePair();
        const result = run();
        state.depth = 0;
        notifyReplicaCommit(vault);
        return result;
      }
      case "release": {
        // The OUTERMOST release is the one that commits; an inner one is still
        // inside the transaction, and the pair stays open across it.
        if (state.depth <= 1) closePair();
        const result = run();
        state.depth = Math.max(0, state.depth - 1);
        if (state.depth === 0) notifyReplicaCommit(vault);
        return result;
      }
      case "rollback": {
        dropPair();
        const result = run();
        state.depth = 0;
        return result;
      }
      case "rollback-to": {
        // A savepoint rollback does NOT un-record what the open session already
        // saw, so the pair is dropped and the surviving work is captured by the
        // next one rather than shipping a change that was undone.
        dropPair();
        return run();
      }
      default:
        return run();
    }
  };

  vault.exec = (sql: string): void => {
    around(sql, () => {
      rawExec(sql);
    });
  };
  vault.prepare = (sql: string): StatementSync => {
    const statement = rawPrepare(sql);
    const rawRun = statement.run.bind(statement) as (
      ...params: SQLInputValue[]
    ) => StatementResultingChanges;
    statement.run = ((...params: SQLInputValue[]) =>
      around(sql, () => rawRun(...params))) as unknown as StatementSync["run"];
    return statement;
  };
  return vault;
}
