/*
 * LINEAGE HELPERS FOR THE ROW APPLIER (#996, R10) — the key shapes every pass
 * speaks in, and the one scrub that is the AUDIENCE's rather than the origin's.
 * Split out of `apply-outputs.ts` so that file stays inside its line budget.
 */

import type { DatabaseSync } from "node:sqlite";

import { decodeWireValue } from "@centraid/core/protocol";

import { prepared } from "../grant/prepared.js";
import { APPLY_ORDER, SPECS } from "./apply-registry.js";
import { entityIdColumn, PHYSICAL_OF_ENTITY, quoted } from "./apply-shape.js";
import type { ShareMemberRow } from "./closure-members.js";
import type { ShareClosureOutputs } from "./closure-outputs.js";

/** `<entity> <id>` — the key both the id map and the claim set are held by. */
export function lineageKey(entity: string, originId: string): string {
  return `${entity} ${originId}`;
}

/** Containers before their members: the order every write must follow. */
export function orderOf(table: string): number {
  const index = APPLY_ORDER.indexOf(table);
  return index === -1 ? APPLY_ORDER.length : index;
}

export function keyValues(member: ShareMemberRow): unknown[] {
  return (JSON.parse(member.pk) as unknown[]).map((value) =>
    decodeWireValue(value as never)
  );
}

/**
 * A RESEND IS AUTHORITATIVE FOR THE WHOLE MEMBER SET (#1014, V10).
 *
 * `reason: "resend"` is the origin's answer to an audience whose cursor it
 * does NOT recognise — behind the retention floor, or in another epoch after a
 * roll. Its `leave` list is computed from `share_subscription_member`, the origin's own
 * memory of what it last served this audience; a resend happens precisely
 * because that memory and the audience disagree, so it cannot be the only
 * thing that scrubs. The audience therefore closes the set from its own side:
 * a claim the resend did not carry names a row no longer in the closure, and
 * it is dropped by the SAME rule as a leave — deleted only when no other live
 * grant claims it. Without this the audience keeps rows the grant stopped
 * covering, forever, with nothing that would ever mention them again.
 *
 * A claim the resend DID carry but the applier could not place is kept, not
 * scrubbed: "skipped" is this pass falling short, never the row leaving.
 */
export function scrubUnrenewedClaims(
  audience: DatabaseSync,
  authorityId: string,
  outputs: ShareClosureOutputs,
  placed: ReadonlySet<string>
): { scrubbed: number; retained: number } {
  const carried = new Set<string>();
  for (const row of [...outputs.enter, ...outputs.update]) {
    const spec = SPECS.get(row.table);
    if (spec) carried.add(lineageKey(spec.entity, String(keyValues(row)[0])));
  }
  const stale = (
    prepared(
      audience,
      `SELECT target_type, target_id, origin_item_id
         FROM share_subscription_lineage WHERE authority_id = ?`
    ).all(authorityId) as unknown as {
      target_type: string;
      target_id: string;
      origin_item_id: string;
    }[]
  ).filter(
    (row) =>
      !placed.has(lineageKey(row.target_type, row.target_id)) &&
      !carried.has(lineageKey(row.target_type, row.origin_item_id))
  );
  // Members before containers, exactly as the `leave` loop orders its deletes.
  stale.sort(
    (a, b) =>
      orderOf(PHYSICAL_OF_ENTITY.get(b.target_type) ?? "") -
      orderOf(PHYSICAL_OF_ENTITY.get(a.target_type) ?? "")
  );
  const claimed = prepared(
    audience,
    `SELECT 1 AS present FROM share_subscription_lineage
      WHERE target_type = ? AND target_id = ? AND authority_id <> ? LIMIT 1`
  );
  let scrubbed = 0;
  let retained = 0;
  for (const row of stale) {
    prepared(
      audience,
      `DELETE FROM share_subscription_lineage
        WHERE authority_id = ? AND target_type = ? AND target_id = ?`
    ).run(authorityId, row.target_type, row.target_id);
    if (claimed.get(row.target_type, row.target_id, authorityId)) {
      retained += 1;
      continue;
    }
    const table = PHYSICAL_OF_ENTITY.get(row.target_type);
    if (table === undefined) continue;
    const idColumn = entityIdColumn(audience, table);
    if (idColumn === undefined) continue;
    const changes = prepared(
      audience,
      `DELETE FROM ${quoted(table)} WHERE ${quoted(idColumn)} = ?`
    ).run(row.target_id).changes;
    if (Number(changes) > 0) scrubbed += 1;
  }
  return { scrubbed, retained };
}
