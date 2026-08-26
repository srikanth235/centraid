// URI copies in vault/people.ts + queries/journal.ts are deliberate.
export const JOURNAL_SCHEME_URI = "https://centraid.dev/schemes/people-journal";

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

// Bounded `op: "eq"` reads only. A denied read THROWS — answering "empty"
// would leak journal notes into excluded surfaces.
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
