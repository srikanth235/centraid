import type { GatewayDatabase } from "./gateway-db.js";

export interface RetiredShareEffects {
  effects: number;
  edges: number;
}

const RETIRED_MARKER = "share_effects_retired";

const RETIRED_REASON =
  "giving a copy to another person's vault was retired; share it as a grant instead";

const RETIRED_WHERE = `
  kind <> 'deliver-give'
  OR payload_json LIKE '%"delivery":"peer"%'
  OR payload_json LIKE '%"crossOwner":true%'
`;

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
    // Intentionally empty.
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
    // Intentionally empty.
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
