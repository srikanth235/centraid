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
import { inList, readPages } from "../../_shared/paged-reads.ts";
import type { FanOutBound } from "../../_shared/paged-reads.ts";

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
  const documentIn = inList("target_id", documentIds);
  const labelTags = await readPages<TagRow>(ctx, {
    name: "docs.labels.tags",
    select: "tag_id, target_id, concept_id, target_type",
    from: "core_tag",
    where: `target_type = ? AND ${documentIn.sql}`,
    bind: [DOCUMENT_TARGET_TYPE, ...documentIn.bind],
    order: { sortColumn: "tag_id", pkColumn: "tag_id", descending: false },
  });
  for (const t of labelTags) {
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
  contentIds,
}: {
  ctx: HandlerCtx;
  contentIds: string[];
}): Promise<Map<string, string>> {
  if (contentIds.length === 0) return new Map();
  const contentIn = inList("content_id", contentIds);
  const custody = await readPages<CustodyRow>(ctx, {
    name: "docs.custody.byContent",
    select: "content_id, custody_state",
    from: "blob_custody_state",
    where: contentIn.sql,
    bind: contentIn.bind,
    order: {
      sortColumn: "content_id",
      pkColumn: "content_id",
      descending: false,
    },
  });
  return new Map(custody.map((c) => [c.content_id, c.custody_state]));
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
  member_id: string;
  circle_id: string;
  party_id: string;
}

interface FulfillmentRow {
  grant_id: string;
  peer_vault_id: string;
  delivered_at?: string | null;
}

export interface PartyRow {
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

export interface BindingRow {
  binding_id: string;
  party_id: string;
  vault_id: string;
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

/**
 * How far a share join may walk (#996 wave 4, R8).
 *
 * It replaces `shareLimit`, which sized a WINDOW off the caller's id count and
 * capped it at 2,000 rows — and then took whatever fell inside it without
 * saying so, which on the drive meant a document quietly losing an audience.
 * Every set below is `in`-bounded by ids the caller already holds, so the walk
 * is finite; this states where finite stops, and throws there.
 */
export const SHARE_FAN_OUT: FanOutBound = { pageSize: 500, fanOutPages: 8 };

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
  documentIds,
  folderByDoc,
  folderConcepts,
}: {
  ctx: HandlerCtx;
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
    const answerWalk = (subjectType: string, ids: string[]) => {
      const subjectIn = inList("subject_id", ids);
      return readPages<AuthorityRow>(
        ctx,
        {
          name: `docs.shares.answers.${subjectType}`,
          select:
            "authority_id, principal_kind, principal_id, subject_type, subject_id, verb, expires_at",
          from: "share_authority",
          where: `subject_type = ? AND ${subjectIn.sql} AND decision = ? AND revoked_at IS NULL`,
          bind: [subjectType, ...subjectIn.bind, "granted"],
          order: {
            sortColumn: "authority_id",
            pkColumn: "authority_id",
            descending: false,
          },
        },
        SHARE_FAN_OUT
      );
    };
    const [docAnswerRows, folderAnswerRows] = await Promise.all([
      answerWalk(DOCUMENT_TARGET_TYPE, documentIds),
      folderIds.length > 0
        ? answerWalk(FOLDER_CONTAINER_TYPE, folderIds)
        : Promise.resolve([] as AuthorityRow[]),
    ]);
    const now = new Date().toISOString();
    // Dedupe by authority_id: an answer arriving through both reads would
    // otherwise print the same audience twice on one row.
    const answers = [
      ...new Map(
        [...docAnswerRows, ...folderAnswerRows].map(
          (a) => [a.authority_id, a] as const
        )
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
    const grantIn = inList("grant_id", grantIds);
    const [circleRows, memberRows, fulfillmentRows] = await Promise.all([
      circleIds.length > 0
        ? readPages<CircleRow>(
            ctx,
            {
              name: "docs.shares.circles",
              select: "circle_id, name",
              from: "social_circle",
              where: inList("circle_id", circleIds).sql,
              bind: inList("circle_id", circleIds).bind,
              order: {
                sortColumn: "circle_id",
                pkColumn: "circle_id",
                descending: false,
              },
            },
            SHARE_FAN_OUT
          )
        : Promise.resolve([] as CircleRow[]),
      circleIds.length > 0
        ? readPages<CircleMemberRow>(
            ctx,
            {
              name: "docs.shares.circleMembers",
              select: "member_id, circle_id, party_id",
              from: "social_circle_member",
              where: inList("circle_id", circleIds).sql,
              bind: inList("circle_id", circleIds).bind,
              order: {
                sortColumn: "member_id",
                pkColumn: "member_id",
                descending: false,
              },
            },
            SHARE_FAN_OUT
          )
        : Promise.resolve([] as CircleMemberRow[]),
      // THE KEYSET IS THE TABLE'S OWN PRIMARY KEY. `share_fulfillment` is keyed
      // on the PAIR (grant_id, peer_vault_id) — one grant reaches several peers
      // — so a cursor on `grant_id` alone would stop at the first peer and
      // call the delivery list finished.
      readPages<FulfillmentRow>(
        ctx,
        {
          name: "docs.shares.fulfillments",
          select: "grant_id, peer_vault_id, delivered_at",
          from: "share_fulfillment",
          where: grantIn.sql,
          bind: grantIn.bind,
          order: {
            sortColumn: "grant_id",
            pkColumn: "peer_vault_id",
            descending: false,
          },
        },
        SHARE_FAN_OUT
      ),
    ]);

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
    const partyIn = partyIds.length > 0 ? inList("party_id", partyIds) : null;
    const [partyRows, bindingRows] = await Promise.all([
      partyIn
        ? readPages<PartyRow>(
            ctx,
            {
              name: "docs.shares.parties",
              select: "party_id, display_name",
              from: "core_party",
              where: partyIn.sql,
              bind: partyIn.bind,
              order: {
                sortColumn: "party_id",
                pkColumn: "party_id",
                descending: false,
              },
            },
            SHARE_FAN_OUT
          )
        : Promise.resolve([] as PartyRow[]),
      partyIn
        ? readPages<BindingRow>(
            ctx,
            {
              name: "docs.shares.bindings",
              // A revoked binding no longer says which vault is theirs.
              select: "binding_id, party_id, vault_id",
              from: "share_party_vault_binding",
              where: `${partyIn.sql} AND revoked_at IS NULL`,
              bind: partyIn.bind,
              order: {
                sortColumn: "binding_id",
                pkColumn: "binding_id",
                descending: false,
              },
            },
            SHARE_FAN_OUT
          )
        : Promise.resolve([] as BindingRow[]),
    ]);
    const nameByParty = new Map(
      partyRows.map((p) => [p.party_id, p.display_name ?? null])
    );
    const vaultByParty = new Map(
      bindingRows.map((b) => [b.party_id, b.vault_id])
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
