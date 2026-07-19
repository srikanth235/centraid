// The polymorphic-reference registry (issue #441 A1).
//
// Engine FKs cannot cover the vault's polymorphic `(type, id)` mechanisms —
// a `target_type='core.party'` / `target_id=…` pair is a logical reference
// SQLite knows nothing about — so a hard delete of a canonical row must clean
// up every polymorphic pointer at it BY HAND. That hand-maintenance was
// provably uneven: `core_link`/`core_tag`/`core_collection_entry` were swept
// generically, `knowledge_annotation`/`core_attachment` only for notes, and
// `consent_share`/`enrich_embedding`/`sync_external_entity` never at all
// (orphan shares stay "live", orphan vectors resurface deleted content in
// search, stale sync-map rows make re-import silently skip a purged entity).
//
// This registry enumerates the SET, once. `cleanupPolyRefs` walks it, so the
// purge sweep is complete BY CONSTRUCTION and the next mechanism is one entry
// here, not a remembered sweep clause. `poly-refs.test.ts` scans the live DDL
// of both files and asserts every `(table, type/id pair)` is either registered
// below or in `POLY_REF_EXCLUSIONS` — a 7th mechanism added without a registry
// entry fails that test. (Part B's Browse tab needs exactly this metadata for
// dependent-aware deletes, since polymorphic dependents are invisible to
// `PRAGMA foreign_key_list`.)

import type { DatabaseSync } from 'node:sqlite';

/**
 * What happens to a live polymorphic pointer when its target row is purged:
 *   - `end-date`: temporal relation — stamp `valid_to = now` on open rows
 *     (a link onto a purged row ends, it does not dangle; issue #272).
 *   - `delete`: classification/curation/derived data that says nothing once
 *     the row is gone — remove it (issue #274).
 *   - `revoke`: a standing consent grant — stamp `revoked_at = now` on
 *     un-revoked rows (a share of nothing must stop reading live).
 */
export type PolyRefPolicy = 'end-date' | 'delete' | 'revoke';

export interface PolyRefPair {
  /** Column holding the logical entity name, e.g. `target_type`. */
  typeCol: string;
  /** Column holding the target row's id, e.g. `target_id`. */
  idCol: string;
}

export interface PolyRefEntry {
  /** Physical vault.db table name. */
  table: string;
  /**
   * The `(type, id)` column pair(s) that point at a canonical row. `core_link`
   * is the only table with two (its from- and to- endpoints); every other
   * mechanism carries exactly one.
   */
  pairs: PolyRefPair[];
  policy: PolyRefPolicy;
  /**
   * Raw-SQL predicate ANDed onto the type/id match (no bound parameters).
   * Only `enrich_request` uses it, to scope cleanup to still-open queue rows —
   * a drained request is inert completed history, an open one would send an
   * enricher after a row that no longer exists.
   */
  predicate?: string;
  note: string;
}

/**
 * Every polymorphic reference in vault.db that must be cleaned when its target
 * is hard-deleted. Ordered core → domain → consent/enrich/sync for reading;
 * `cleanupPolyRefs` applies them in one pass, and the order among them is
 * immaterial (no table here FKs another).
 */
export const POLY_REF_REGISTRY: readonly PolyRefEntry[] = [
  {
    table: 'core_link',
    pairs: [
      { typeCol: 'from_type', idCol: 'from_id' },
      { typeCol: 'to_type', idCol: 'to_id' },
    ],
    policy: 'end-date',
    note: 'A relation onto a purged row ends rather than dangles (issue #272). An open link matching EITHER endpoint is end-dated.',
  },
  {
    table: 'core_tag',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'Classification says nothing once the row is gone (issue #274).',
  },
  {
    table: 'core_collection_entry',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'Curation membership says nothing once the row is gone (issue #274).',
  },
  {
    table: 'core_attachment',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'An attachment ON a purged target dangles; previously cleaned ONLY for notes (issue #441 A1 — now for every target).',
  },
  {
    table: 'knowledge_annotation',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'A margin note on a purged target dangles; previously cleaned ONLY for notes (issue #441 A1 — now for photos, documents, transactions…).',
  },
  {
    table: 'enrich_embedding',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'Never cleaned before (issue #441 A1): an orphan vector lets deleted content resurface in vector search — the worst-feeling class of vault bug.',
  },
  {
    table: 'enrich_request',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    predicate: 'drained_at IS NULL',
    note: 'Open queue rows only (issue #441 A1): drop pending enrichment for a purged entity so no enricher chases a dead row. Drained rows are inert completed history.',
  },
  {
    table: 'sync_external_entity',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'Never cleaned before (issue #441 A1): a stale map row makes the next import believe a purged entity is still known, so re-import SILENTLY skips it — silent data loss.',
  },
  {
    table: 'consent_seed_row',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'delete',
    note: 'Judgment call beyond the A1 brief (see below): a demo marker has no meaning once its entity is gone, like a tag. gateway/demo.ts already drops it on its OWN purge path; the general sweep does too now, so a demo row purged via the normal lifecycle (owner trashes a demo photo) leaves no stale marker and demoStatus stays honest.',
  },
  {
    table: 'consent_share',
    pairs: [{ typeCol: 'target_type', idCol: 'target_id' }],
    policy: 'revoke',
    note: 'Never cleaned before (issue #441 A1): only expires_at lapsed a share, so a share of a purged row kept looking live — a consent-surface correctness bug.',
  },
];

