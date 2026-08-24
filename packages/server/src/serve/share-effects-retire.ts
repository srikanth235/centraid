/*
 * THE ONE-TIME DRAIN OF RETIRED SHARE OBLIGATIONS (#825, ruling G-copy).
 *
 * `gateway.db` carries no legacy-generation migrations on principle
 * (`gateway-schema.ts`), and this is not one: it is a REPAIR of durable rows
 * that outlived their transport. Copy-as-share retired, taking with it the
 * `await-answer` / `deliver-refusal` / `pull-blob` effect kinds and the
 * cross-owner (`delivery: "peer"`) arm of `deliver-give`. A gateway upgraded
 * across that retirement can still hold such rows, queued.
 *
 * Leaving them is the dishonest option: the sweep keeps claiming them, keeps
 * dialing a frame that answers `not_found`, and keeps parking the edge with a
 * network-sounding reason — a queue pretending
 * a delivery might still land when the verb no longer exists. Marking them
 * `done` would be worse: `done` means DISCHARGED, and nothing was.
 *
 * So: the obligation ROW is deleted, and its edge is moved to the terminal
 * `failed` with a reason that says why in the member's own terms. `failed` is
 * right here where it is wrong for a retry — this gateway did not fail to act
 * this time, the verb was withdrawn, which is exactly the finality `failed`
 * claims. Nothing that already happened is erased: `share_access_receipts`
 * holds the audit of every copy that DID land, untouched, and no copy already
 * delivered is un-delivered.
 *
 * `link_receive_settings` goes the same way — a stored answer to "may another
 * person's vault push a copy into mine?", a question nothing asks any more.
 */

import type { GatewayDatabase } from "./gateway-db.js";

/** What the drain found, for the boot log. All zeroes on a fresh gateway. */
export interface RetiredShareEffects {
  /** Queued obligations whose transport no longer exists. */
  effects: number;
  /** Edges those obligations belonged to, ended terminally. */
  edges: number;
}

/**
 * The member-facing reason on an edge whose obligation is being dropped. It
 * names the retirement rather than a network condition, because a network
 * condition is not what stopped it.
 */
const RETIRED_REASON =
  "giving a copy to another person's vault was retired; share it as a grant instead";

/**
 * A retired obligation: any kind but `deliver-give`, or a `deliver-give` whose
 * payload names the peer transport. Matched in SQL over the stored payload so
 * a row this build can no longer even parse is still found.
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
  // The table itself may predate this build; a gateway.db that never had it
  // is simply nothing to drain.
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
      // Only an edge that is still RUNNING is ended here. One that already
      // completed, was denied, revoked or failed keeps the answer it earned —
      // a retirement does not rewrite history it arrived after.
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
