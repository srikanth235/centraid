// Restore quarantine (FORMAT.md rule 4): a restored dir carries
// RESTORE_QUARANTINE.json; mounting one parks undrained outbox items and
// revokes standing grants — restoring must never re-send. Automations are NOT
// auto-disabled (that needs the code store + publish, unavailable here): the
// marker STAYS and the caller reports a health error until an operator pauses
// them by hand.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RuntimeLogger } from "@centraid/server/engine";
import { revokeAllEgressAuthorities } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

export interface QuarantineStatus {
  restoredAt: string;
  sourceSeq: number;
  outboxParked: number;
  outboxGrantsRevoked: number;
  /** Always true — see module header. */
  automationsNeedManualReview: true;
}

interface QuarantineMarker {
  restoredAt?: unknown;
  sourceSeq?: unknown;
}

export const QUARANTINE_MARKER_FILE = "RESTORE_QUARANTINE.json";

export function applyRestoreQuarantine(
  dir: string,
  db: VaultDb,
  logger: RuntimeLogger
): QuarantineStatus | null {
  const markerFile = path.join(dir, QUARANTINE_MARKER_FILE);
  if (!existsSync(markerFile)) return null;

  let marker: QuarantineMarker = {};
  try {
    marker = JSON.parse(readFileSync(markerFile, "utf8")) as QuarantineMarker;
  } catch (error) {
    logger.warn(
      `vault plane: ${markerFile} exists but is unreadable: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  const restoredAt =
    typeof marker.restoredAt === "string" ? marker.restoredAt : "unknown";
  const sourceSeq =
    typeof marker.sourceSeq === "number" ? marker.sourceSeq : -1;
  const quarantineAt = new Date().toISOString();

  const parked = db.vault
    .prepare(
      `UPDATE outbox_item
         SET status = 'pending', decided_at = NULL, authority_id = NULL, staged_at = ?,
             note = 'restored from backup (source seq ${sourceSeq}) — reconfirm before it drains'
       WHERE status = 'approved'`
    )
    .run(quarantineAt);
  const outboxParked = Number(parked.changes ?? 0);
  const outboxGrantsRevoked = revokeAllEgressAuthorities(
    db.vault,
    quarantineAt
  );

  logger.warn(
    `vault plane: ${dir} was restored from a backup snapshot (source seq ${sourceSeq}, ` +
      `restored ${restoredAt}) — parked ${outboxParked} outbox item(s), revoked ` +
      `${outboxGrantsRevoked} standing grant(s). Automations were NOT auto-disabled ` +
      `(toggling them needs the code store + a publish, not a plain SQL update) — ` +
      `review and pause them by hand, then rename ${QUARANTINE_MARKER_FILE} to mark this resolved. ` +
      `Connections also need re-auth review.`
  );

  return {
    restoredAt,
    sourceSeq,
    outboxParked,
    outboxGrantsRevoked,
    automationsNeedManualReview: true,
  };
}
