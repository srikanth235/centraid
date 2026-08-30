// A device's standing authority, as `share_authority` rows over `core.vault`
// (#883 V-split). Absence means "not enrolled"; `revoked` is a LIVE declined
// row, so a device cut off never reads back as one never heard of.

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

const DEVICE_SUBJECT_TYPE = "core.vault";
const DEVICE_SUBJECT_ID = "";

export type DeviceTrust = "full" | "readonly" | "revoked";

interface AnswerRow {
  verb: string;
  decision: string;
}

function trustOf(row: AnswerRow): DeviceTrust {
  if (row.decision === "declined") return "revoked";
  return row.verb === "edit" ? "full" : "readonly";
}

// `%DEVICE%` takes a COLUMN REFERENCE only — it is concatenated into SQL.
export const DEVICE_TRUST_SCALAR_SQL = `(
  SELECT CASE
           WHEN a.decision = 'declined' THEN 'revoked'
           WHEN a.verb = 'edit' THEN 'full'
           ELSE 'readonly'
         END
    FROM share_authority a
   WHERE a.principal_kind = 'device' AND a.principal_id = %DEVICE%
     AND a.subject_type = '${DEVICE_SUBJECT_TYPE}'
     AND a.subject_id = '${DEVICE_SUBJECT_ID}' AND a.revoked_at IS NULL
   ORDER BY CASE a.decision WHEN 'declined' THEN 0 ELSE 1 END, a.granted_at
   LIMIT 1)`;

export function deviceTrustScalarSql(deviceIdExpression: string): string {
  return DEVICE_TRUST_SCALAR_SQL.replace("%DEVICE%", deviceIdExpression);
}

export function readDeviceTrust(
  db: DatabaseSync,
  deviceId: string
): DeviceTrust | undefined {
  const row = db
    .prepare(
      `SELECT verb, decision FROM share_authority
        WHERE principal_kind = 'device' AND principal_id = ?
          AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL
        ORDER BY CASE decision WHEN 'declined' THEN 0 ELSE 1 END, granted_at`
    )
    .get(deviceId, DEVICE_SUBJECT_TYPE, DEVICE_SUBJECT_ID) as
    | AnswerRow
    | undefined;
  return row ? trustOf(row) : undefined;
}

// Rows are immutable but for `revoked_at` (#883 V-table); a repeat is a no-op.
export function setDeviceTrust(
  db: DatabaseSync,
  input: {
    deviceId: string;
    ownerPartyId: string;
    trust: DeviceTrust;
    now: string;
  }
): void {
  if (readDeviceTrust(db, input.deviceId) === input.trust) return;
  db.prepare(
    `UPDATE share_authority SET revoked_at = ?
      WHERE principal_kind = 'device' AND principal_id = ?
        AND subject_type = ? AND subject_id = ? AND revoked_at IS NULL`
  ).run(input.now, input.deviceId, DEVICE_SUBJECT_TYPE, DEVICE_SUBJECT_ID);
  db.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by,
        revoked_at, receipt_id)
     VALUES (?, 'device', ?, ?, ?, ?, 'standing', NULL, ?, ?, ?, NULL, NULL)`
  ).run(
    uuidv7(),
    input.deviceId,
    DEVICE_SUBJECT_TYPE,
    DEVICE_SUBJECT_ID,
    input.trust === "full" ? "edit" : "view",
    input.trust === "revoked" ? "declined" : "granted",
    input.now,
    input.ownerPartyId
  );
}
