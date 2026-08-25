import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import type { ReplicaRow } from "./types.js";

export interface ReplicaLocalSearchSpec {
  columns: readonly string[];
  deletedColumn?: string;
}

/** A document BODY stays online-only; the TITLE is eager, so titles rank
 *  offline. */
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

/**
 * A MIRROR of `ftsMatchExpression` (packages/vault/src/gateway/search.ts): one
 * query must compile to one FTS5 program online and off (#846 P4/P5). Split on
 * WHITESPACE only, and admit a token only for a letter or digit — word-run
 * splitting or `\p{M}` makes the two planes diverge.
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
 *  {@link replicaSearchTokens} (#846 P5). */
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

/** Adjacency is per FIELD, never across the flattened field list. */
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
  // The whole phrase is the hit: `don't` highlights `don't`, not just `don`.
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
