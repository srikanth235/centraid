/*
 * Vault-as-grantee (#726 P4 §1) — the consent seam a live edge opens at the
 * ORIGIN.
 *
 * There is no parallel permission model here and there must never be one.
 * `consent_access_grant` already selects a grantee two ways (`app_id` OR
 * `grantee_party_id`); a lent edge simply mints the second kind of row, with
 * the AUDIENCE VAULT's party as the grantee. Everything downstream —
 * `evaluateConsent`, row filters, field masks, `buildReplicaShapes`,
 * `projectReplicaPage` — then works on day one, because none of it ever knew
 * which grantee axis it was looking at.
 *
 * The party row is the LINK's, not the edge's: one `core_party` per peer
 * vault, reused by every edge to that vault, identified by a `core_party_
 * identifier` of scheme 'did' carrying `centraid:vault:<vaultId>`. That is
 * what makes "revoke everything I lend Priya" a query rather than a list.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_PURPOSE } from "@centraid/vault";

/** One row/column restriction the owner chose at lend time. */
export interface LendScope {
  schema: string;
  table?: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
  fieldMask?: string[];
}

export interface LendGrant {
  granteePartyId: string;
  grantId: string;
}

const VAULT_PARTY_SCHEME = "did";

function vaultPartyIdentifier(peerVaultId: string): string {
  return `centraid:vault:${peerVaultId}`;
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * The peer vault's party row in THIS vault — minted once, then reused. A
 * person you lend to is data in your vault exactly like any other person; the
 * identifier is what stops a rename from minting a second one.
 */
export function partyForPeerVault(
  vault: DatabaseSync,
  input: { peerVaultId: string; label: string }
): string {
  const value = vaultPartyIdentifier(input.peerVaultId);
  const existing = vault
    .prepare(
      `SELECT party_id FROM core_party_identifier
        WHERE scheme = ? AND value = ?`
    )
    .get(VAULT_PARTY_SCHEME, value) as { party_id: string } | undefined;
  if (existing) return existing.party_id;
  const now = new Date().toISOString();
  const ontology = (
    vault.prepare("SELECT ontology_version FROM core_party LIMIT 1").get() as
      | { ontology_version: string }
      | undefined
  )?.ontology_version;
  const partyId = uuid();
  vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date, avatar_content_id,
          created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, NULL, NULL, NULL, ?, ?, ?)`
    )
    .run(partyId, input.label, now, now, ontology ?? "1");
  vault
    .prepare(
      `INSERT INTO core_party_identifier
         (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?, NULL)`
    )
    .run(uuid(), partyId, VAULT_PARTY_SCHEME, value, now, now);
  return partyId;
}

function purposeConceptId(vault: DatabaseSync): string {
  const row = vault
    .prepare("SELECT concept_id FROM core_concept WHERE notation = ?")
    .get(DEFAULT_PURPOSE) as { concept_id: string } | undefined;
  // A vault without its seed vocabulary cannot express a purpose, so it cannot
  // consent to anything — refuse rather than invent a concept row.
  if (!row) throw new Error(`vault has no ${DEFAULT_PURPOSE} purpose concept`);
  return row.concept_id;
}

function ownerPartyId(vault: DatabaseSync): string {
  const row = vault
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string } | undefined;
  if (!row) throw new Error("vault has no owner party");
  return row.owner_party_id;
}

/**
 * Mint the grant a live edge reads (and, for a write-capable edge, acts)
 * through. `verbs` is an EDGE-level choice (#726 P5): every scope on one
 * edge shares it, because the edge's own wire field is one string, not a
 * per-scope declaration.
 */
export function mintLendGrant(
  vault: DatabaseSync,
  input: {
    peerVaultId: string;
    peerLabel: string;
    scopes: readonly LendScope[];
    verbs: "read" | "read+act";
    expiresAt?: string;
  }
): LendGrant {
  if (input.scopes.length === 0)
    throw new Error("a lend grant needs at least one scope");
  const granteePartyId = partyForPeerVault(vault, {
    peerVaultId: input.peerVaultId,
    label: input.peerLabel,
  });
  // A write-capable edge needs a real `agent_agent` row so a parked
  // invocation's approval surface can name WHO is asking (`callerName` joins
  // on `agent_id`) — a read edge mints none, exactly as P4 left it.
  if (input.verbs === "read+act") ensureLendActor(vault, granteePartyId);
  const grantId = uuid();
  vault
    .prepare(
      `INSERT INTO consent_access_grant
         (grant_id, app_id, grantee_party_id, purpose_concept_id,
          granted_by_party_id, granted_at, expires_at, revoked_at, status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 'active')`
    )
    .run(
      grantId,
      granteePartyId,
      purposeConceptId(vault),
      ownerPartyId(vault),
      new Date().toISOString(),
      input.expiresAt ?? null
    );
  const scope = vault.prepare(
    `INSERT INTO consent_grant_scope
       (scope_id, grant_id, schema_name, table_name, verbs, row_filter_json, field_mask_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const entry of input.scopes) {
    scope.run(
      uuid(),
      grantId,
      entry.schema,
      entry.table ?? null,
      input.verbs,
      entry.rowFilter ? JSON.stringify(entry.rowFilter) : null,
      entry.fieldMask ? JSON.stringify(entry.fieldMask) : null
    );
  }
  return { granteePartyId, grantId };
}

/**
 * Find-or-create the `agent_agent` row a write-capable edge invokes as
 * (#726 P5). It reuses the LINK's own party (`partyForPeerVault`) rather
 * than minting a second one the way `enrollAgent` would — the party IS the
 * peer vault, and a grant's `grantee_party_id` already names it, so the
 * agent identity must resolve to the exact same row or consent lookups and
 * this row would silently disagree about who "the audience" is.
 *
 * `host_key` is unique per party, so re-lending (a second edge to the same
 * peer) reuses this row rather than minting another actor.
 */
export function ensureLendActor(vault: DatabaseSync, partyId: string): string {
  const existing = vault
    .prepare(`SELECT agent_id FROM agent_agent WHERE party_id = ?`)
    .get(partyId) as { agent_id: string } | undefined;
  if (existing) return existing.agent_id;
  const agentId = uuid();
  vault
    .prepare(
      `INSERT INTO agent_agent (agent_id, party_id, host_key, model_ref, version, enrolled_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
    .run(
      agentId,
      partyId,
      `lend:${partyId}`,
      "centraid-lend",
      "1",
      new Date().toISOString()
    );
  return agentId;
}

/**
 * Revocation, origin half: the grant stops being active. Every reader already
 * filters on `status`/`revoked_at`, so this alone makes the next projection
 * produce no shape at all — the refusal is the absence of consent, not a
 * special case bolted onto the lend path.
 */
export function revokeLendGrant(vault: DatabaseSync, grantId: string): void {
  vault
    .prepare(
      `UPDATE consent_access_grant
          SET status = 'revoked', revoked_at = ?
        WHERE grant_id = ? AND revoked_at IS NULL`
    )
    .run(new Date().toISOString(), grantId);
}
