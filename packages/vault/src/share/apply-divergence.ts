/*
 * DIVERGENCE, AND ITS ERASURE (#996, R10; ruling G-view, #846).
 *
 * A projected row is read-only in the audience vault. The shape composer used
 * to enforce that by accident — it re-read and compared everything on every
 * pass, so a row the audience had edited was simply overwritten — and that
 * re-reading is the cost the predicate transport exists to remove. So the
 * property is re-earned here instead of inherited.
 *
 * `share_subscription_lineage.audience_row_version` records what THIS vault's
 * row was at when the applier last wrote it. A claimed row whose version has
 * moved past that was written on this side, and the origin's copy is the
 * answer. The seat reports the count, holds its cursor back, and the origin
 * answers with one resend in the same pass.
 *
 * TWO STATEMENTS PER CLAIMED TABLE PER PASS, never one per row.
 */

import type { DatabaseSync } from "node:sqlite";

import { prepared } from "../grant/prepared.js";
import { SPECS } from "./apply-registry.js";
import {
  hasRowVersion,
  PHYSICAL_OF_ENTITY,
  quoted,
  shapeOf,
} from "./apply-shape.js";

/** Every table this grant currently claims a row in, that can report a version. */
function claimedTables(audience: DatabaseSync, authorityId: string): string[] {
  return (
    prepared(
      audience,
      `SELECT DISTINCT target_type FROM share_subscription_lineage
        WHERE authority_id = ?`
    ).all(authorityId) as unknown as { target_type: string }[]
  ).flatMap((row) => {
    const physical = PHYSICAL_OF_ENTITY.get(row.target_type);
    return physical !== undefined && hasRowVersion(audience, physical)
      ? [physical]
      : [];
  });
}

/** Claimed rows whose version has moved past what the applier wrote. */
export function divergedClaimCount(
  audience: DatabaseSync,
  authorityId: string
): number {
  let diverged = 0;
  for (const table of claimedTables(audience, authorityId)) {
    const entity = SPECS.get(table)?.entity;
    if (entity === undefined) continue;
    const { idColumn } = shapeOf(audience, table);
    if (idColumn === undefined) continue;
    const row = prepared(
      audience,
      `SELECT COUNT(*) AS n FROM share_subscription_lineage l
         JOIN ${quoted(table)} t ON t.${quoted(idColumn)} = l.target_id
        WHERE l.authority_id = ? AND l.target_type = ?
          AND t.row_version <> l.audience_row_version`
    ).get(authorityId, entity) as { n: number };
    diverged += Number(row.n);
  }
  return diverged;
}

/** Re-stamp what this vault's rows are AT, after a pass wrote them. */
export function stampAudienceVersions(
  audience: DatabaseSync,
  authorityId: string
): void {
  for (const table of claimedTables(audience, authorityId)) {
    const entity = SPECS.get(table)?.entity;
    if (entity === undefined) continue;
    const { idColumn } = shapeOf(audience, table);
    if (idColumn === undefined) continue;
    prepared(
      audience,
      `UPDATE share_subscription_lineage SET audience_row_version = COALESCE(
         (SELECT t.row_version FROM ${quoted(table)} t
           WHERE t.${quoted(idColumn)} = share_subscription_lineage.target_id), 0)
        WHERE authority_id = ? AND target_type = ?`
    ).run(authorityId, entity);
  }
}
