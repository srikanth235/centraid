/**
 * The People-journal marker, and the one bounded read that resolves it.
 *
 * An owner journal entry is not a row of its own (#450): it is a
 * `knowledge.note` carrying exactly one `core.tag` → concept whose
 * `notation` is `entry` inside the concept scheme
 * `https://centraid.dev/schemes/people-journal`. Notes' library, search and
 * link-target surfaces must EXCLUDE those notes (#834 R-journal): the
 * Journal place inside Notes — a filter over this same scheme — is their one
 * home, while opening one by id (`note`, `history`) still works.
 *
 * The vault has no `not-in` where-op, so the exclusion happens in-handler
 * over the id set this module returns. Two other copies of the scheme URI
 * exist on purpose and are left alone: `packages/vault/src/commands/people.ts`
 * (the writer) and `packages/blueprints/apps/people/queries/journal.ts` (the
 * Journal projection). They live in other trees; this constant is the Notes
 * app's single copy, shared by its three excluding queries.
 */

/** The concept scheme every People-journal marker concept belongs to. */
export const JOURNAL_SCHEME_URI = "https://centraid.dev/schemes/people-journal";

/** The marker concept's SKOS notation inside that scheme. */
export const JOURNAL_ENTRY_NOTATION = "entry";

interface SchemeRow {
  scheme_id: string;
  uri: string;
}

interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}

interface TagRow {
  target_id: string;
  concept_id: string;
}

/**
 * The ids of every `knowledge.note` marked as a People-journal entry.
 *
 * Three bounded reads, each narrowed by an `op: "eq"` so none of them can
 * degrade into a whole-table walk: the scheme by URI, the marker concept by
 * scheme, then the tags by that concept. An absent scheme or marker concept
 * (a vault where the owner has never journalled) short-circuits to an empty
 * set without touching `core.tag` at all.
 *
 * A denied read THROWS rather than answering "nothing is a journal entry" —
 * silently failing open would leak journal notes into the very surfaces
 * R-journal keeps them out of. Callers translate the throw into their own
 * absence contract.
 */
export async function readJournalNoteIds(
  vault: VaultApi,
  purpose: string
): Promise<Set<string>> {
  const schemes = await vault.read({
    entity: "core.concept_scheme",
    where: [{ column: "uri", op: "eq", value: JOURNAL_SCHEME_URI }],
    purpose,
  });
  const scheme = ((schemes.rows ?? []) as unknown as SchemeRow[]).find(
    (row) => row.uri === JOURNAL_SCHEME_URI
  );
  if (!scheme) return new Set<string>();

  const concepts = await vault.read({
    entity: "core.concept",
    where: [{ column: "scheme_id", op: "eq", value: scheme.scheme_id }],
    purpose,
  });
  const marker = ((concepts.rows ?? []) as unknown as ConceptRow[]).find(
    (row) =>
      row.scheme_id === scheme.scheme_id &&
      row.notation === JOURNAL_ENTRY_NOTATION
  );
  if (!marker) return new Set<string>();

  const tags = await vault.read({
    entity: "core.tag",
    where: [
      { column: "target_type", op: "eq", value: "knowledge.note" },
      { column: "concept_id", op: "eq", value: marker.concept_id },
    ],
    purpose,
  });
  return new Set(
    ((tags.rows ?? []) as unknown as TagRow[])
      .filter((tag) => tag.concept_id === marker.concept_id)
      .map((tag) => tag.target_id)
  );
}
