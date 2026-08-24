/**
 * Shared read/join helpers for the docs app's queries (#352) —
 * pulled out once drive.ts and search.ts both needed the SAME bounded joins
 * over the same windowed document/content ids: free-form labels
 * (core.tag_item/untag_item over the shared "Tags" scheme —
 * packages/vault/src/commands/tags.ts, shared with notes/tasks) and the
 * blob custody projection
 * (blob.custody_state, blob/custody.ts) and, since #821, who a document
 * is shared with (the share.circle_grant × social.circle_member ×
 * share.commons_member_state join that packages/vault/src/share/
 * commons-lifecycle.ts runs steward-side, here scoped to the windowed
 * documents and their folder ancestors). Mirrors the photos app's own
 * queries/_shared.js readAssetJoins split, minus the parts specific to media
 * (favorite star and place stay inline in drive.ts/search.ts — they already
 * ride the SAME core.tag/concept/concept_scheme reads those files make for
 * folders, so factoring them out here would just add a second round trip).
 *
 * NOT a query itself — the dispatcher resolves a query name straight to
 * `queries/<name>.ts` (never a directory scan: packages/server/src/engine/
 * handlers/dispatcher.ts), so a plain helper module beside the handlers is
 * invisible to it and to build-manifest.mjs's install-copy walk; nothing
 * needs to know this file exists besides the two callers that import it.
 */

const TAGS_SCHEME_URI = "centraid:tags:v1";
const DOCUMENT_TARGET_TYPE = "core.document";
const FOLDER_CONTAINER_TYPE = "docs.folder";

/** A folders/flags/tags-scheme concept row (the SKOS vocabulary). */
export interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  pref_label?: string;
  notation?: string;
  broader_concept_id?: string | null;
}

/** A concept-scheme row (keyed by its stable URI). */
export interface SchemeRow {
  scheme_id: string;
  uri: string;
}

/** A core.tag edge row. */
export interface TagRow {
  tag_id: string;
  concept_id: string;
  target_id: string;
  target_type?: string;
  tagged_at?: string;
}

/** One free-form label carried by a document, keyed by document_id. */
export interface LabelEntry {
  tag_id: string;
  label: string;
}

interface LabelArgs {
  ctx: HandlerCtx;
  purpose: string;
  documentIds: string[];
  schemes: SchemeRow[];
  concepts: ConceptRow[];
}

/**
 * Free-form labels for the windowed document ids, keyed by document_id —
 * `{ document_id -> {tag_id, label}[] }`. `schemes`/`concepts` are the SAME
 * core.concept_scheme/core.concept reads the caller already made for the
 * folders scheme (and, in drive.ts, the flags scheme) — passed in rather
 * than re-read, since a personal vault's whole concept table is small and
 * already unbounded-read once per query. Each entry carries its tag_id:
 * untag.ts removes by tag_id (core.untag_item), not by label.
 */
export async function readLabelsByDocument({
  ctx,
  purpose,
  documentIds,
  schemes,
  concepts,
}: LabelArgs): Promise<Map<string, LabelEntry[]>> {
  const tagsByDoc = new Map<string, LabelEntry[]>();
  const tagsScheme = (schemes ?? []).find((s) => s.uri === TAGS_SCHEME_URI);
  if (!tagsScheme || documentIds.length === 0) return tagsByDoc;
  const labelConceptById = new Map<string, string | undefined>(
    (concepts ?? [])
      .filter((c) => c.scheme_id === tagsScheme.scheme_id)
      .map((c) => [c.concept_id, c.pref_label ?? c.notation] as const)
  );
  const labelTags = await ctx.vault.read({
    entity: "core.tag",
    where: [
      { column: "target_type", op: "eq", value: DOCUMENT_TARGET_TYPE },
      { column: "target_id", op: "in", value: documentIds },
    ],
    purpose,
  });
  for (const t of (labelTags.rows ?? []) as unknown as TagRow[]) {
    const label = labelConceptById.get(t.concept_id);
    if (!label) continue; // a tag on this document from some OTHER scheme (folders/flags)
    if (!tagsByDoc.has(t.target_id)) tagsByDoc.set(t.target_id, []);
    tagsByDoc.get(t.target_id)!.push({ tag_id: t.tag_id, label });
  }
  return tagsByDoc;
}

