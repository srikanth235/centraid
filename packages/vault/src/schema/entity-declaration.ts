// What ONE registry declaration is: the shape every entity in
// `entity-catalog.ts` fills in. Separated from the declarations themselves so
// the catalog stays a list of facts about the ontology and this stays the
// definition of what those facts must say.

/**
 * What one registered entity is, beyond its existence.
 *
 * `label` is the member-facing name every surface shows — required, because a
 * nameless entity is what forced four maps to invent a name each.
 *
 * `blurb` is the one-line plain-English description the Atlas's Relations page
 * shows. It is present for ONTOLOGY kinds (the owner's life data) and
 * deliberately absent for machinery bands: we name the plumbing, but we never
 * fabricate a description for it. Blurbs stay short (≤ ~60 chars), concrete,
 * and honour docs/glossary.md — never "chat" for the ledger, no
 * "entity"/"record"/"FK".
 *
 * `lifecycle` is what the row's LIFE is allowed to be (#916, ruling ONT-08).
 * It was a convention applied by touch for four releases — twelve tables grew
 * the trash pair, thirteen grew an `updated_at` trigger, and nothing said
 * which of the rest were append-only BY DESIGN versus merely never revisited.
 * A convention with no test drifts by construction, so the answer is declared
 * here and `schema/lifecycle.test.ts` holds the shape to it.
 */
export type EntityLifecycle =
  /** Written once; corrected by writing another row, never in place. */
  | "append-only"
  /** Edited in place: carries `updated_at` and both stamp triggers. */
  | "mutable"
  /** Mutable AND reversibly deleted: `deleted_at` + `purge_at` with the CHECK. */
  | "trash"
  /**
   * Plumbing the member never edits as data. Machinery bands set their own
   * shape (a cursor is overwritten, a log is appended) and the lifecycle test
   * asserts nothing about them beyond the declaration existing — a band whose
   * rows exist to serve a mechanism is governed by that mechanism.
   */
  | "machinery";

/**
 * How long this entity's pre-mutation snapshots are kept (#916, owner
 * decision D2).
 *
 * `core_entity_revision` is the ONE revision mechanism — `locker_item_history`
 * was a second one and is gone — and "how long" was previously whatever the
 * sweep that happened to run decided. A count is the ordinary answer: the last
 * N snapshots of a row, so undo and "what did this say before" work and the
 * table does not grow without bound. `'forever'` is the exception the Locker
 * needs: its password history is a PROMISE to the member, not a convenience,
 * and a swept-away previous password is a credential they can no longer
 * recover.
 */
export interface EntityRevisionPolicy {
  retain: number | "forever";
}

/** The count every entity keeps unless its declaration says otherwise. */
export const DEFAULT_REVISION_RETAIN = 20;

export interface VaultEntityDeclaration {
  label: string;
  blurb?: string;
  lifecycle: EntityLifecycle;
  /**
   * Snapshot retention for this entity (#916, D2). Omitted means
   * `{ retain: DEFAULT_REVISION_RETAIN }`; read it through
   * `revisionPolicyOf` rather than defaulting at each call site.
   */
  revisions?: EntityRevisionPolicy;
  /**
   * Set when this table's rows are a PROJECTION of another entity's row rather
   * than entities in their own right (#916, rung ten): the logical name of the
   * parent they belong to. A projection is still registered — the export walk
   * and the replica change log need it — but it gets no `core_entity` row and
   * so cannot be tagged, linked, attached to or shared on its own. The test is
   * "can anything legitimately do that to THIS row?", and for a fingerprint, a
   * passkey slot or one side of a split the answer is no; the parent's purge
   * still takes it through the cascade it already has. See `schema/entity.ts`
   * for why every sidecar keyed by its parent's id is settled by construction.
   *
   * The value is the parent's logical name, or `core.entity` — the supertype
   * itself — for a projection whose parent is whatever its OWN pointer names.
   * `core.share_origin` is the only one: its primary key IS a `(type, id)`
   * pair, so its parent key is the composite one into `core_entity`.
   */
  projectionOf?: string;
}

export type EntityRegistry = Readonly<
  Record<string, Readonly<Record<string, VaultEntityDeclaration>>>
>;

/** The retention a declaration asks for, or the default it did not state. */
export function revisionPolicyOf(
  declaration: VaultEntityDeclaration
): EntityRevisionPolicy {
  return declaration.revisions ?? { retain: DEFAULT_REVISION_RETAIN };
}
