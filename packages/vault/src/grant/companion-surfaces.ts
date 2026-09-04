// COMPANION ATTENUATION IN THE ONE PLANE (#928 A6). A Companion device is
// confined to a set of the owner's own surfaces. That confinement is an ANSWER
// about a device — the same shape as the device's trust row next door — so it
// is a `share_authority` row per surface: principal `device` with the enrolled
// endpoint as its id, `app.surface` as the subject type, the surface (app) id
// as the subject, `use` as the verb.
//
// These rows are the SOURCE OF TRUTH. The gateway authorizes a Companion
// request before any vault is open, so it reads a projection of them held
// beside the enrollment; the projection is rebuilt from here whenever the vault
// opens or the answer changes, and a missing projection denies.

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

export const SURFACE_SUBJECT_TYPE = "app.surface";
export const SURFACE_VERB = "use";

const LIVE = `revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** The surfaces this device may reach, ascending. Empty = confined to none. */
export function readCompanionSurfaces(
  db: DatabaseSync,
  deviceId: string
): string[] {
  return (
    db
      .prepare(
        `SELECT subject_id FROM share_authority
          WHERE principal_kind = 'device' AND principal_id = ?
            AND subject_type = ? AND verb = ? AND decision = 'granted'
            AND ${LIVE}
          ORDER BY subject_id`
      )
      .all(deviceId, SURFACE_SUBJECT_TYPE, SURFACE_VERB) as unknown as {
      subject_id: string;
    }[]
  ).map((row) => row.subject_id);
}

/**
 * Make the answer say exactly `surfaces`. A row is immutable except
 * `revoked_at`, so a dropped surface revokes and an added one inserts — an
 * edit in place could not be audited. Unchanged surfaces keep their row, and
 * with it the id every receipt already cites.
 */
export function setCompanionSurfaces(
  db: DatabaseSync,
  input: { deviceId: string; surfaces: readonly string[]; now: string }
): void {
  const wanted = new Set(input.surfaces);
  const held = new Set(readCompanionSurfaces(db, input.deviceId));
  for (const surface of held) {
    if (wanted.has(surface)) continue;
    db.prepare(
      `UPDATE share_authority SET revoked_at = ?
        WHERE principal_kind = 'device' AND principal_id = ?
          AND subject_type = ? AND subject_id = ? AND verb = ?
          AND revoked_at IS NULL`
    ).run(
      input.now,
      input.deviceId,
      SURFACE_SUBJECT_TYPE,
      surface,
      SURFACE_VERB
    );
  }
  for (const surface of wanted) {
    if (held.has(surface)) continue;
    db.prepare(
      `INSERT INTO share_authority
         (authority_id, principal_kind, principal_id, subject_type, subject_id,
          verb, duration, expires_at, decision, granted_at, granted_by,
          revoked_at, receipt_id)
       VALUES (?, 'device', ?, ?, ?, ?, 'standing', NULL, 'granted', ?, NULL,
               NULL, NULL)`
    ).run(
      uuidv7(),
      input.deviceId,
      SURFACE_SUBJECT_TYPE,
      surface,
      SURFACE_VERB,
      input.now
    );
  }
}

/** Every attenuated device in this vault, with the surfaces it holds. */
export function listCompanionSurfaces(db: DatabaseSync): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT principal_id, subject_id FROM share_authority
        WHERE principal_kind = 'device' AND subject_type = ?
          AND verb = ? AND decision = 'granted' AND ${LIVE}
        ORDER BY principal_id, subject_id`
    )
    .all(SURFACE_SUBJECT_TYPE, SURFACE_VERB) as unknown as {
    principal_id: string;
    subject_id: string;
  }[];
  const byDevice = new Map<string, string[]>();
  for (const row of rows) {
    const held = byDevice.get(row.principal_id);
    if (held) held.push(row.subject_id);
    else byDevice.set(row.principal_id, [row.subject_id]);
  }
  return byDevice;
}
