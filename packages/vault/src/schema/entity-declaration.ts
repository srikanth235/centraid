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

/**
 * The replica value policy of ONE entity (#922, ruling SB-text).
 *
 * Until #922 every value above a flat 64 KiB was stripped out of the JSON
 * replica lane and listed as deferred, and nothing fetched it back: a note
 * body over the ceiling was simply absent on the phone, which is the one thing
 * a replica exists to prevent. The ruling splits the two cases that had been
 * conflated. TEXT a screen renders RIDES IN FULL, up to a ceiling the entity
 * DECLARES — the entity knows what its longest column can honestly weigh, and
 * a number declared beside the table is a number a page-budget can reason
 * about. Genuinely BINARY values never ride the JSON lane at all, and that is
 * a property of the COLUMN, so it is declared as one.
 */
export interface VaultEntityReplicaValues {
  /**
   * What one TEXT value of this entity may weigh, in bytes, and still ride the
   * replica lane. Omitted means {@link DEFAULT_REPLICA_TEXT_CEILING_BYTES}.
   *
   * Raise it wherever the product stores long member text: the ceiling is a
   * promise about the entity, not a device limit, and a value above it is
   * deferred — never silently, because both clients turn a deferred field into
   * a refusal that names it (`guardReplicaRow`).
   */
  readonly textCeilingBytes?: number;
  /**
   * Columns whose values are BYTES, not text: never eager on the JSON lane
   * whatever they weigh. Declared per column because that is what the fact is
   * about; `snapshot.ts` also defers an undeclared value that arrives as a
   * `Uint8Array`, which is the safety net for the dynamic ext band that has no
   * declaration to read.
   */
  readonly lazyColumns?: readonly string[];
}

/**
 * The text ceiling an entity gets when it declares none. It is the pre-#922
 * flat cap, kept as the DEFAULT rather than as the rule: an entity that stores
 * long member text raises it (see `core.content_item`), and an entity that has
 * never held more than a title has no reason to.
 */
export const DEFAULT_REPLICA_TEXT_CEILING_BYTES = 64 * 1_024;

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
  /**
   * What this entity's values are allowed to be on the replica lane (#922,
   * ruling SB-text). Omitted means the default text ceiling and no lazy
   * column; read it through `replicaValuePolicyOf` rather than defaulting at
   * each call site.
   */
  replicaValues?: VaultEntityReplicaValues;
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

/** The replica value policy a declaration asks for, or the one it did not state. */
export function replicaValuesOf(
  declaration: VaultEntityDeclaration
): Required<Pick<VaultEntityReplicaValues, "textCeilingBytes">> &
  VaultEntityReplicaValues {
  const declared = declaration.replicaValues;
  return {
    textCeilingBytes:
      declared?.textCeilingBytes ?? DEFAULT_REPLICA_TEXT_CEILING_BYTES,
    ...(declared?.lazyColumns ? { lazyColumns: declared.lazyColumns } : {}),
  };
}
