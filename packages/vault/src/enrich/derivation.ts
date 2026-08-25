// Derivation provenance (#724): derived VALUES scatter across ontology tables
// that record no producer, so this sidecar answers "which model wrote this".
// Several ENGINE PROFILES may hold a result for one target and variant, so
// `preferredDerivation` is THE reader — picking a row by hand mints a divergent
// notion of "the" result (#807). STAMP AND VALUE MUST LAND TOGETHER: neither
// function opens a transaction, because a stamp committed without its value
// tells the automation cursor the work is done.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

/** What a caller naming no profile writes, and the fallback rung. */
export const BUILT_IN_PROFILE = "built-in";

export interface DerivationStamp {
  targetType: string;
  targetId: string;
  variant: string;
  capability: string;
  /** Defaults to {@link BUILT_IN_PROFILE}. */
  profile?: string;
  /** `"<name>@<version>"` — what an upgrade queries against. */
  model: string;
  payload?: unknown;
  now?: string;
}

export interface DerivationRecord {
  targetType: string;
  targetId: string;
  variant: string;
  capability: string;
  profile: string;
  model: string;
  payload: unknown;
  producedAt: string;
}

export interface DerivationQuery {
  targetType: string;
  targetId: string;
  variant: string;
  preferredProfile?: string;
}

/**
 * Re-running the SAME profile REPLACES its stamp: the row always names the
 * model whose output is on disk now. Another profile is another row (#807).
 */
export function stampDerivation(
  vault: DatabaseSync,
  input: DerivationStamp
): void {
  vault
    .prepare(
      `INSERT INTO enrich_derivation
         (derivation_id, target_type, target_id, variant, capability, profile,
          model, payload_json, produced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, variant, profile) DO UPDATE SET
         capability = excluded.capability,
         model = excluded.model,
         payload_json = excluded.payload_json,
         produced_at = excluded.produced_at`
    )
    .run(
      uuidv7(),
      input.targetType,
      input.targetId,
      input.variant,
      input.capability,
      input.profile ?? BUILT_IN_PROFILE,
      input.model,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.now ?? nowIso()
    );
}

/**
 * Preferred profile, else built-in, else lowest profile name — an arbitrary tie
 * broken STABLY, so two readers never disagree about which result they read.
 */
export function preferredDerivation(
  vault: DatabaseSync,
  input: DerivationQuery
): DerivationRecord | null {
  const row = vault
    .prepare(
      `SELECT target_type, target_id, variant, capability, profile, model,
              payload_json, produced_at
         FROM enrich_derivation
        WHERE target_type = ? AND target_id = ? AND variant = ?
        ORDER BY CASE profile WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, profile
        LIMIT 1`
    )
    .get(
      input.targetType,
      input.targetId,
      input.variant,
      input.preferredProfile ?? BUILT_IN_PROFILE,
      BUILT_IN_PROFILE
    ) as
    | {
        target_type: string;
        target_id: string;
        variant: string;
        capability: string;
        profile: string;
        model: string;
        payload_json: string | null;
        produced_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    targetType: row.target_type,
    targetId: row.target_id,
    variant: row.variant,
    capability: row.capability,
    profile: row.profile,
    model: row.model,
    // Unguarded: the DDL's `json_valid` CHECK makes bad payloads unstorable.
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
    producedAt: row.produced_at,
  };
}

/** Resolves through `preferredDerivation`, so it names the row consumers read. */
export function stampedModel(
  vault: DatabaseSync,
  input: DerivationQuery
): string | null {
  return preferredDerivation(vault, input)?.model ?? null;
}
