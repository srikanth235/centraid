import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import { ensureCommonsParty } from "./commons.js";
import { isSelfBinding } from "./self-binding.js";

export type PartyVaultBindOutcome = "bound" | "conflict" | "self";

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
  if (isSelfBinding(db, input.partyId, input.vaultId)) return "self";
  const live = livePartyVaultBinding(db, input.partyId);
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
  ensurePeopleProfile(db, input.partyId, input.linkedAt);
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

function ensurePeopleProfile(
  db: DatabaseSync,
  partyId: string,
  now: string
): void {
  db.prepare(
    `INSERT INTO people_profile
       (profile_id, party_id, role, avatar_color, cadence_days,
        last_contacted_at, met, created_at)
     VALUES (?, ?, NULL, NULL, 0, NULL, NULL, ?)
     ON CONFLICT (party_id) DO NOTHING`
  ).run(uuidv7(), partyId, now);
}

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
