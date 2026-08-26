/*
 * One-time drain of retired share obligations (#825, ruling G-copy).
 * Not a schema migration: `gateway.db` refuses those (`gateway-schema.ts`).
 * Copy-as-share retired `await-answer` / `deliver-refusal` / `pull-blob` and
 * the peer arm of `deliver-give`; queued rows can still exist after upgrade.
 * Leave them and the sweep dials `not_found` forever. Mark `done` and the
 * audit lies (nothing discharged). Delete the row; move a still-running edge
 * to terminal `failed` with a member-facing retirement reason. Do not rewrite
 * completed/denied/revoked/failed edges. Drop `link_receive_settings` the
 * same way — nothing asks that question any more.
 */

import type { GatewayDatabase } from "./gateway-db.js";

export interface RetiredShareEffects {
  effects: number;
  edges: number;
}

const RETIRED_REASON =
  "giving a copy to another person's vault was retired; share it as a grant instead";

/**
 * Any kind but `deliver-give`, or a `deliver-give` whose payload names the
 * peer transport. Matched over stored JSON so an unparseable row is still found.
 */
const RETIRED_WHERE = `
  kind <> 'deliver-give'
  OR payload_json LIKE '%"delivery":"peer"%'
  OR payload_json LIKE '%"crossOwner":true%'
`;

export function retireDeadShareEffects(
  db: GatewayDatabase
): RetiredShareEffects {
  const rows = db.db
    .prepare(
      `SELECT effect_id, edge_id FROM share_effects
        WHERE status = 'queued' AND (${RETIRED_WHERE})`
    )
    .all() as unknown as { effect_id: string; edge_id: string }[];
  // Table may predate this build; a gateway.db that never had it is nothing to drain.
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
      // Only a still-RUNNING edge is ended. Completed/denied/revoked/failed keep their answer.
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