interface CustodyRow {
  content_id: string;
  custody_state: string;
}

/**
 * The blob custody projection for the windowed CURRENT content ids, keyed by
 * content_id. A content id absent from the map means either its bytes never
 * left vault.db (an inline `data:` document — custody has nothing to track)
 * or the standing sweep simply hasn't run yet; callers render nothing for a
 * missing entry rather than claim a state the vault never asserted.
 */
export async function readCustodyByContent({
  ctx,
  purpose,
  contentIds,
}: {
  ctx: HandlerCtx;
  purpose: string;
  contentIds: string[];
}): Promise<Map<string, string>> {
  if (contentIds.length === 0) return new Map();
  const custody = await ctx.vault.read({
    entity: "blob.custody_state",
    where: [{ column: "content_id", op: "in", value: contentIds }],
    purpose,
  });
  return new Map(
    ((custody.rows ?? []) as unknown as CustodyRow[]).map((c) => [
      c.content_id,
      c.custody_state,
    ])
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Who a document is shared with (#821)
// ───────────────────────────────────────────────────────────────────────────
//
// GRACEFUL DENIAL is why this read is a seam of its own. Docs' `share.*` and
// `core.party` scopes are newer than the app, and on an EXISTING vault a newly
// declared scope parks for the owner to approve rather than being auto-granted.
// A denial here must never take the drive down with it: this helper catches its
// own denial and returns `null`, which the callers ship as `shared_with: null`
// on every row — "we cannot see", which is a different sentence from "shared
// with nobody" (`[]`) and is worded differently on screen.

/** A live commons grant over one container. */
interface GrantRow {
  grant_id: string;
  circle_id: string;
  container_type: string;
  container_id: string;
  implicit_circle?: number | null;
}

interface CircleRow {
  circle_id: string;
  name?: string | null;
}

interface CircleMemberRow {
  circle_id: string;
  party_id: string;
  capability?: "read" | "read+write" | null;
}

interface MemberStateRow {
  grant_id: string;
  party_id: string;
  status: "invited" | "current" | "refused";
}

interface PartyRow {
  party_id: string;
  display_name?: string | null;
}

/** One person a document reaches through a grant. */
export interface SharedMember {
  party_id: string;
  label: string;
  capability: "read" | "read+write";
  /** `invited` until the member's own vault has accepted. A member who
   *  refused is not listed at all — naming them as shared-with would be the
   *  rail asserting a reach that was declined. */
  status: "invited" | "current";
}

/** One live share a document sits inside, as the app renders it. */
export interface SharedWithEntry {
  grant_id: string;
  circle_id: string;
  /** What the member reads: the circle's own name, or — for a circle the
   *  sharing flow created implicitly for one-off recipients — the recipients'
   *  names, because an implicit circle's stored name is a machine string. */
  label: string;
  /** Whether the grant names THIS document or a folder above it. The rail
   *  says "through <folder>" for the second, so a member is never told the
   *  document itself was shared when its folder was. */
  via: "document" | "folder";
  /** The granted container's id — the folder whose name the rail prints when
   *  `via` is `folder`, and the document's own id otherwise. */
  container_id: string;
  members: SharedMember[];
  member_count: number;
  /** How many of `members` have not accepted yet. */
  pending_count: number;
}

/** A bound for every `in`-shaped share read, sized off the caller's window. */
const shareLimit = (ids: number): number =>
  Math.min(Math.max(ids, 1) * 4, 2000);

/**
 * The folders-scheme concept chain above a document, root included: the
 * document's own folder, then each broader concept, walked client-side off
 * concepts already in hand. A grant on any of them reaches the document, so
 * the chain is what the folder-side grant read is bounded by.
 */
function folderChain(
  conceptId: string | undefined,
  parentOf: Map<string, string | null>
): string[] {
  const chain: string[] = [];
  let at = conceptId;
  // The walk is GUARDED rather than trusted: a broader-concept cycle is data
  // the vault does not forbid, and an unguarded walk would hang the drive
  // rather than lose one share.
  while (at && !chain.includes(at) && chain.length < 64) {
    chain.push(at);
    at = parentOf.get(at) ?? undefined;
  }
  return chain;
}

/**
 * What a share is CALLED, honestly.
 *
 * A named circle carries the owner's own word for the audience ("Family"), and
 * that is what the rail prints. A circle the sharing flow minted for a one-off
 * recipient (`implicit_circle`) has a machine-generated name nobody chose, so
 * printing it would show a member an internal string; the honest label there is
 * who is actually in it.
 */
function shareLabel(
  grant: GrantRow,
  circle: CircleRow | undefined,
  memberLabels: string[]
): string {
  const implicit = Number(grant.implicit_circle ?? 0) === 1;
  if (!implicit && circle?.name) return circle.name;
  if (memberLabels.length === 0) return circle?.name ?? "a circle";
  const shown = memberLabels.slice(0, 2).join(" and ");
  const rest = memberLabels.length - 2;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * Who each windowed document is shared with, keyed by document_id — or `null`
 * when any of the share reads is denied.
 *
 * SHARES DECORATE THE WINDOW, THEY NEVER WIDEN IT. Every read below is bounded
 * by ids the caller already holds: the windowed document ids, the folder
 * concepts above them, then the circles those grants name and the parties those
 * circles hold. Nothing here can pull a whole table.
 */
export async function readSharesByDocument({
  ctx,
  purpose,
  documentIds,
  folderByDoc,
  folderConcepts,
}: {
  ctx: HandlerCtx;
  purpose: string;
  documentIds: string[];
  /** Each windowed document's own folders-scheme concept id (root included). */
  folderByDoc: Map<string, string>;
  /** The folders scheme's concepts — the parent chain is walked off these. */
  folderConcepts: ConceptRow[];
}): Promise<Map<string, SharedWithEntry[]> | null> {
  if (documentIds.length === 0) return new Map();
  const parentOf = new Map<string, string | null>(
    folderConcepts.map((c) => [c.concept_id, c.broader_concept_id ?? null])
  );
  const chainByDoc = new Map<string, string[]>(
    documentIds.map((id) => [id, folderChain(folderByDoc.get(id), parentOf)])
  );
  const folderIds = [...new Set([...chainByDoc.values()].flat())];

  try {
    const grantRead = (type: string, ids: string[]) => ({
      entity: "share.circle_grant",
      where: [
        { column: "plane", op: "eq" as const, value: "commons" },
        { column: "container_type", op: "eq" as const, value: type },
        { column: "container_id", op: "in" as const, value: ids },
        { column: "revoked_at", op: "is-null" as const },
      ],
      limit: shareLimit(ids.length),
      purpose,
    });
    const [docGrants, folderGrants] = await Promise.all([
      ctx.vault.read(grantRead(DOCUMENT_TARGET_TYPE, documentIds)),
      folderIds.length > 0
        ? ctx.vault.read(grantRead(FOLDER_CONTAINER_TYPE, folderIds))
        : { rows: [] as Record<string, unknown>[] },
    ]);
    // Deduplicated by grant_id: the two reads are disjoint by container_type
    // in the vault, but a grant that arrived through both would otherwise
    // print the same audience twice on the same row.
    const grants = [
      ...new Map(
        [
          ...((docGrants.rows ?? []) as unknown as GrantRow[]),
          ...((folderGrants.rows ?? []) as unknown as GrantRow[]),
        ].map((g) => [g.grant_id, g] as const)
      ).values(),
    ];
    if (grants.length === 0) return new Map();

    const circleIds = [...new Set(grants.map((g) => g.circle_id))];
    const grantIds = grants.map((g) => g.grant_id);
    const [circles, members, states] = await Promise.all([
      ctx.vault.read({
        entity: "social.circle",
        where: [{ column: "circle_id", op: "in", value: circleIds }],
        limit: shareLimit(circleIds.length),
        purpose,
      }),
      ctx.vault.read({
        entity: "social.circle_member",
        where: [{ column: "circle_id", op: "in", value: circleIds }],
        limit: shareLimit(circleIds.length),
        purpose,
      }),
      ctx.vault.read({
        entity: "share.commons_member_state",
        where: [{ column: "grant_id", op: "in", value: grantIds }],
        limit: shareLimit(grantIds.length),
        purpose,
      }),
    ]);
    const circleRows = (circles.rows ?? []) as unknown as CircleRow[];
    const memberRows = (members.rows ?? []) as unknown as CircleMemberRow[];
    const stateRows = (states.rows ?? []) as unknown as MemberStateRow[];

    // Party labels are a read of their own, bounded by the roster the circles
    // just named — a member with no party row is "Someone", never an id.
    const partyIds = [...new Set(memberRows.map((m) => m.party_id))];
    const parties =
      partyIds.length > 0
        ? await ctx.vault.read({
            entity: "core.party",
            where: [{ column: "party_id", op: "in", value: partyIds }],
            limit: shareLimit(partyIds.length),
            purpose,
          })
        : { rows: [] as Record<string, unknown>[] };
    const nameByParty = new Map(
      ((parties.rows ?? []) as unknown as PartyRow[]).map((p) => [
        p.party_id,
        p.display_name ?? null,
      ])
    );

    const circleById = new Map(circleRows.map((c) => [c.circle_id, c]));
    const membersByCircle = new Map<string, CircleMemberRow[]>();
    for (const m of memberRows) {
      const list = membersByCircle.get(m.circle_id);
      if (list) list.push(m);
      else membersByCircle.set(m.circle_id, [m]);
    }
    const statusByGrantParty = new Map(
      stateRows.map((s) => [`${s.grant_id} ${s.party_id}`, s.status])
    );

    const entryByGrant = new Map<string, SharedWithEntry>();
    for (const grant of grants) {
      const roster = (membersByCircle.get(grant.circle_id) ?? [])
        .map((m) => ({
          party_id: m.party_id,
          label: nameByParty.get(m.party_id) ?? "Someone",
          capability: m.capability ?? "read",
          // No state row yet means the invitation has gone out and nothing
          // has come back — invited, not current.
          status:
            statusByGrantParty.get(`${grant.grant_id} ${m.party_id}`) ??
            "invited",
        }))
        .filter((m) => m.status !== "refused")
        .toSorted((a, b) => a.label.localeCompare(b.label)) as SharedMember[];
      entryByGrant.set(grant.grant_id, {
        grant_id: grant.grant_id,
        circle_id: grant.circle_id,
        label: shareLabel(
          grant,
          circleById.get(grant.circle_id),
          roster.map((m) => m.label)
        ),
        via:
          grant.container_type === DOCUMENT_TARGET_TYPE ? "document" : "folder",
        container_id: grant.container_id,
        members: roster,
        member_count: roster.length,
        pending_count: roster.filter((m) => m.status === "invited").length,
      });
    }

    const byDocument = new Map<string, SharedWithEntry[]>();
    for (const documentId of documentIds) {
      // Reach is matched per container TYPE, never on the id alone: a
      // document id and a folder concept id are different namespaces, and
      // comparing across them is how a share lands on the wrong row.
      const chain = chainByDoc.get(documentId) ?? [];
      const entries = grants
        .filter((g) =>
          g.container_type === DOCUMENT_TARGET_TYPE
            ? g.container_id === documentId
            : chain.includes(g.container_id)
        )
        .map((g) => entryByGrant.get(g.grant_id))
        .filter((e): e is SharedWithEntry => e !== undefined)
        // The document's own grant leads: it is the fact the member acted on.
        .toSorted(
          (a, b) =>
            (a.via === "document" ? 0 : 1) - (b.via === "document" ? 0 : 1) ||
            a.label.localeCompare(b.label)
        );
      if (entries.length > 0) byDocument.set(documentId, entries);
    }
    return byDocument;
  } catch {
    return null;
  }
}
