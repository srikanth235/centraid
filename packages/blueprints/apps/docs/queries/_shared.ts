/**
 * Bounded joins over the same windowed document/content ids (#352, #821).
 * NOT a query: the dispatcher resolves `queries/<name>.ts` and never scans
 * the directory, so a helper beside the handlers is invisible to it and to
 * build-manifest.mjs's install-copy walk.
 */

import {
  TAGS_SCHEME_URI,
  conceptsInScheme,
  findScheme,
} from "../../_shared/concept-scheme-kit.ts";

const DOCUMENT_TARGET_TYPE = "core.document";
const FOLDER_CONTAINER_TYPE = "docs.folder";

export interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  pref_label?: string;
  notation?: string;
  broader_concept_id?: string | null;
}

export interface SchemeRow {
  scheme_id: string;
  uri: string;
}

export interface TagRow {
  tag_id: string;
  concept_id: string;
  target_id: string;
  target_type?: string;
  tagged_at?: string;
}

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
 * `schemes`/`concepts` are the SAME reads the caller already made, passed in
 * rather than re-read. Each entry carries its tag_id because untag.ts removes
 * by tag_id, never by label.
 */
export async function readLabelsByDocument({
  ctx,
  purpose,
  documentIds,
  schemes,
  concepts,
}: LabelArgs): Promise<Map<string, LabelEntry[]>> {
  const tagsByDoc = new Map<string, LabelEntry[]>();
  const tagsScheme = findScheme(schemes, TAGS_SCHEME_URI);
  if (!tagsScheme || documentIds.length === 0) return tagsByDoc;
  const labelConceptById = new Map<string, string | undefined>(
    conceptsInScheme(concepts, tagsScheme).map(
      (c) => [c.concept_id, c.pref_label ?? c.notation] as const
    )
  );
  const labelTags = await ctx.vault.read({
    acceptTruncation: true,
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
 * An absent content id means inline bytes custody cannot track, or a sweep
 * that has not run; callers render nothing rather than claim a state the
 * vault never asserted.
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
    acceptTruncation: true,
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

// ─── Who a document is shared with (#821) ─────
// GRACEFUL DENIAL: on an existing vault a newly declared scope parks for the
// owner to approve, and a denial must never take the drive down. This catches
// its own denial and returns `null`, which callers ship as `shared_with: null`
// — "we cannot see", not "shared with nobody" (`[]`).

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

export interface SharedMember {
  party_id: string;
  label: string;
  capability: "read" | "read+write";
  /** `invited` until their vault accepts. REFUSED is not listed: naming them
   *  would assert a reach that was declined. */
  status: "invited" | "current";
}

interface OriginRow {
  target_id: string;
  origin_vault_id: string;
  shared_at?: number | string | null;
}

interface BindingRow {
  party_id: string;
  vault_id: string;
}

interface PartyRow {
  party_id: string;
  display_name?: string | null;
}

/** One inbound placement: which vault delivered a document, and when. */
export interface SharedFromEntry {
  vault_id: string;
  /** `null` is "cannot say who", never "nobody": no live binding names them. */
  party_id: string | null;
  name: string | null;
  /** Landed here, epoch ms. */
  at: number;
}

export interface SharedWithEntry {
  grant_id: string;
  circle_id: string;
  /** Circle name, or recipients for an implicit circle (stored name is machine). */
  label: string;
  /** THIS document or a folder above it — never tell a member the document
   *  itself was shared when it only sits in a shared folder. */
  via: "document" | "folder";
  container_id: string;
  members: SharedMember[];
  member_count: number;
  pending_count: number;
}

/** Bounds every `in`-shaped share read, sized off the caller's window. */
const shareLimit = (ids: number): number =>
  Math.min(Math.max(ids, 1) * 4, 2000);

/**
 * Concept chain above a document, root included. A grant on any of them
 * reaches the document, so this chain bounds the folder-side grant read.
 */
function folderChain(
  conceptId: string | undefined,
  parentOf: Map<string, string | null>
): string[] {
  const chain: string[] = [];
  let at = conceptId;
  // GUARDED, not trusted: the vault does not forbid a broader-concept cycle,
  // and an unguarded walk hangs the drive rather than losing one share.
  while (at && !chain.includes(at) && chain.length < 64) {
    chain.push(at);
    at = parentOf.get(at) ?? undefined;
  }
  return chain;
}

/**
 * A named circle carries the owner's word for the audience. An
 * `implicit_circle` has a machine-generated name nobody chose — the honest
 * label is who is in it.
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
 * `null` when any share read is denied.
 *
 * SHARES DECORATE THE WINDOW, THEY NEVER WIDEN IT: every read below is bounded
 * by ids the caller already holds.
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
  folderByDoc: Map<string, string>;
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
    // Dedupe by grant_id: a grant arriving through both reads would otherwise
    // print the same audience twice on one row.
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

    // Bounded by the roster the circles just named; a member with no party row
    // is "Someone", never an id.
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
          // No state row: the invitation went out and nothing came back.
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
      // Match per container TYPE, never id alone: document ids and folder
      // concept ids are different namespaces.
      const chain = chainByDoc.get(documentId) ?? [];
      const entries = grants
        .filter((g) =>
          g.container_type === DOCUMENT_TARGET_TYPE
            ? g.container_id === documentId
            : chain.includes(g.container_id)
        )
        .map((g) => entryByGrant.get(g.grant_id))
        .filter((e): e is SharedWithEntry => e !== undefined)
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

/** Its own function because its own denial is survivable: an unnamed sender
 *  still belongs on the shelf. */
async function readSenderNames({
  ctx,
  purpose,
  vaultIds,
}: {
  ctx: HandlerCtx;
  purpose: string;
  vaultIds: string[];
}): Promise<{
  partyByVault: Map<string, string>;
  nameByParty: Map<string, string>;
}> {
  const empty = { partyByVault: new Map(), nameByParty: new Map() };
  if (vaultIds.length === 0) return empty;
  try {
    const bindings = await ctx.vault.read({
      entity: "share.party_vault_binding",
      where: [
        { column: "vault_id", op: "in", value: vaultIds },
        // A revoked binding no longer says whose vault that is.
        { column: "revoked_at", op: "is-null" },
      ],
      limit: shareLimit(vaultIds.length),
      purpose,
    });
    const partyByVault = new Map(
      ((bindings.rows ?? []) as unknown as BindingRow[]).map((b) => [
        b.vault_id,
        b.party_id,
      ])
    );
    const partyIds = [...new Set(partyByVault.values())];
    if (partyIds.length === 0) return { partyByVault, nameByParty: new Map() };
    const parties = await ctx.vault.read({
      entity: "core.party",
      where: [{ column: "party_id", op: "in", value: partyIds }],
      limit: shareLimit(partyIds.length),
      purpose,
    });
    return {
      partyByVault,
      nameByParty: new Map(
        ((parties.rows ?? []) as unknown as PartyRow[]).flatMap((p) => {
          const name = p.display_name?.trim();
          return name ? [[p.party_id, name] as const] : [];
        })
      ),
    };
  } catch {
    return empty;
  }
}

/**
 * Where a document came from (#903). NOT bounded by the caller's window: it is
 * what DISCOVERS rows, so the caller unions these ids in and `limit` is the
 * only bound. No binding, no name — never a vault id worn as one.
 */
export async function readOriginsByDocument({
  ctx,
  purpose,
  limit,
}: {
  ctx: HandlerCtx;
  purpose: string;
  limit: number;
}): Promise<Map<string, SharedFromEntry> | null> {
  try {
    const origins = await ctx.vault.read({
      acceptTruncation: true,
      entity: "core.share_origin",
      where: [{ column: "target_type", op: "eq", value: DOCUMENT_TARGET_TYPE }],
      orderBy: { column: "shared_at", dir: "desc" },
      limit,
      purpose,
    });
    const originRows = (origins.rows ?? []) as unknown as OriginRow[];
    if (originRows.length === 0) return new Map();

    // A LOST NAME IS NOT A LOST ARRIVAL: only a denied placement is unknown.
    const { partyByVault, nameByParty } = await readSenderNames({
      ctx,
      purpose,
      vaultIds: [...new Set(originRows.map((o) => o.origin_vault_id))],
    });

    return new Map(
      originRows.map((o) => {
        const partyId = partyByVault.get(o.origin_vault_id) ?? null;
        return [
          o.target_id,
          {
            vault_id: o.origin_vault_id,
            party_id: partyId,
            name: partyId ? (nameByParty.get(partyId) ?? null) : null,
            at: Number(o.shared_at) || 0,
          } satisfies SharedFromEntry,
        ];
      })
    );
  } catch {
    return null;
  }
}
