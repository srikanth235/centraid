/*
 * `founding_ticket_reservations` — the table that keeps ONE founding ceremony
 * alive across slow work (issue #555, hardened in #568 item K).
 *
 * The founding ticket's own ten minutes decide whether a ceremony may START.
 * A restore, though, can legitimately outlive that window while a
 * multi-gigabyte snapshot downloads, so the caller trades its ticket for an
 * opaque reservation that survives longer without making the ticket reusable.
 *
 * Three invariants live here, and each one exists because breaking it
 * destroys data rather than merely erroring:
 *
 *   - A reservation is per TICKET, and the table's `ticket_id` primary key
 *     plus `ON DELETE CASCADE` enforce that. Deleting the ticket row deletes
 *     the reservation — which is why `mintFounding` refuses while one is
 *     live rather than replacing the row (see `pairing-store.ts`).
 *   - `pending_vault_ids_json` records the exact filesystem identities the
 *     ceremony is about to create, so boot can remove them if the process
 *     dies before the commit (`founding-recovery.ts`).
 *   - A reservation is RELEASED, not left to expire, on every path that
 *     failed without consuming its ticket. Otherwise a wrong password wedges
 *     the founding slot for the reservation's full TTL.
 */

import crypto from 'node:crypto';
import type { GatewayDatabase } from './gateway-db.js';

/** A started restore may legitimately outlive the QR ticket's mint window. */
export const FOUNDING_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

interface ReservationRow {
  reservation_id: string;
  secret_hash: string;
  reserved_until: number;
}

/**
 * Reserve the founding slot for the ticket whose `secret_hash` is given.
 * Re-entrant for the same ticket while the reservation is live (a retried
 * request gets the same id back); `undefined` when the slot is taken by a
 * different secret or the reservation has lapsed.
 *
 * Must be called inside the caller's transaction — the read-then-insert is
 * only atomic under one.
 */
export function reserveFoundingWithinTransaction(
  db: GatewayDatabase,
  input: { ticketId: string; secretHash: string; expiresAt: number; ttlMs: number },
): string | undefined {
  const now = Date.now();
  const existing = db.db
    .prepare(
      `SELECT reservation_id, secret_hash, reserved_until
         FROM founding_ticket_reservations
        WHERE ticket_id = ?`,
    )
    .get(input.ticketId) as ReservationRow | undefined;
  if (existing) {
    return existing.secret_hash === input.secretHash && existing.reserved_until > now
      ? existing.reservation_id
      : undefined;
  }
  if (input.expiresAt <= now) return undefined;
  const reservationId = crypto.randomUUID();
  const inserted = db.db
    .prepare(
      `INSERT OR IGNORE INTO founding_ticket_reservations (
         ticket_id, reservation_id, secret_hash, reserved_at, reserved_until
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.ticketId, reservationId, input.secretHash, now, now + input.ttlMs);
  return inserted.changes === 1 ? reservationId : undefined;
}

/** Is a live reservation holding the single founding slot right now? */
export function foundingSlotIsReserved(db: GatewayDatabase): boolean {
  const row = db.db
    .prepare(
      `SELECT 1 AS live
         FROM tickets t
         JOIN founding_ticket_reservations r ON r.ticket_id = t.ticket_id
        WHERE t.kind = 'found' AND r.reserved_until > ?
        LIMIT 1`,
    )
    .get(Date.now()) as { live: number } | undefined;
  return row?.live === 1;
}

/**
 * Record the vault ids this reservation is about to materialize. Idempotent
 * for an identical list (a retry re-stages the same set); refuses a DIFFERENT
 * list, because that means two ceremonies are racing the same reservation.
 */
export function stageReservedFoundingVaults(
  db: GatewayDatabase,
  reservationId: string,
  vaultIds: readonly string[],
): boolean {
  const encoded = JSON.stringify([...new Set(vaultIds)]);
  if (vaultIds.length === 0 || encoded === '[]') return false;
  return db.transaction(() => {
    const row = db.db
      .prepare(
        `SELECT pending_vault_ids_json
           FROM founding_ticket_reservations
          WHERE reservation_id = ? AND reserved_until > ?`,
      )
      .get(reservationId, Date.now()) as { pending_vault_ids_json: string | null } | undefined;
    if (!row) return false;
    if (row.pending_vault_ids_json !== null && row.pending_vault_ids_json !== encoded) return false;
    db.db
      .prepare(
        `UPDATE founding_ticket_reservations
            SET pending_vault_ids_json = ?
          WHERE reservation_id = ?`,
      )
      .run(encoded, reservationId);
    return true;
  });
}

/**
 * Give the founding slot back after an attempt that never consumed its
 * ticket (issue #568 item K). The TICKET row is left intact, so the same QR
 * stays valid for its own ten minutes and the owner simply retries.
 */
export function releaseFounding(db: GatewayDatabase, reservationId: string): void {
  db.run('DELETE FROM founding_ticket_reservations WHERE reservation_id = ?', reservationId);
}

export function clearReservedFoundingVaults(
  db: GatewayDatabase,
  reservationId: string,
  vaultIds: readonly string[],
): void {
  db.db
    .prepare(
      `UPDATE founding_ticket_reservations
          SET pending_vault_ids_json = NULL
        WHERE reservation_id = ? AND pending_vault_ids_json = ?`,
    )
    .run(reservationId, JSON.stringify([...new Set(vaultIds)]));
}

/** Every staged-but-uncommitted founding artifact; boot's cleanup input. */
export function pendingFoundingVaults(
  db: GatewayDatabase,
): Array<{ reservationId: string; vaultIds: string[] }> {
  return (
    db.db
      .prepare(
        `SELECT reservation_id, pending_vault_ids_json
           FROM founding_ticket_reservations
          WHERE pending_vault_ids_json IS NOT NULL
          ORDER BY reserved_at, reservation_id`,
      )
      .all() as Array<{ reservation_id: string; pending_vault_ids_json: string }>
  ).map((row) => {
    const parsed: unknown = JSON.parse(row.pending_vault_ids_json);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((vaultId) => typeof vaultId !== 'string')
    ) {
      throw new Error(`invalid pending founding vault list for reservation ${row.reservation_id}`);
    }
    return { reservationId: row.reservation_id, vaultIds: [...new Set(parsed)] };
  });
}
