import type { VaultRow } from "./filing.ts";
// The note's body history as a value: the append-only `revises` content-item
// chain, walked from the live head backwards, newest first.
//
// THE CHAIN IS APPEND-ONLY. A restore appends a new head pointing at the body
// it brings back; nothing between is rewritten or dropped, which is why the
// walk can only ever grow and why `current` is a position (index 0), never a
// stored flag. Both seats read this walk — the pointer seats through
// `queries/history.ts`'s vault reads, the phone off its own replica.
import { decodeTextContent } from "./format.ts";
import type { NoteVersion } from "./types.ts";

const RELATIONS_SCHEME_URI = "urn:duaility:relations";
const REVISES_NOTATION = "revises";
const CONTENT_TYPE = "core.content_item";
/** A cycle is possible (a restore points back at an older body); this bounds
 *  the walk regardless of how the edges are shaped. */
const MAX_CHAIN_STEPS = 500;

function text(row: VaultRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export interface ChainRows {
  /** The note's live `body_content_id` — the head of the chain. */
  headContentId: string;
  /** `core.link` rows. */
  links: readonly VaultRow[];
  /** `core.concept` rows. */
  concepts: readonly VaultRow[];
  /** `core.concept_scheme` rows. */
  schemes: readonly VaultRow[];
}

export interface NoteVersionChain {
  /** Head first, then each older body. */
  contentIds: readonly string[];
  /** When the edge OUT of a content id was asserted — that version's date. */
  assertedAt: ReadonlyMap<string, string>;
}

export function revisesConceptId(rows: {
  concepts: readonly VaultRow[];
  schemes: readonly VaultRow[];
}): string | null {
  const relations = rows.schemes.find(
    (scheme) => text(scheme, "uri") === RELATIONS_SCHEME_URI
  );
  if (!relations) return null;
  const schemeId = text(relations, "scheme_id");
  const concept = rows.concepts.find(
    (row) =>
      text(row, "scheme_id") === schemeId &&
      text(row, "notation") === REVISES_NOTATION
  );
  return concept ? text(concept, "concept_id") || null : null;
}

/** The ids alone, so a caller can bound its content read to the chain. */
export function noteVersionChain(rows: ChainRows): NoteVersionChain {
  const head = rows.headContentId;
  const assertedAt = new Map<string, string>();
  if (!head) return { contentIds: [], assertedAt };

  const relation = revisesConceptId(rows);
  const older = new Map<string, { to: string; validFrom: string }[]>();
  if (relation) {
    for (const link of rows.links) {
      if (text(link, "from_type") !== CONTENT_TYPE) continue;
      if (text(link, "to_type") !== CONTENT_TYPE) continue;
      if (text(link, "relation_concept_id") !== relation) continue;
      if (link["valid_to"] != null) continue;
      const from = text(link, "from_id");
      const to = text(link, "to_id");
      const validFrom = text(link, "valid_from");
      if (!from || !to || !validFrom) continue;
      const edges = older.get(from);
      if (edges) edges.push({ to, validFrom });
      else older.set(from, [{ to, validFrom }]);
    }
    for (const edges of older.values())
      edges.sort((left, right) =>
        right.validFrom.localeCompare(left.validFrom)
      );
  }

  const contentIds = [head];
  const seen = new Set([head]);
  let at = head;
  for (let step = 0; step < MAX_CHAIN_STEPS; step += 1) {
    const next = older.get(at)?.[0];
    if (!next || seen.has(next.to)) break;
    assertedAt.set(at, next.validFrom);
    seen.add(next.to);
    contentIds.push(next.to);
    at = next.to;
  }
  return { contentIds, assertedAt };
}

export interface VersionRows {
  chain: NoteVersionChain;
  /** `core.content_item` rows for the chain's ids. */
  contents: readonly VaultRow[];
  /** The note's own `created_at`, for the oldest body's date. */
  createdAt?: string;
}

/** Newest first. An unreadable body is "" — the row says so rather than
 *  inventing text it does not hold. */
export function projectNoteVersions(rows: VersionRows): NoteVersion[] {
  const byId = new Map(
    rows.contents.flatMap((content): Array<[string, VaultRow]> => {
      const id = text(content, "content_id");
      return id ? [[id, content]] : [];
    })
  );
  return rows.chain.contentIds.map((contentId, index) => {
    const content = byId.get(contentId);
    const dated =
      rows.chain.assertedAt.get(contentId) ??
      (content ? text(content, "created_at") : "");
    return {
      content_id: contentId,
      body: decodeTextContent(content?.["content_uri"]),
      current: index === 0,
      asserted_at: dated || rows.createdAt || "",
    };
  });
}
