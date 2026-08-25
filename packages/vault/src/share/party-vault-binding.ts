/*
 * `share_party_vault_binding` — vault-resident "is this person linked to a
 * vault of their own, and which one?" (#821). Gateway calls this from
 * `serve/link-party-bindings.ts`.
 *
 * Two rules at the table they constrain:
 *
 *   - UNIQUE (party_id, vault_id) is TOTAL — it does not exempt revoked rows.
 *     Re-linking after revocation must RE-LIGHT the existing row (clear
 *     `revoked_at`), never insert a second one.
 *   - Partial unique `…_live_party` allows a party at most ONE live vault.
 *     A second live vault is genuine ambiguity; keep the standing binding
 *     and report conflict rather than throw or silently re-point.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { ensureCommonsParty } from "./commons.js";

export type PartyVaultBindOutcome =
  | "bound"
  /** Party already holds a LIVE binding to a DIFFERENT vault; left alone. */
  | "conflict";

export type PartyVaultRevokeOutcome = "revoked" | "absent";

export interface PartyVaultBindingRow {
  binding_id: string;
  party_id: string;
  vault_id: string;
  vault_public_key: string | null;
  linked_at: string;
  revoked_at: string | null;
}

function livePartyVaultBinding(
  db: DatabaseSync,
  partyId: string
): PartyVaultBindingRow | undefined {
  return db
    .prepare(
      `SELECT * FROM share_party_vault_binding
        WHERE party_id = ? AND revoked_at IS NULL`
    )
    .get(partyId) as PartyVaultBindingRow | undefined;
}

/**
 * Idempotent. Party ids are shared across linked vaults, so the counterpart
 * is mirrored first — same as `createCommonsGrant` — because the FK names
 * `core_party`.
 */
export function bindPartyToVault(
  db: DatabaseSync,
  input: {
    partyId: string;
    vaultId: string;
    vaultPublicKey?: string | null;
    linkedAt: string;
    displayName?: string;
  }
): PartyVaultBindOutcome {
  const live = livePartyVaultBinding(db, input.partyId);
  // One live vault per person: keep the standing binding, report the clash.
  // Re-pointing silently rewrites who this person "is"; inserting hits the
  // partial unique index.
  if (live && live.vault_id !== input.vaultId) return "conflict";
  ensureCommonsParty(
    db,
    {
      partyId: input.partyId,
      ...(input.displayName === undefined
        ? {}
        : { displayName: input.displayName }),
    },
    input.linkedAt
  );
  db.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (party_id, vault_id) DO UPDATE SET
       vault_public_key = COALESCE(excluded.vault_public_key, vault_public_key),
       -- Re-lighting a tombstone is a NEW link, so it gets the new stamp; a
       -- binding that never went dark keeps the date it was first made.
       linked_at = CASE WHEN revoked_at IS NULL THEN linked_at
                        ELSE excluded.linked_at END,
       revoked_at = NULL`
  ).run(
    uuidv7(),
    input.partyId,
    input.vaultId,
    input.vaultPublicKey ?? null,
    input.linkedAt
  );
  return "bound";
}

/** Tombstone the pair. The row stays: memory that these two were linked, and
 *  the row a later re-link re-lights (UNIQUE is total). */
export function revokePartyVaultBinding(
  db: DatabaseSync,
  input: { partyId: string; vaultId: string; revokedAt: string }
): PartyVaultRevokeOutcome {
  const changes = db
    .prepare(
      `UPDATE share_party_vault_binding
          SET revoked_at = ?
        WHERE party_id = ? AND vault_id = ? AND revoked_at IS NULL`
    )
    .run(input.revokedAt, input.partyId, input.vaultId).changes;
  return Number(changes) > 0 ? "revoked" : "absent";
}
