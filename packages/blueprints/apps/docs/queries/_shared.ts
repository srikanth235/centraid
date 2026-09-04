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

// ─── Who a document is shared with (#821, #929) ─────
// GRACEFUL DENIAL: on an existing vault a newly declared scope parks for the
// owner to approve, and a denial must never take the drive down. This catches
// its own denial and returns `null`, which callers ship as `shared_with: null`
// — "we cannot see", not "shared with nobody" (`[]`).
//
// A SHARE IS A STANDING ANSWER, NOT A ROSTER (#929). `share_authority` holds
// who may reach this document — one person, or one circle — and
// `share_fulfillment` holds whether it has actually reached them. Nothing here
// reads a membership plane of its own.

interface AuthorityRow {
  authority_id: string;
  principal_kind: string;
  principal_id: string;
  subject_type: string;
  subject_id: string;
  verb: string;
  expires_at?: string | null;
}

interface CircleRow {
  circle_id: string;
  name?: string | null;
}

interface CircleMemberRow {
  circle_id: string;
  party_id: string;
}

interface FulfillmentRow {
  grant_id: string;
  peer_vault_id: string;
  delivered_at?: string | null;
}

interface PartyRow {
  party_id: string;
  display_name?: string | null;
}

export interface SharedMember {
  party_id: string;
  label: string;
  capability: "read" | "read+write";
  /** `invited` until the subject has reached their vault. */
  status: "invited" | "current";
}

interface SubscriptionRow {
  shape_id: string;
  origin_vault_id: string;
  subscribed_at?: string | null;
}

interface LineageRow {
  shape_id: string;
  target_type: string;
  target_id: string;
}

