/*
 * A row id minted at the seat, honoured or refused here (#922 G2).
 *
 * A blueprint's projection mints the id it SHOWS the member and sends it with
 * the write, so a child write filed offline against that id lands pointing at
 * the same row. The origin's half is two things: accept the id in the input
 * schema, and refuse one it already holds — a seat-minted id the vault has
 * seen is a replay or a collision, never an instruction to overwrite the row
 * someone else is looking at.
 *
 * Both halves live here because every CREATING command needs the same pair,
 * and a create that declares one without the other is the bug this module
 * exists to make hard to write by accident.
 *
 * AN UPSERT IS NOT A CREATE, and must not use `mintedIdIsFree`. Where one
 * command both makes and edits a row — `schedule.save_project` and
 * `schedule.save_section` are the two in the tree — the id is the KEY the edit
 * addresses, so refusing an id the vault already holds would refuse every
 * rename. Those two therefore honour a minted id WITHOUT refusing a repeat,
 * and a second write with the same id updates the row rather than being turned
 * away. Splitting create from edit is what would let them refuse; that is not
 * this module's to do, and `receipts/issue-922-snappier-blueprints.md` carries
 * it as a finding.
 */

import type { ConditionSpec } from "../gateway/types.js";

/**
 * A UUID, and nothing else. The seat mints v8 (derived from its intent id) and
 * `ctx.newId()` mints v7, so both are covered; the point is that a row id the
 * CALLER chose has a shape the origin enforces. Without this, honouring a
 * minted id meant honouring any non-empty string as a primary key — blanks,
 * prose, five thousand characters — and the seven apps that copy this seam
 * would have copied that too.
 */
const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** The input-schema property for a seat-minted row id. */
export const MINTED_ID_PROPERTY = {
  type: "string",
  minLength: 36,
  maxLength: 36,
  pattern: UUID_PATTERN,
} as const;

/**
 * Refuse a minted id the vault already holds. Absent id, no opinion: the
 * command mints its own as it always did.
 */
export function mintedIdIsFree(
  table: string,
  column: string,
  subject: string
): ConditionSpec {
  return {
    name: `${column}_is_free`,
    sql: `SELECT (:${column} IS NULL
                  OR NOT EXISTS (SELECT 1 FROM ${table}
                                  WHERE ${column} = :${column})) AS n`,
    column: "n",
    op: "eq",
    value: 1,
    message: `That ${subject} already exists.`,
  };
}
