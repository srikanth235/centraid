/*
 * One-time drain of the obligations copy-as-share retired (#825, ruling
 * G-copy). NOT a schema migration — `gateway.db` refuses those. Queued rows
 * survive an upgrade: left alone the sweep dials `not_found` forever, marked
 * `done` the audit lies. So delete the row, move a still-RUNNING edge to
 * terminal `failed` with a member-facing reason, and never rewrite a
 * completed/denied/revoked/failed edge.
 */

import type { GatewayDatabase } from "./gateway-db.js";

export interface RetiredShareEffects {
  effects: number;
  edges: number;
}

/**
 * `gateway_meta` key stamped once the drain has run against this file (#883
 * C2). Without it a ONE-TIME upgrade step costs two SELECTs — one a
 * `sqlite_master` probe — on the critical path of every writable open, forever,
 * to discover nothing.
 */
const RETIRED_MARKER = "share_effects_retired";

const RETIRED_REASON =
  "giving a copy to another person's vault was retired; share it as a grant instead";

/** Matched over stored JSON so an unparseable row is still found. */
const RETIRED_WHERE = `
  kind <> 'deliver-give'
  OR payload_json LIKE '%"delivery":"peer"%'
  OR payload_json LIKE '%"crossOwner":true%'
`;

/**
 * At most once per `gateway.db` file. Fail-open on the marker read, so a
 * control plane too young for `gateway_meta` still drains; the marker is
 * stamped after the drain, so a crash mid-drain leaves it unset and the next
 * open finishes the job.
 */
export function retireDeadShareEffectsOnce(
  db: GatewayDatabase
): RetiredShareEffects {
  let alreadyRetired = false;
  try {
    alreadyRetired =
      (
        db.db
          .prepare("SELECT value FROM gateway_meta WHERE key = ?")
          .get(RETIRED_MARKER) as { value: string } | undefined
      )?.value !== undefined;
  } catch {
    // No gateway_meta on this file yet: drain, then stamp.
  }
  if (alreadyRetired) return { effects: 0, edges: 0 };
  const drained = retireDeadShareEffects(db);
  try {
    db.run(
      `INSERT INTO gateway_meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      RETIRED_MARKER
    );
  } catch {
    // The drain is idempotent, so failing to record it only costs doing it
    // again — never a boot failure.
  }
  return drained;
}

export function retireDeadShareEffects(
  db: GatewayDatabase
): RetiredShareEffects {
  const rows = db.db
    .prepare(
      `SELECT effect_id, edge_id FROM share_effects
        WHERE status = 'queued' AND (${RETIRED_WHERE})`
    )
    .all() as unknown as { effect_id: string; edge_id: string }[];
  // A gateway.db that never had the table is nothing to drain.
  const hasReceiveSettings =
    (
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'link_receive_settings'"
        )
        .get() as { name: string } | undefined
    )?.name !== undefined;
  if (rows.length === 0 && !hasReceiveSettings) return { effects: 0, edges: 0 };

  const edgeIds = [...new Set(rows.map((row) => row.edge_id))];
  let edges = 0;
  db.transaction(() => {
    for (const row of rows) {
      db.run("DELETE FROM share_effects WHERE effect_id = ?", row.effect_id);
    }
    const now = new Date().toISOString();
    for (const edgeId of edgeIds) {
      // Only a still-RUNNING edge is ended; a settled one keeps its answer.
      db.run(
        `UPDATE share_edges
            SET status = 'failed', reason = ?, updated_at = ?
          WHERE edge_id = ?
            AND status NOT IN ('completed', 'denied', 'revoked', 'failed')`,
        RETIRED_REASON,
        now,
        edgeId
      );
      edges += db.db
        .prepare(
          "SELECT reason FROM share_edges WHERE edge_id = ? AND reason = ?"
        )
        .all(edgeId, RETIRED_REASON).length;
    }
    if (hasReceiveSettings) db.db.exec("DROP TABLE link_receive_settings");
  });
  return { effects: rows.length, edges };
}