interface BindingRow {
  party_id: string;
  vault_id: string;
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
  /** The circle a `circle` audience names; `null` where one person is it. */
  circle_id: string | null;
  /** Which kind of audience the standing answer names (#929). */
  audience: "person" | "circle";
  /** The circle's name, or the person's — whoever the answer is about. */
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

/** The two verbs a share answer carries, in the words both seats print. */
const CAPABILITY_OF_VERB: Readonly<Record<string, "read" | "read+write">> = {
  view: "read",
  edit: "read+write",
};

/**
 * Concept chain above a document, root included. An answer over any of them
 * reaches the document, so this chain bounds the folder-side read.
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
 * LIVE is granted AND not run out (#916, review 6.1): `revoked_at` is filtered
 * in the read, `expires_at` here, because a time-boxed share that keeps
 * answering yes is the same defect on the drive as it was in the resolver.
 */
function liveAt(row: AuthorityRow, now: string): boolean {
  return row.expires_at == null || row.expires_at > now;
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
    const answerRead = (subjectType: string, ids: string[]) => ({
      entity: "share.authority",
      where: [
        { column: "subject_type", op: "eq" as const, value: subjectType },
        { column: "subject_id", op: "in" as const, value: ids },
        { column: "decision", op: "eq" as const, value: "granted" },
        { column: "revoked_at", op: "is-null" as const },
      ],
      limit: shareLimit(ids.length),
      purpose,
    });
    const [docAnswers, folderAnswers] = await Promise.all([
      ctx.vault.read(answerRead(DOCUMENT_TARGET_TYPE, documentIds)),
      folderIds.length > 0
        ? ctx.vault.read(answerRead(FOLDER_CONTAINER_TYPE, folderIds))
        : { rows: [] as Record<string, unknown>[] },
    ]);
    const now = new Date().toISOString();
    // Dedupe by authority_id: an answer arriving through both reads would
    // otherwise print the same audience twice on one row.
    const answers = [
      ...new Map(
        [
          ...((docAnswers.rows ?? []) as unknown as AuthorityRow[]),
          ...((folderAnswers.rows ?? []) as unknown as AuthorityRow[]),
        ].map((a) => [a.authority_id, a] as const)
      ).values(),
    ].filter(
      (a) =>
        (a.principal_kind === "person" || a.principal_kind === "circle") &&
        liveAt(a, now)
    );
    if (answers.length === 0) return new Map();

    const circleIds = [
      ...new Set(
        answers
          .filter((a) => a.principal_kind === "circle")
          .map((a) => a.principal_id)
      ),
    ];
    const grantIds = answers.map((a) => a.authority_id);
    const noRows = { rows: [] as Record<string, unknown>[] };
    const [circles, members, fulfillments] = await Promise.all([
      circleIds.length > 0
        ? ctx.vault.read({
            entity: "social.circle",
            where: [{ column: "circle_id", op: "in", value: circleIds }],
            limit: shareLimit(circleIds.length),
            purpose,
          })
        : noRows,
      circleIds.length > 0
        ? ctx.vault.read({
            entity: "social.circle_member",
            where: [{ column: "circle_id", op: "in", value: circleIds }],
            limit: shareLimit(circleIds.length),
            purpose,
          })
        : noRows,
      ctx.vault.read({
        entity: "share.fulfillment",
        where: [{ column: "grant_id", op: "in", value: grantIds }],
        limit: shareLimit(grantIds.length),
        purpose,
      }),
    ]);
    const circleRows = (circles.rows ?? []) as unknown as CircleRow[];
    const memberRows = (members.rows ?? []) as unknown as CircleMemberRow[];
    const fulfillmentRows = (fulfillments.rows ??
      []) as unknown as FulfillmentRow[];

    const membersByCircle = new Map<string, string[]>();
    for (const m of memberRows) {
      const list = membersByCircle.get(m.circle_id);
      if (list) list.push(m.party_id);
      else membersByCircle.set(m.circle_id, [m.party_id]);
    }
    const rosterOf = (answer: AuthorityRow): string[] =>
      answer.principal_kind === "person"
        ? [answer.principal_id]
        : (membersByCircle.get(answer.principal_id) ?? []);

    // Bounded by the roster the answers just named; a party with no row is
    // "Someone", never an id.
    const partyIds = [...new Set(answers.flatMap(rosterOf))];
    const [parties, bindings] = await Promise.all([
      partyIds.length > 0
        ? ctx.vault.read({
            entity: "core.party",
            where: [{ column: "party_id", op: "in", value: partyIds }],
            limit: shareLimit(partyIds.length),
            purpose,
          })
        : noRows,
      partyIds.length > 0
        ? ctx.vault.read({
            entity: "share.party_vault_binding",
            where: [
              { column: "party_id", op: "in", value: partyIds },
              // A revoked binding no longer says which vault is theirs.
              { column: "revoked_at", op: "is-null" },
            ],
            limit: shareLimit(partyIds.length),
            purpose,
          })
        : noRows,
    ]);
    const nameByParty = new Map(
      ((parties.rows ?? []) as unknown as PartyRow[]).map((p) => [
        p.party_id,
        p.display_name ?? null,
      ])
    );
    const vaultByParty = new Map(
      ((bindings.rows ?? []) as unknown as BindingRow[]).map((b) => [
        b.party_id,
        b.vault_id,
      ])
    );
    // DELIVERED IS THE DURABLE FACT, NOT THE LIVE STATE (#846): an unreachable
    // pass drops `delivered` back to `syncing`, and reading that as "invited"
    // would tell the member a share they watched land had never arrived.
    const deliveredTo = new Set(
      fulfillmentRows.flatMap((f) =>
        f.delivered_at == null ? [] : [`${f.grant_id} ${f.peer_vault_id}`]
      )
    );

    const circleById = new Map(circleRows.map((c) => [c.circle_id, c]));
    const entryByGrant = new Map<string, SharedWithEntry>();
    for (const answer of answers) {
      const capability = CAPABILITY_OF_VERB[answer.verb] ?? "read";
      const roster = rosterOf(answer)
        .map((partyId) => {
          const vaultId = vaultByParty.get(partyId);
          return {
            party_id: partyId,
            label: nameByParty.get(partyId) ?? "Someone",
            capability,
            // No delivery yet: the answer stands and nothing has landed.
            status:
              vaultId !== undefined &&
              deliveredTo.has(`${answer.authority_id} ${vaultId}`)
                ? "current"
                : "invited",
          } satisfies SharedMember;
        })
        .toSorted((a, b) => a.label.localeCompare(b.label));
      const audience = answer.principal_kind === "person" ? "person" : "circle";
      entryByGrant.set(answer.authority_id, {
        grant_id: answer.authority_id,
        circle_id: audience === "circle" ? answer.principal_id : null,
        audience,
        label:
          audience === "circle"
            ? (circleById.get(answer.principal_id)?.name ?? "a circle")
            : (roster[0]?.label ?? "Someone"),
        via:
          answer.subject_type === DOCUMENT_TARGET_TYPE ? "document" : "folder",
        container_id: answer.subject_id,
        members: roster,
        member_count: roster.length,
        pending_count: roster.filter((m) => m.status === "invited").length,
      });
    }

    const byDocument = new Map<string, SharedWithEntry[]>();
    for (const documentId of documentIds) {
      // Match per subject TYPE, never id alone: document ids and folder
      // concept ids are different namespaces.
      const chain = chainByDoc.get(documentId) ?? [];
      const entries = answers
        .filter((a) =>
          a.subject_type === DOCUMENT_TARGET_TYPE
            ? a.subject_id === documentId
            : chain.includes(a.subject_id)
        )
        .map((a) => entryByGrant.get(a.authority_id))
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
 * Where a document came from (#903, #929). NOT bounded by the caller's window:
 * it is what DISCOVERS rows, so the caller unions these ids in and `limit` is
 * the only bound. No binding, no name — never a vault id worn as one.
 *
 * SHAPE-KEYED, NOT ROW-KEYED: a document arrives because a SHAPE placed it, so
 * the subscription this vault holds is what names the sender and the moment.
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
    const subscriptions = await ctx.vault.read({
      acceptTruncation: true,
      entity: "share.subscription",
      where: [{ column: "state", op: "eq", value: "subscribed" }],
      orderBy: { column: "subscribed_at", dir: "desc" },
      limit,
      purpose,
    });
    const subscriptionRows = (subscriptions.rows ??
      []) as unknown as SubscriptionRow[];
    if (subscriptionRows.length === 0) return new Map();
    const shapeIds = [...new Set(subscriptionRows.map((s) => s.shape_id))];
    const lineage = await ctx.vault.read({
      acceptTruncation: true,
      entity: "share.subscription_lineage",
      where: [
        { column: "target_type", op: "eq", value: DOCUMENT_TARGET_TYPE },
        { column: "shape_id", op: "in", value: shapeIds },
      ],
      limit,
      purpose,
    });
    const lineageRows = (lineage.rows ?? []) as unknown as LineageRow[];
    if (lineageRows.length === 0) return new Map();
    const shapeById = new Map(subscriptionRows.map((s) => [s.shape_id, s]));

    // A LOST NAME IS NOT A LOST ARRIVAL: only a denied placement is unknown.
    const { partyByVault, nameByParty } = await readSenderNames({
      ctx,
      purpose,
      vaultIds: [...new Set(subscriptionRows.map((s) => s.origin_vault_id))],
    });

    return new Map(
      lineageRows.flatMap((row) => {
        const subscription = shapeById.get(row.shape_id);
        if (!subscription) return [];
        const partyId = partyByVault.get(subscription.origin_vault_id) ?? null;
        return [
          [
            row.target_id,
            {
              vault_id: subscription.origin_vault_id,
              party_id: partyId,
              name: partyId ? (nameByParty.get(partyId) ?? null) : null,
              at: Date.parse(subscription.subscribed_at ?? "") || 0,
            } satisfies SharedFromEntry,
          ] as const,
        ];
      })
    );
  } catch {
    return null;
  }
}
