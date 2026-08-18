// A document's version chain, walked over THIS DEVICE'S replica rows
// (issue #821, spec §10: "every change is a version and nothing is ever
// overwritten").
//
// The web seat asks the gateway (`queries/history.ts`); the phone holds the
// same facts already — `core.link` is in the docs manifest's read scopes and
// replicates — so the walk is re-expressed here over plain rows, mirroring
// the gateway handler edge for edge: start at the wrapper's
// `current_content_id`, follow the single live `revises` edge OUT of each
// content item (NEW → OLD, the direction commands/revisions.ts asserts) to
// the version it superseded, stop at the never-revised original or at a
// content id already visited (a restore gives an OLD version a NEW outgoing
// edge, which can cycle the graph). Each entry's date is the ASSERTION time
// of the edge that superseded it — the vault's own record — never the
// content item's mint time.
//
// WHAT IS NOT HERE, deliberately: who made each version. That is a
// `consent.provenance` fact, and this phone's replica does not carry
// provenance rows — the screen states that absence instead of guessing
// (INTEGRATION-NOTES.md → Withholdings). No diff is computed anywhere: the
// codebase cannot render a real one on this seat, so none is drawn.
//
// Pure and react-free — plain rows in, plain view models out.

import type { EntityRow } from "./docs-projection";

// Mirrors packages/vault/src/commands/links.ts's RELATIONS_SCHEME_URI and the
// relation the revision recorder writes.
const RELATIONS_SCHEME_URI = "urn:duaility:relations";
const REVISES_RELATION = "revises";
const CONTENT_TYPE = "core.content_item";
// One walk step per version; the cap only stops runaway growth (the same
// number the gateway handler uses).
const MAX_CHAIN_STEPS = 500;

const str = (row: EntityRow, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const num = (row: EntityRow, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" ? value : null;
};

export interface MobileVersionEntry {
  /** 1 is the original; the current version is `versionCount`. */
  n: number;
  content_id: string;
  media_type: string | null;
  byte_size: number | null;
  current: boolean;
  /** The revises edge's own valid_from; the oldest entry dates from its mint. */
  asserted_at: string;
}

export interface VersionChain {
  entries: MobileVersionEntry[];
  versionCount: number;
  currentContentId: string;
}

export interface VersionChainRows {
  /** The one `core.document` row this chain belongs to. */
  document: EntityRow | undefined;
  links: readonly EntityRow[];
  contents: readonly EntityRow[];
  concepts: readonly EntityRow[];
  schemes: readonly EntityRow[];
}

/**
 * The chain, newest first, or `null` when the document row itself is absent.
 * A vault where nothing has ever been edited/replaced/restored has no
 * `revises` concept at all — every document is honestly its own one-entry
 * history, exactly as the gateway handler renders it.
 */
export function projectVersionChain(
  rows: VersionChainRows
): VersionChain | null {
  const doc = rows.document;
  if (!doc) return null;
  const currentContentId = str(doc, "current_content_id");
  if (!currentContentId) return null;

  const relSchemeId =
    rows.schemes.flatMap((scheme) =>
      str(scheme, "uri") === RELATIONS_SCHEME_URI
        ? [str(scheme, "scheme_id") ?? ""]
        : []
    )[0] ?? null;
  const revisesConceptId =
    relSchemeId === null
      ? null
      : (rows.concepts.flatMap((concept) =>
          str(concept, "scheme_id") === relSchemeId &&
          str(concept, "notation") === REVISES_RELATION
            ? [str(concept, "concept_id") ?? ""]
            : []
        )[0] ?? null);

  // Live revises edges out of a content item, newest assertion first — the
  // same `orderBy valid_from desc, limit`-shaped pick the gateway makes.
  const edgesFrom = new Map<string, { to: string; valid_from: string }[]>();
  if (revisesConceptId !== null) {
    for (const link of rows.links) {
      if (str(link, "from_type") !== CONTENT_TYPE) continue;
      if (str(link, "to_type") !== CONTENT_TYPE) continue;
      if (str(link, "relation_concept_id") !== revisesConceptId) continue;
      if (str(link, "valid_to") !== null) continue;
      const from = str(link, "from_id");
      const to = str(link, "to_id");
      const validFrom = str(link, "valid_from");
      if (!from || !to || !validFrom) continue;
      const list = edgesFrom.get(from);
      const entry = { to, valid_from: validFrom };
      if (list) list.push(entry);
      else edgesFrom.set(from, [entry]);
    }
    for (const list of edgesFrom.values())
      list.sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  }

  const chainIds = [currentContentId];
  const assertedAtOf = new Map<string, string>();
  const seen = new Set([currentContentId]);
  let at = currentContentId;
  for (let step = 0; step < MAX_CHAIN_STEPS; step += 1) {
    const next = edgesFrom.get(at)?.[0];
    if (!next || seen.has(next.to)) break;
    assertedAtOf.set(at, next.valid_from);
    chainIds.push(next.to);
    seen.add(next.to);
    at = next.to;
  }

  const contentById = new Map(
    rows.contents.flatMap((content) => {
      const id = str(content, "content_id");
      return id ? [[id, content] as const] : [];
    })
  );

  const count = chainIds.length;
  const entries = chainIds.map((id, index): MobileVersionEntry => {
    const content = contentById.get(id);
    return {
      n: count - index,
      content_id: id,
      media_type: content ? str(content, "media_type") : null,
      byte_size: content ? num(content, "byte_size") : null,
      current: index === 0,
      asserted_at:
        assertedAtOf.get(id) ??
        (content ? str(content, "created_at") : null) ??
        str(doc, "created_at") ??
        "",
    };
  });

  return { entries, versionCount: count, currentContentId };
}
