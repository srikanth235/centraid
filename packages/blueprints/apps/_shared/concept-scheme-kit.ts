export const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";

export const FOLDER_SCHEME_URI = "https://centraid.dev/schemes/folders";

export const LIST_SCHEME_URI = "https://centraid.dev/schemes/lists";

export const LOCKER_TAGS_SCHEME_URI =
  "https://centraid.dev/schemes/locker-tags";

export const JOURNAL_SCHEME_URI = "https://centraid.dev/schemes/people-journal";

export const TAGS_SCHEME_URI = "centraid:tags:v1";

export const RELATIONS_SCHEME_URI = "urn:duaility:relations";

export const STARRED_NOTATION = "starred";

export const ROOT_FOLDER_NOTATION = "root";

export const JOURNAL_ENTRY_NOTATION = "entry";

export interface SchemeRowShape {
  scheme_id: string;
  uri: string;
}

export interface ConceptRowShape {
  concept_id: string;
  scheme_id: string;
  notation?: string | null;
}

export function findScheme<Row extends SchemeRowShape>(
  schemes: readonly Row[] | undefined,
  uri: string
): Row | undefined {
  return (schemes ?? []).find((scheme) => scheme.uri === uri);
}

export function conceptsInScheme<Row extends ConceptRowShape>(
  concepts: readonly Row[] | undefined,
  scheme: SchemeRowShape | undefined
): Row[] {
  if (!scheme) return [];
  return (concepts ?? []).filter(
    (concept) => concept.scheme_id === scheme.scheme_id
  );
}

export function findConcept<Row extends ConceptRowShape>(
  concepts: readonly Row[] | undefined,
  scheme: SchemeRowShape | undefined,
  notation: string
): Row | undefined {
  if (!scheme) return undefined;
  return (concepts ?? []).find(
    (concept) =>
      concept.scheme_id === scheme.scheme_id && concept.notation === notation
  );
}

export function findSchemeConcept<
  Scheme extends SchemeRowShape,
  Concept extends ConceptRowShape,
>(
  schemes: readonly Scheme[] | undefined,
  concepts: readonly Concept[] | undefined,
  uri: string,
  notation: string
): Concept | undefined {
  return findConcept(concepts, findScheme(schemes, uri), notation);
}
