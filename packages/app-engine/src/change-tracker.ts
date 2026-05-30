/*
 * SQLite session-extension wrapper for emit-on-commit change tracking.
 *
 * `node:sqlite` doesn't expose the C `sqlite3_update_hook` callback API,
 * so to observe writes we open a `Session` against a `DatabaseSync`
 * connection before the operation, run the write, snapshot the resulting
 * `changeset()`, and decode the touched table names. The decoder uses an
 * empty in-memory replica with a `filter` that returns false — node:sqlite
 * calls the filter once per table in the changeset *before* attempting to
 * apply, so we get the table list without needing the replica to have any
 * schema. (Tested: a changeset spanning tables `todos` and `users` applied
 * against an empty in-memory db calls filter twice and silently skips.)
 *
 * Sessions are per-connection. Open one session, do all the writes on that
 * connection, then call `extract()` once at the end — this is how we batch
 * a whole user-handler turn into a single emit.
 */

import { DatabaseSync, type Session } from 'node:sqlite';

/**
 * Start tracking changes on `db`. Returns an opaque handle whose `extract()`
 * method returns the (deduplicated, sorted) set of tables that were
 * mutated since the call to `track()`. `close()` releases the session if
 * `extract()` wasn't called (e.g. on error paths).
 *
 * Returns `undefined` when session creation throws — older node:sqlite
 * builds or rare race conditions. Callers fall back to "no tracking", which
 * is correct (worst case: the SSE feed misses an emit).
 */
export interface ChangeTracker {
  extract(): string[];
  close(): void;
}

export function trackChanges(db: DatabaseSync): ChangeTracker | undefined {
  let session: Session;
  try {
    session = db.createSession();
  } catch {
    return undefined;
  }
  let closed = false;
  return {
    extract(): string[] {
      if (closed) return [];
      try {
        const cs = session.changeset();
        if (cs.length === 0) return [];
        return touchedTablesFromChangeset(cs);
      } finally {
        session.close();
        closed = true;
      }
    },
    close(): void {
      if (closed) return;
      try {
        session.close();
      } catch {
        /* swallow */
      }
      closed = true;
    },
  };
}

/**
 * Decode the list of touched tables out of a session changeset blob.
 * Implementation: spin up an empty in-memory db, call `applyChangeset` with
 * a filter that records each table name and returns `false` to skip the
 * apply. The filter callback receives the table name even when the table
 * doesn't exist on the replica — verified empirically.
 *
 * Exported for tests; production callers use `trackChanges().extract()`.
 */
export function touchedTablesFromChangeset(changeset: Uint8Array): string[] {
  if (changeset.length === 0) return [];
  const replica = new DatabaseSync(':memory:');
  const seen = new Set<string>();
  try {
    replica.applyChangeset(changeset, {
      filter: (table: string) => {
        seen.add(table);
        return false;
      },
    });
  } catch {
    // node:sqlite may throw if a downstream step in applyChangeset errors
    // even though we returned false for every table — be defensive and
    // return whatever we collected.
  } finally {
    try {
      replica.close();
    } catch {
      /* swallow */
    }
  }
  return [...seen].sort();
}
