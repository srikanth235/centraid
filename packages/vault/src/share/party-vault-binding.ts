/*
 * `share_party_vault_binding` — the vault-resident answer to "is this person
 * linked to a vault of their own, and which one?" (issue #821).
 *
 * The table has existed since #731, written by the commons plane
 * (`createCommonsGrant`, invitation claims, roster/control projection), so
 * the fact was reachable only for people who had already been pulled into a
 * share. The link ceremony — the gesture where the owner
 * ACTUALLY binds a person to a peer vault — recorded the association solely
 * as gateway-side JSON (`vault_links.permissions_json.commonsPartyIds`), which
 * no vault query can see. A People-band query asking "show me who I'm linked
 * with" had nothing to join against. This module is the write the ceremony
 * was missing; the gateway calls it from `serve/link-party-bindings.ts`.
 *
 * Two rules live here, at the table they constrain:
 *
 *   - UNIQUE (party_id, vault_id) is TOTAL — it does not exempt revoked rows.
 *     So re-linking after a revocation must RE-LIGHT the existing row (clear
 *     `revoked_at`), never insert a second one.
 *   - The partial unique index `…_live_party` allows a party at most ONE live
 *     vault. A second live vault for the same person is a genuine ambiguity
 *     (which of the two is "them"?), so we keep the binding already standing
 *     and report the conflict rather than throwing or silently re-pointing it.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { ensureCommonsParty } from "./commons.js";

/** What a bind attempt did — reportable, never thrown at the caller. */
export type PartyVaultBindOutcome =
  /** A live row now stands for (party, vault): inserted, re-lit, or refreshed. */
  | "bound"
  /** The party already holds a LIVE binding to a DIFFERENT vault; left alone. */
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

/** The one live binding for `partyId`, if any. */
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
 * Bind `partyId` to `vaultId`, idempotently. Safe to replay: a repeated
 * approval, a re-run ceremony, and a redelivered event all land on the same
 * row. Party ids are shared across linked vaults (the Commons model), so the
 * counterpart's party is mirrored into this vault first — exactly what
 * `createCommonsGrant` does — because the binding's FK names `core_party`.
 */
export function bindPartyToVault(
  db: DatabaseSync,
  input: {
    partyId: string;
    vaultId: string;
    vaultPublicKey?: string | null;
    linkedAt: string;
    /** How to name the mirrored party when this vault has never seen it. */
    displayName?: string;
  }
): PartyVaultBindOutcome {
  const live = livePartyVaultBinding(db, input.partyId);
  // One live vault per person: keep the standing binding, report the clash.
  // Re-pointing it would silently rewrite who this person "is" on the peer
  // plane, and inserting alongside it would just hit the partial unique index.
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

/** Tombstone the binding for this pair. The row stays: a revoked binding is
 *  the memory that these two were once linked, and the row a later re-link
 *  re-lights (the UNIQUE key is total). */
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
