/* eslint-disable max-classes-per-file -- domain error and disk-full classifier are one error surface (#408) */
// Disk-full classification (issue #351 wave 4): a vault that runs out of
// free space must fail closed — never corrupt vault.db (SQLite's own
// atomicity already guarantees that: a failed transaction auto-rolls-back
// and the connection stays usable, verified in db.test.ts) and never leave a
// half-written blob under its content address. What was missing is
// RECOGNIZING the failure: node:sqlite surfaces a full database as a plain
// `Error` with `code: 'ERR_SQLITE_ERROR'` + `errcode: 13` (SQLITE_FULL) —
// nothing upstream can tell that apart from a schema bug without checking
// these fields, so a caught-and-scrubbed error silently loses the "this was
// disk pressure" signal. `isDiskFullError` is that check, shared by every
// write path (vault SQLite writes, blob CAS local files, the gateway's log
// persistence) so ENOSPC (raw fs writes) and SQLITE_FULL (sqlite writes)
// both route to the same fail-closed handling.

/** True for a raw filesystem ENOSPC or a node:sqlite SQLITE_FULL error. */
export function isDiskFullError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown };
  if (e.code === 'ENOSPC') return true;
  // node:sqlite (DatabaseSync) wraps every sqlite error as `Error` with
  // `code: 'ERR_SQLITE_ERROR'` and the raw sqlite result code on `errcode`.
  // SQLITE_FULL is 13 (sqlite3.h) — probed directly against node 22's
  // node:sqlite via `PRAGMA max_page_count`, see db.test.ts.
  if (e.code === 'ERR_SQLITE_ERROR' && e.errcode === 13) return true;
  if (typeof e.errstr === 'string' && /disk.*full|SQLITE_FULL/i.test(e.errstr)) return true;
  return false;
}

/** Raised for any vault write (SQLite or blob CAS) that failed because the disk is full. */
export class VaultDiskFullError extends Error {
  constructor(
    readonly context: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultDiskFullError';
  }
}

/**
 * Reclassify a caught write error: disk-full errors become a
 * `VaultDiskFullError` carrying `context` (what was being written, e.g.
 * `"blob CAS write"`) so callers can recognize and surface it without
 * re-parsing `err.code`/`errcode`. Anything else passes through unchanged
 * (never swallowed, never mangled) so a real bug still looks like one.
 *
 * Also reports into `sharedDiskFullTracker` as a side effect: this is the
 * ONE place every vault write path's disk-full error already funnels
 * through (db.ts, blob/local.ts, blob/custody.ts), so it is the natural
 * spot to feed the gateway's `disk` health probe too — a caller embedding
 * this package doesn't have to remember to do it separately at every catch
 * site up the stack (gateway/execution.ts, blob upload routes, …).
 */
export function asVaultDiskFullError(context: string, err: unknown): Error {
  if (isDiskFullError(err)) {
    const detail = err instanceof Error ? err.message : String(err);
    sharedDiskFullTracker.report(err, context);
    return new VaultDiskFullError(context, `disk full during ${context}: ${detail}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** One recorded disk-full event — what the gateway's `disk` health probe surfaces. */
export interface DiskFullEvent {
  /** ISO timestamp the event was recorded. */
  at: string;
  /** What was being written, e.g. `"blob CAS write"` or `"gateway log persistence"`. */
  context: string;
  /** The underlying error's message. */
  message: string;
}

/**
 * Process-wide record of the most recent disk-full event across every write
 * path. A `statfs` reading that looks fine again doesn't mean the LAST write
 * that failed is now safe to forget — the gateway's `disk` health probe
 * reads `current()` and stays red until free space is confirmed recovered
 * (`clear()`), so an operator sees "ENOSPC observed at <time> in <context>"
 * instead of the probe silently going green the moment a few bytes free up.
 */
export class DiskFullTracker {
  private last: DiskFullEvent | null = null;

  /** Record `err` if it classifies as disk-full; no-op otherwise. */
  report(err: unknown, context: string): void {
    if (!isDiskFullError(err)) return;
    this.last = {
      at: new Date().toISOString(),
      context,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  /** The most recent unresolved disk-full event, or null. */
  current(): DiskFullEvent | null {
    return this.last;
  }

  /** Call once free space is confirmed recovered — clears the forced-error state. */
  clear(): void {
    this.last = null;
  }
}

/**
 * The shared tracker every write path in this process reports into by
 * default (blob CAS, gateway log persistence — see their call sites). One
 * process serves one disk, so a singleton is the right shape; tests that
 * need isolation construct their own `new DiskFullTracker()` and pass it
 * explicitly instead of touching this one.
 */
export const sharedDiskFullTracker = new DiskFullTracker();
