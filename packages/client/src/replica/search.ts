import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import type { ReplicaRow } from "./types.js";

/** A replica-local search surface composed only from eager scalar row metadata. */
export interface ReplicaLocalSearchSpec {
  columns: readonly string[];
  /** Non-null rows are absent from the canonical FTS index. */
  deletedColumn?: string;
}

/**
 * Direct-column subset of the canonical vault FTS contract. A folded document
 * BODY stays online-only (its bytes are not eager replica metadata), but the
 * document TITLE is an eager scalar on core.document, so the native Docs drive
 * can rank titles offline; a body match still needs the canonical FTS online.
 */
export const REPLICA_LOCAL_SEARCH: Readonly<
  Record<string, ReplicaLocalSearchSpec>
> = {
  "core.content_item": { columns: ["title"], deletedColumn: "deleted_at" },
  "core.document": { columns: ["title"], deletedColumn: "deleted_at" },
  "social.thread": { columns: ["subject"] },
  "core.party": { columns: ["display_name", "sort_name"] },
  "social.contact_card": { columns: ["nickname", "org_title"] },
  "knowledge.annotation": { columns: ["body_text"] },
  "schedule.task": { columns: ["title", "description"] },
  "core.event": { columns: ["summary", "description"] },
  "core.transaction": { columns: ["description"] },
  "home.asset_item": { columns: ["name", "serial_no"] },
  "people.profile": { columns: ["role"] },
  "locker.item": {
    columns: ["title", "username", "url"],
    deletedColumn: "deleted_at",
  },
  "tally.expense": { columns: ["description"] },
};

export function replicaLocalSearchSpec(entity: string): ReplicaLocalSearchSpec {
  const spec = REPLICA_LOCAL_SEARCH[entity];
  if (!spec) {
    throw new OnlineOnlyError(
      `entity ${entity} has no complete eager-metadata search surface in the replica`
    );
  }
  return spec;
}

/** Mirrors the canonical gateway's token cleanup and 16-token bound. */
export function replicaSearchTokens(query: string): string[] {
  if (typeof query !== "string")
    throw new ReplicaProtocolError("Search query must be a string");
  const tokens = query
    .split(/\s+/u)
    .map((token) => token.replaceAll('"', ""))
    .flatMap((token) =>
      [...token.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match) => match[0])
    )
    .slice(0, 16);
  if (tokens.length === 0) {
    throw new ReplicaProtocolError("Search query has no searchable words");
  }
  return tokens;
}

/** Mirrors the canonical gateway's fixed FTS prefix grammar. */
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

/** Default FTS5 unicode61 word boundaries, including punctuation splitting. */
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

/**
 * Exact bounded matcher for an unsettled row that is not in canonical FTS yet.
 * FTS5's contract here is an AND of word prefixes over eager scalar columns;
 * pending rows use that same grammar and receive an explicit provisional rank.
 * Canonical rows keep SQLite's BM25 rank. This is not a body-search guess: only
 * columns already admitted by {@link replicaLocalSearchSpec} participate.
 */
export function replicaPendingSearchMatch(
  row: ReplicaRow,
  spec: ReplicaLocalSearchSpec,
  query: string
): { matches: boolean; snippet: string } {
  if (spec.deletedColumn && row[spec.deletedColumn] != null)
    return { matches: false, snippet: "" };
  const tokens = replicaSearchTokens(query).map(foldSearchText);
  const fields = spec.columns.flatMap((column) => {
    const value = row[column];
    return typeof value === "string" ? [value] : [];
  });
  const words = fields.flatMap(searchWords);
  if (
    !tokens.every((token) =>
      words.some((word) => word.folded.startsWith(token))
    )
  )
    return { matches: false, snippet: "" };
  const firstToken = tokens[0]!;
  const source = fields
    .map((value) => ({ value, words: searchWords(value) }))
    .find(({ words: sourceWords }) =>
      sourceWords.some((word) => word.folded.startsWith(firstToken))
    ) ?? { value: fields[0] ?? "", words: [] };
  const highlightedWord = source.words.find((word) =>
    word.folded.startsWith(firstToken)
  );
  const highlighted = highlightedWord
    ? `${source.value.slice(0, highlightedWord.start)}⟦${source.value.slice(
        highlightedWord.start,
        highlightedWord.end
      )}⟧${source.value.slice(highlightedWord.end)}`
    : source.value;
  return { matches: true, snippet: highlighted };
}

/** Pending hits sort deterministically ahead of stale canonical BM25 hits. */
export function replicaPendingSearchRank(position: number): number {
  return -1_000_000 + position / 1_000;
}