/**
 * Tables that carry a `(type, id)`-shaped pair but are deliberately NOT swept
 * on purge, each with the reason. `poly-refs.test.ts` treats membership here as
 * accounting for the pair, so an exclusion is a documented decision, never an
 * oversight. Keyed by physical table name.
 *
 * `sync_import_row` and `replica_change` are documented here for completeness
 * even though neither is matched by the DDL scan — `sync_import_row` carries
 * `entity_type` with no `entity_id` sibling, and `replica_change` uses
 * `entity`/`row_id`, not the `_type`/`_id` shape — so a future rename that gave
 * either the canonical shape would land in the scan and be forced to a decision.
 */
export const POLY_REF_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    'consent_provenance',
    'journal.db, append-only audit stream (§03). The provenance trail of a purged row is exactly what must survive it — NEVER cleaned by design.',
  ],
  [
    'consent_receipt',
    'journal.db, append-only audit stream. object_type/object_id is the receipted subject; history is never rewritten (writeReceipt has no update path). NEVER cleaned.',
  ],
  [
    'agent_evidence',
    'journal.db, append-only audit stream. Evidence citing a since-purged entity is a historical claim about a past invocation — NEVER cleaned.',
  ],
  [
    'agent_correction',
    'The historical record of a human correcting the agent (before/after JSON). It documents a past act on the target and stays true after the target is purged — a learning-plane audit fact, not a live pointer.',
  ],
  [
    'outbox_item',
    'The external-write outbox owns its own drain lifecycle (pending → sent/discarded). target_type/target_id is the canonical row the artifact was ABOUT; a sent-message record stays meaningful after its target is purged.',
  ],
  [
    'sync_import_row',
    'Immutable import history — the row-by-row ledger of what a connector proposed. entity_type records the kind that was imported; the row is never mutated after its batch resolves.',
  ],
  [
    'replica_change',
    'Replication machinery with its own epoch/floor lifecycle (change-log.ts). It records past mutations (entity/row_id) for replica catch-up and is trimmed by epoch, not by target liveness.',
  ],
]);

/**
 * End-date / delete / revoke every polymorphic reference pointing at a
 * just-purged canonical row. `entityType` is the LOGICAL name stored in the
 * type columns (`core.content_item`, `media.media_asset`, `knowledge.note`…);
 * `now` is the sweep's ISO timestamp. Operates on vault.db only — journal.db
 * pointers are excluded above and never touched.
 *
 * Idempotent: a second call finds no open links, no un-revoked shares, and
 * nothing left to delete.
 */
export function cleanupPolyRefs(
  vault: DatabaseSync,
  now: string,
  entityType: string,
  entityId: string,
): void {
  for (const entry of POLY_REF_REGISTRY) {
    const match = entry.pairs.map((p) => `("${p.typeCol}" = ? AND "${p.idCol}" = ?)`).join(' OR ');
    const matchParams = entry.pairs.flatMap(() => [entityType, entityId]);
    const extra = entry.predicate ? ` AND ${entry.predicate}` : '';
    if (entry.policy === 'delete') {
      vault.prepare(`DELETE FROM "${entry.table}" WHERE (${match})${extra}`).run(...matchParams);
    } else if (entry.policy === 'end-date') {
      vault
        .prepare(`UPDATE "${entry.table}" SET valid_to = ? WHERE valid_to IS NULL AND (${match})`)
        .run(now, ...matchParams);
    } else {
      // revoke
      vault
        .prepare(
          `UPDATE "${entry.table}" SET revoked_at = ? WHERE revoked_at IS NULL AND (${match})`,
        )
        .run(now, ...matchParams);
    }
  }
}
