// ONE SPELLING FOR "AND THEN THE GATEWAY COMMITTED IT" (#1014, R-1014-1).
//
// The log is decoded from the session capture the commit bracket opens, so a
// fixture that writes raw statements and then reads the feed is asserting
// about whatever the NEXT commit happens to sweep up — not about the write it
// just made. Every canonical write path brackets its transaction; a fixture
// that stands in for one has to as well.
//
// The trigger log this replaced fired per statement, which is why suites could
// skip the bracket for years and still see their rows.

import type { DatabaseSync } from "node:sqlite";

import { beginReplicaCommit, endReplicaCommit } from "@centraid/vault";

/** Run `write` inside one captured commit, the way a command does. */
export function capturedWrite(vault: DatabaseSync, write: () => void): void {
  vault.exec("BEGIN IMMEDIATE");
  const handle = beginReplicaCommit(vault, { producer: "test" });
  try {
    write();
    endReplicaCommit(vault, handle);
    vault.exec("COMMIT");
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Decode whatever the open capture is holding, so "the watermark now" means
 * what a caller thinks it means (#1014, R-1014-1).
 *
 * A capture stays open between commits — `captureReplicaCommit` reopens the
 * sessions at its own tail — so a fixture that writes through a path which
 * never CLOSES a commit leaves those rows pending, invisible to the log, and
 * they land in whatever commit comes next. Taking a cursor in that state and
 * then writing one row hands the reader the whole backlog. This settles it.
 */
export function settleReplicaLog(vault: DatabaseSync): void {
  capturedWrite(vault, () => {
    // Nothing of its own: the point is the decode at the end of the bracket.
  });
}
