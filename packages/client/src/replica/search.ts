import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import type { ReplicaRow } from "./types.js";

export interface ReplicaLocalSearchSpec {
  columns: readonly string[];
  deletedColumn?: string;
  /**
   * The base table's primary key, which is also the UNINDEXED column the
   * vault's shadow table mirrors (`schema/fts.ts`, `idColumn`). A seat search
   * joins the two on it, so the two names must be the SAME name — pinned by
   * `search-parity.test.ts` against the vault's own spec.
   */
  idColumn: string;
}

/**
 * A document BODY stays online-only; the TITLE is eager, so titles rank offline.
 * Never name a column or entity the vault's FTS registry does not (#883).
 */
export const REPLICA_LOCAL_SEARCH: Readonly<
  Record<string, ReplicaLocalSearchSpec>
> = {
  // `core.content_item` AND `knowledge.note` ARE HERE SINCE W5-D1, and their
  // absence was a property of the OLD STORE, not of the vault.
  //
  // The shaped store held EAGER COLUMNS: a note's body is a data: URI on a
  // content item it references, and the content item's title is an EXPRESSION
  // over the owning asset (R20(b)) — neither is a column of any replica shape,
  // so neither could be ranked. A SEAT holds the vault's own file, shadow
  // tables and all, so both rank exactly as they do on the gateway.
  //
  // That absence was not silent in theory and invisible in practice: the
  // command palette and the phone's search overlay have both targeted
  // `knowledge.note` and `core.content_item` all along, and both refusals were
  // swallowed by an `allSettled` — a note search that quietly returned nothing.
  //
  // `columns` stays DIRECT columns only. It is what `replicaPendingSearchMatch`
  // scans on an unsent write, and neither a decoded body nor an expression over
  // another table is on the row that is sitting in the outbox.
  "core.content_item": {
    columns: [],
    deletedColumn: "deleted_at",
    idColumn: "content_id",
  },
  "knowledge.note": {
    columns: ["title"],
    deletedColumn: "deleted_at",
    idColumn: "note_id",
  },
  "core.document": {
    columns: ["title"],
    deletedColumn: "deleted_at",
    idColumn: "document_id",
  },
  "social.thread": { columns: ["subject"], idColumn: "thread_id" },
  "core.party": {
    columns: ["display_name", "sort_name"],
    idColumn: "party_id",
  },
  "knowledge.annotation": { columns: ["body_text"], idColumn: "annotation_id" },
  "schedule.task": {
    columns: ["title", "description"],
    deletedColumn: "deleted_at",
    idColumn: "task_id",
  },
  "core.event": {
    columns: ["summary", "description"],
    deletedColumn: "deleted_at",
    idColumn: "event_id",
  },
  "core.transaction": { columns: ["description"], idColumn: "txn_id" },
  "people.profile": {
    columns: ["role", "nickname"],
    deletedColumn: "deleted_at",
    idColumn: "profile_id",
  },
  "locker.item": {
    columns: ["title", "username", "url"],
    deletedColumn: "deleted_at",
    idColumn: "item_id",
  },
  "tally.expense": {
    columns: ["description"],
    deletedColumn: "deleted_at",
    idColumn: "expense_id",
  },
};

/**
 * The physical names a seat search touches: the base table, and the vault's
 * shadow table beside it.
 *
 * DERIVED, NOT DECLARED. `packages/vault`'s `resolveEntity` composes
 * `schema_table` for every entity in the registry, and `schema/fts.ts` names
 * the shadow `fts_<physical>`. Restating either as a literal here would be a
 * second owner for a name the registry owns (#883, ruling O-label), so the
 * derivation is stated once and PINNED against the vault's own source by
 * `search-parity.test.ts`.
 */
export function replicaSearchTables(entity: string): {
  base: string;
  fts: string;
} {
  const physical = entity.replace(".", "_");
  return { base: physical, fts: `fts_${physical}` };
}

/**
 * The window a search answer is bounded by. Named here, beside the grammar it
 * bounds, rather than left as two literals in the store: a bound nobody can
 * name is one nobody can report, which is how the FTS path kept its silence
 * after the read path lost its own (#922 0a).
 */
