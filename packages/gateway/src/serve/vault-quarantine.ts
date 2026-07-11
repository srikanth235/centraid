/*
 * FORMAT.md restore rule 4 ("side-effect quarantine"): a directory the
 * offsite backup engine's `restoreSnapshot` materializes carries a
 * `RESTORE_QUARANTINE.json` marker. When the gateway MOUNTS a vault dir
 * that carries one (an operator adopted a restored directory as a live
 * vault — `restoreSnapshot` itself never swaps anything live), it must not
 * let yesterday's outbox or automations silently resume: "restoring a
 * backup must never re-send an email."
 *
 * What this module does, and — honestly — does NOT do:
 *
 *   - outbox: PARKS every approved-but-undrained item back to `pending`
 *     and revokes every live standing grant. A plain SQL UPDATE against
 *     `outbox_item` / `outbox_grant` (vault.db) — the exact shape
 *     `outbox.revoke_grant` already performs through the command pipeline
 *     (`packages/vault/src/commands/outbox.ts`). Contained, obvious,
 *     idempotent (a second mount finds nothing left to park).
 *
 *   - automations: NOT auto-disabled. `enabled` is NOT a DB row — it lives
 *     in the automation app's manifest file INSIDE the git code store;
 *     toggling it (`lifecycle-automation-routes.ts`'s `set-enabled` route)
 *     opens a `WorktreeStore` session, rewrites the file, and PUBLISHES a
 *     commit, for every installed automation. That is not "an obvious SQL
 *     update" — it needs the vault's code store mounted (this runs at
 *     PLANE construction, before any per-vault host/store is built) and a
 *     git commit per automation. The marker therefore STAYS in place (NOT
 *     renamed to `.applied.json`) and the caller reports a health error
 *     until an operator reviews and pauses automations by hand.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeLogger } from '@centraid/app-engine';
import type { VaultDb } from '@centraid/vault';

export interface QuarantineStatus {
  restoredAt: string;
  sourceSeq: number;
  outboxParked: number;
  outboxGrantsRevoked: number;
  /** Always `true` when a status is returned — see module header. */
  automationsNeedManualReview: true;
}

interface QuarantineMarker {
  restoredAt?: unknown;
  sourceSeq?: unknown;
}

export const QUARANTINE_MARKER_FILE = 'RESTORE_QUARANTINE.json';

/** Detect + act on a quarantine marker at `dir`. `null` when there is none. */
export function applyRestoreQuarantine(
  dir: string,
  db: VaultDb,
  logger: RuntimeLogger,
): QuarantineStatus | null {
  const markerFile = path.join(dir, QUARANTINE_MARKER_FILE);
  if (!existsSync(markerFile)) return null;

  let marker: QuarantineMarker = {};
  try {
    marker = JSON.parse(readFileSync(markerFile, 'utf8')) as QuarantineMarker;
  } catch (err) {
    logger.warn(
      `vault plane: ${markerFile} exists but is unreadable: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const restoredAt = typeof marker.restoredAt === 'string' ? marker.restoredAt : 'unknown';
  const sourceSeq = typeof marker.sourceSeq === 'number' ? marker.sourceSeq : -1;

  const parked = db.vault
    .prepare(
      `UPDATE outbox_item
         SET status = 'pending', decided_at = NULL, grant_id = NULL,
             note = 'restored from backup (source seq ${sourceSeq}) — reconfirm before it drains'
       WHERE status = 'approved'`,
    )
    .run();
  const revoked = db.vault
    .prepare(`UPDATE outbox_grant SET revoked_at = ? WHERE revoked_at IS NULL`)
    .run(new Date().toISOString());
  const outboxParked = Number(parked.changes ?? 0);
  const outboxGrantsRevoked = Number(revoked.changes ?? 0);

  logger.warn(
    `vault plane: ${dir} was restored from a backup snapshot (source seq ${sourceSeq}, ` +
      `restored ${restoredAt}) — parked ${outboxParked} outbox item(s), revoked ` +
      `${outboxGrantsRevoked} standing grant(s). Automations were NOT auto-disabled ` +
      `(toggling them needs the code store + a publish, not a plain SQL update) — ` +
      `review and pause them by hand, then rename ${QUARANTINE_MARKER_FILE} to mark this resolved. ` +
      `Connections also need re-auth review.`,
  );

  return {
    restoredAt,
    sourceSeq,
    outboxParked,
    outboxGrantsRevoked,
    automationsNeedManualReview: true,
  };
}
