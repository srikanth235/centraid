import { RELATIONS_SCHEME_URI } from "../_shared/concept-scheme-kit.ts";
import type { VaultRow } from "./filing.ts";
import { decodeTextContent } from "./format.ts";
import type { NoteVersion } from "./types.ts";

const REVISES_NOTATION = "revises";
const CONTENT_TYPE = "core.content_item";
const MAX_CHAIN_STEPS = 500;

function text(row: VaultRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export interface ChainRows {
  headContentId: string;
  links: readonly VaultRow[];
  concepts: readonly VaultRow[];
  schemes: readonly VaultRow[];
}

export interface NoteVersionChain {
  contentIds: readonly string[];
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
  contents: readonly VaultRow[];
  createdAt?: string;
}

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
