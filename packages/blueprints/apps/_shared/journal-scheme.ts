import {
  JOURNAL_ENTRY_NOTATION,
  JOURNAL_SCHEME_URI,
  findConcept,
  findScheme,
} from "./concept-scheme-kit.ts";
import { readPages } from "./paged-reads.ts";

// Re-exported: the kit owns every scheme URI a blueprint names.
export {
  JOURNAL_ENTRY_NOTATION,
  JOURNAL_SCHEME_URI,
} from "./concept-scheme-kit.ts";

interface SchemeRow {
  scheme_id: string;
  uri: string;
}

interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}

interface JournalCtx {
  vault: Pick<VaultApi, "page">;
}

interface TagRow {
  tag_id: string;
  target_id: string;
  concept_id: string;
}

// Bounded, keyset-paged reads only (#996 wave 4, R8). A denied read THROWS —
// answering "empty" would leak journal notes into excluded surfaces, so the
// walk's own ceiling throwing is the right failure here too.
export async function readJournalNoteIds(
  ctx: JournalCtx
): Promise<Set<string>> {
  const schemes = await readPages<SchemeRow>(ctx, {
    name: "_shared/journal.scheme",
    select: "scheme_id, uri",
    from: "core_concept_scheme",
    where: "uri = ?",
    bind: [JOURNAL_SCHEME_URI],
    order: {
      sortColumn: "scheme_id",
      pkColumn: "scheme_id",
      descending: false,
    },
  });
  const scheme = findScheme(schemes, JOURNAL_SCHEME_URI);
  if (!scheme) return new Set<string>();

  const concepts = await readPages<ConceptRow>(ctx, {
    name: "_shared/journal.concepts",
    select: "concept_id, scheme_id, notation",
    from: "core_concept",
    where: "scheme_id = ?",
    bind: [scheme.scheme_id],
    order: {
      sortColumn: "concept_id",
      pkColumn: "concept_id",
      descending: false,
    },
  });
  const marker = findConcept(concepts, scheme, JOURNAL_ENTRY_NOTATION);
  if (!marker) return new Set<string>();

  const tags = await readPages<TagRow>(ctx, {
    name: "_shared/journal.tags",
    select: "tag_id, target_id, concept_id",
    from: "core_tag",
    where: "target_type = ? AND concept_id = ?",
    bind: ["knowledge.note", marker.concept_id],
    order: { sortColumn: "tag_id", pkColumn: "tag_id", descending: false },
  });
  return new Set(
    tags
      .filter((tag) => tag.concept_id === marker.concept_id)
      .map((tag) => tag.target_id)
  );
}
