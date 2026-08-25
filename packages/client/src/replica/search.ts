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

/**
 * Mirrors the canonical gateway's token cleanup and 16-token bound.
 *
 * This is a MIRROR, not an approximation: the body must stay line-for-line
 * equivalent to `ftsMatchExpression` in packages/vault/src/gateway/search.ts,
 * because the same query has to compile to the same FTS5 program whether it is
 * answered online or off. Two earlier divergences are why that is spelled out
 * (#846 P4/P5):
 *
 *  - the split. The gateway splits on whitespace ONLY, so `don't` is one token
 *    and compiles to one prefix phrase. Re-splitting on Unicode word runs made
 *    it two, which also applied the 16-token bound to a different token stream,
 *    so the two planes ranked and truncated differently for any query holding
 *    punctuation.
 *  - the admission test. The gateway keeps a token that contains a letter or a
 *    digit. Admitting `\p{M}` as well meant a query of only combining marks was
 *    refused online and searched offline — the replica answering a question the
 *    gateway declines.
 *
 * The gateway signals "nothing searchable" by returning null; the replica says
 * the same thing by throwing, which is the one difference that is deliberate.
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
 * One MATCH token as FTS5 actually reads it: a quoted PHRASE of unicode61 word
 * runs, with the trailing `*` making only the last run a prefix. `"don't"*` is
 * the phrase (`don`, `t`*) — two adjacent words, not two independent terms.
 *
 * The token stream is the gateway's (whitespace-split, #846 P5), so the
 * punctuation split happens HERE rather than in {@link replicaSearchTokens},
 * where it belongs: it is a property of the tokenizer reading the phrase, not
 * of the expression compiler writing it.
 */
function tokenPhrase(token: string): string[] {
  return [...token.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match) =>
    foldSearchText(match[0])
  );
}

/**
 * Index of the first word at which `phrase` matches `words` adjacently, with
 * prefix semantics on the phrase's last run. `-1` when it does not match.
 */
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

/**
 * Exact bounded matcher for an unsettled row that is not in canonical FTS yet.
 * FTS5's contract here is an AND of quoted prefix PHRASES over eager scalar
 * columns; pending rows use that same grammar and receive an explicit
 * provisional rank. Canonical rows keep SQLite's BM25 rank. This is not a
 * body-search guess: only columns already admitted by
 * {@link replicaLocalSearchSpec} participate.
 *
 * Adjacency is evaluated per FIELD, never across the flattened field list: two
 * words that are adjacent only because one column's text ends where the next
 * begins are not adjacent to FTS5 either.
 */
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
  // The whole phrase is the hit, so the marks span its first word through its
  // last — `don't` highlights `don't`, not just `don`.
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

/** Pending hits sort deterministically ahead of stale canonical BM25 hits. */
export function replicaPendingSearchRank(position: number): number {
  return -1_000_000 + position / 1_000;
}
