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
 * Both halves live here because every creating command needs the same pair,
 * and a command that declares one without the other is the bug this module
 * exists to make impossible to write by accident.
 */

import type { ConditionSpec } from "../gateway/types.js";

/** The input-schema property for a seat-minted row id. */
export const MINTED_ID_PROPERTY = {
  type: "string",
  minLength: 1,
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