export const REPLICA_DEFAULT_SEARCH_ROWS = 100;
export const REPLICA_MAX_SEARCH_ROWS = 1000;

export function replicaLocalSearchSpec(entity: string): ReplicaLocalSearchSpec {
  const spec = REPLICA_LOCAL_SEARCH[entity];
  if (!spec) {
    throw new OnlineOnlyError(
      `entity ${entity} has no complete eager-metadata search surface in the replica`
    );
  }
  return spec;
}

/**
 * A MIRROR of `ftsMatchExpression`: one query compiles to one FTS5 program
 * online and off (#846). Split on WHITESPACE only, and admit a token only for a
 * letter or digit — word-run splitting or `\p{M}` diverges the two planes.
 */
export function replicaSearchTokens(query: string): string[] {
  if (typeof query !== "string")
    throw new ReplicaProtocolError("Search query must be a string");
  const tokens = query
    .split(/\s+/u)
    .map((token) => token.replaceAll('"', ""))
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .slice(0, 16);
  if (tokens.length === 0) {
    throw new ReplicaProtocolError("Search query has no searchable words");
  }
  return tokens;
}

export function replicaFtsMatchExpression(query: string): string {
  return replicaSearchTokens(query)
    .map((token) => `"${token}"*`)
    .join(" ");
}

export function replicaSearchRequiredColumns(
  spec: ReplicaLocalSearchSpec
): string[] {
  return [...spec.columns, ...(spec.deletedColumn ? [spec.deletedColumn] : [])];
}

const foldSearchText = (value: string): string =>
  value
    .normalize("NFD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase();

interface SearchWord {
  original: string;
  folded: string;
  start: number;
  end: number;
}

function searchWords(value: string): SearchWord[] {
  return [...value.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match) => {
    const start = match.index;
    const original = match[0];
    return {
      original,
      folded: foldSearchText(original),
      start,
      end: start + original.length,
    };
  });
}

/** A quoted PHRASE of word runs; the punctuation split belongs HERE, not in
 *  {@link replicaSearchTokens}. */
function tokenPhrase(token: string): string[] {
  return [...token.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match) =>
    foldSearchText(match[0])
  );
}

function phraseIndex(words: readonly SearchWord[], phrase: string[]): number {
  const last = phrase.length - 1;
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    let hit = true;
    for (let offset = 0; offset <= last && hit; offset += 1) {
      const folded = words[start + offset]!.folded;
      const wanted = phrase[offset]!;
      hit = offset === last ? folded.startsWith(wanted) : folded === wanted;
    }
    if (hit) return start;
  }
  return -1;
}

/** Adjacency is per FIELD, never across the flattened list. */
export function replicaPendingSearchMatch(
  row: ReplicaRow,
  spec: ReplicaLocalSearchSpec,
  query: string
): { matches: boolean; snippet: string } {
  if (spec.deletedColumn && row[spec.deletedColumn] != null)
    return { matches: false, snippet: "" };
  const phrases = replicaSearchTokens(query).map(tokenPhrase);
  const fields = spec.columns
    .flatMap((column) => {
      const value = row[column];
      return typeof value === "string" ? [value] : [];
    })
    .map((value) => ({ value, words: searchWords(value) }));
  if (
    !phrases.every((phrase) =>
      fields.some(({ words }) => phraseIndex(words, phrase) !== -1)
    )
  )
    return { matches: false, snippet: "" };
  const firstPhrase = phrases[0]!;
  const source = fields.find(
    ({ words }) => phraseIndex(words, firstPhrase) !== -1
  ) ?? { value: fields[0]?.value ?? "", words: [] };
  // The whole phrase is the hit: `don't` highlights `don't`, not `don`.
  const at = phraseIndex(source.words, firstPhrase);
  const first = at === -1 ? undefined : source.words[at];
  const last =
    at === -1 ? undefined : source.words[at + firstPhrase.length - 1];
  const highlighted =
    first && last
      ? `${source.value.slice(0, first.start)}⟦${source.value.slice(
          first.start,
          last.end
        )}⟧${source.value.slice(last.end)}`
      : source.value;
  return { matches: true, snippet: highlighted };
}

export function replicaPendingSearchRank(position: number): number {
  return -1_000_000 + position / 1_000;
}
