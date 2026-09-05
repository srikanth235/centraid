// The SHARING half of the drive projection — who sent a document into this
// vault, and who this vault has sent it on to. Split out of
// `docs-projection.ts` when that file outgrew the size limit; only this half
// needs the link plane.
//
// Same law as its parent: nothing is fabricated. Every field is a replica fact
// or `null` where the replica cannot say — "unknown" is never "shared with
// nobody" (#903).
//
// A SHARE IS A STANDING ANSWER AND A SUBSCRIPTION (#929): `share.authority`
// says who may reach a document, `share.fulfillment` whether it has, and the
// shape-keyed `share.subscription`/`share.subscription_lineage` pair says
// which vault placed an inbound row here. No membership plane of its own.

// `SharedFrom` is the BLUEPRINT's: two shapes for one fact is how seats drift.
import type {
  SharedFrom,
  SharedMember,
  SharedWith,
} from "@centraid/blueprints/apps/docs/types";

import {
  DOCUMENT_TARGET_TYPE,
  folderChain,
  FOLDER_CONTAINER_TYPE,
  str,
} from "./docs-projection-rows";
import type { EntityRow } from "./docs-projection-rows";

/** The four replica reads `originsByDocument` joins. */
export interface OriginEntityRows {
  subscriptions: readonly EntityRow[];
  lineage: readonly EntityRow[];
  /** What turns an origin VAULT into a person. */
  bindings: readonly EntityRow[];
  parties: readonly EntityRow[];
}

export interface ShareEntityRows {
  answers: readonly EntityRow[];
  circles: readonly EntityRow[];
  members: readonly EntityRow[];
  fulfillments: readonly EntityRow[];
  bindings: readonly EntityRow[];
  parties: readonly EntityRow[];
}

/** The two verbs a share answer carries, in the words both seats print. */
const CAPABILITY_OF_VERB: Readonly<Record<string, "read" | "read+write">> = {
  view: "read",
  edit: "read+write",
};

function nameByPartyOf(parties: readonly EntityRow[]): Map<string, string> {
  return new Map(
    parties.flatMap((party) => {
      const partyId = str(party, "party_id");
      const name = str(party, "display_name")?.trim();
      return partyId && name ? [[partyId, name] as const] : [];
    })
  );
}

/** A revoked binding no longer says whose vault that is. */
function liveBindings(bindings: readonly EntityRow[]): EntityRow[] {
  return bindings.filter((binding) => str(binding, "revoked_at") === null);
}

/**
 * Inbound placements, by document id — the Shared shelf's whole source.
 *
 * The vault id is the durable fact; the NAME needs a live
 * `share_party_vault_binding`. No binding, no name — never a vault id worn as
 * one. SHAPE-KEYED: the subscription this vault holds is what names the sender
 * and the moment, so two grants over one row cannot hide each other.
 */
export function originsByDocument(
  rows: OriginEntityRows
): Map<string, SharedFrom> {
  const partyByVault = new Map(
    liveBindings(rows.bindings).flatMap((binding) => {
      const vaultId = str(binding, "vault_id");
      const partyId = str(binding, "party_id");
      return vaultId && partyId ? [[vaultId, partyId] as const] : [];
    })
  );
  const nameByParty = nameByPartyOf(rows.parties);
  const subscriptionByShape = new Map(
    rows.subscriptions.flatMap((subscription) => {
      const shapeId = str(subscription, "shape_id");
      return shapeId && str(subscription, "state") === "subscribed"
        ? [[shapeId, subscription] as const]
        : [];
    })
  );
  return new Map(
    rows.lineage.flatMap((claim) => {
      if (str(claim, "target_type") !== DOCUMENT_TARGET_TYPE) return [];
      const itemId = str(claim, "target_id");
      const shapeId = str(claim, "shape_id");
      const subscription = shapeId ? subscriptionByShape.get(shapeId) : null;
      if (!itemId || !subscription) return [];
      const vaultId = str(subscription, "origin_vault_id");
      if (!vaultId) return [];
      const partyId = partyByVault.get(vaultId) ?? null;
      return [
        [
          itemId,
          {
            vault_id: vaultId,
            party_id: partyId,
            name: partyId ? (nameByParty.get(partyId) ?? null) : null,
            at: Date.parse(str(subscription, "subscribed_at") ?? "") || 0,
          },
        ] as const,
      ];
    })
  );
}

/**
 * LIVE is granted AND not run out (#916): a time-boxed share that keeps
 * answering yes is the same defect on the phone as it was in the resolver.
 */
function liveAnswers(
  answers: readonly EntityRow[],
  now: string
): readonly EntityRow[] {
  return answers.filter((answer) => {
    const kind = str(answer, "principal_kind");
    if (kind !== "person" && kind !== "circle") return false;
    if (str(answer, "decision") !== "granted") return false;
    if (str(answer, "revoked_at") !== null) return false;
    const subject = str(answer, "subject_type");
    if (subject !== DOCUMENT_TARGET_TYPE && subject !== FOLDER_CONTAINER_TYPE)
      return false;
    const expires = str(answer, "expires_at");
    return expires === null || expires > now;
  });
}

export function sharesByDocument(
  rows: ShareEntityRows,
  {
    documentIds,
    folderByDoc,
    folderConcepts,
    /** The clock an `until-date` answer is read against; the caller's, so a
     *  test can stand at a moment rather than at "whenever it ran". */
    now = new Date().toISOString(),
  }: {
    documentIds: readonly string[];
    folderByDoc: ReadonlyMap<string, string>;
    folderConcepts: readonly EntityRow[];
    now?: string;
  }
): Map<string, SharedWith[]> {
  const parentOf = new Map<string, string | null>(
    folderConcepts.flatMap((concept) => {
      const id = str(concept, "concept_id");
      return id ? [[id, str(concept, "broader_concept_id")] as const] : [];
    })
  );
  const chainByDoc = new Map(
    documentIds.map(
      (id) => [id, folderChain(folderByDoc.get(id) ?? null, parentOf)] as const
    )
  );

  const answers = liveAnswers(rows.answers, now);
  if (answers.length === 0) return new Map();

  const circleById = new Map(
    rows.circles.flatMap((circle) => {
      const id = str(circle, "circle_id");
      return id ? [[id, circle] as const] : [];
    })
  );
  const membersByCircle = new Map<string, string[]>();
  for (const member of rows.members) {
    const circleId = str(member, "circle_id");
    const partyId = str(member, "party_id");
    if (!circleId || !partyId) continue;
    const list = membersByCircle.get(circleId);
    if (list) list.push(partyId);
    else membersByCircle.set(circleId, [partyId]);
  }
  const rosterOf = (answer: EntityRow): string[] => {
    const principalId = str(answer, "principal_id");
    if (!principalId) return [];
    return str(answer, "principal_kind") === "person"
      ? [principalId]
      : (membersByCircle.get(principalId) ?? []);
  };
  const nameByParty = nameByPartyOf(rows.parties);
  const vaultByParty = new Map(
    liveBindings(rows.bindings).flatMap((binding) => {
      const partyId = str(binding, "party_id");
      const vaultId = str(binding, "vault_id");
      return partyId && vaultId ? [[partyId, vaultId] as const] : [];
    })
  );
  // DELIVERED IS THE DURABLE FACT, NOT THE LIVE STATE (#846): an unreachable
  // pass drops `delivered` back to `syncing`, and reading that as "invited"
  // would tell the member a share they watched land had never arrived.
  const deliveredTo = new Set(
    rows.fulfillments.flatMap((row) => {
      const grantId = str(row, "grant_id");
      const peerVaultId = str(row, "peer_vault_id");
      return grantId && peerVaultId && str(row, "delivered_at") !== null
        ? [`${grantId} ${peerVaultId}`]
        : [];
    })
  );

  const entryByGrant = new Map<string, SharedWith>();
  for (const answer of answers) {
    const grantId = str(answer, "authority_id");
    const principalId = str(answer, "principal_id");
    const containerId = str(answer, "subject_id");
    if (!grantId || !principalId || !containerId) continue;
    const capability = CAPABILITY_OF_VERB[str(answer, "verb") ?? ""] ?? "read";
    const roster: SharedMember[] = rosterOf(answer)
      .map((partyId) => {
        const vaultId = vaultByParty.get(partyId);
        return {
          party_id: partyId,
          label: nameByParty.get(partyId) ?? "Someone",
          capability,
          status:
            vaultId !== undefined && deliveredTo.has(`${grantId} ${vaultId}`)
              ? "current"
              : "invited",
        } satisfies SharedMember;
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const audience =
      str(answer, "principal_kind") === "person" ? "person" : "circle";
    entryByGrant.set(grantId, {
      grant_id: grantId,
      circle_id: audience === "circle" ? principalId : null,
      audience,
      label:
        audience === "circle"
          ? (str(circleById.get(principalId) ?? {}, "name") ?? "a circle")
          : (roster[0]?.label ?? "Someone"),
      via:
        str(answer, "subject_type") === DOCUMENT_TARGET_TYPE
          ? "document"
          : "folder",
      container_id: containerId,
      members: roster,
      member_count: roster.length,
      pending_count: roster.filter((member) => member.status === "invited")
        .length,
    });
  }

  const byDocument = new Map<string, SharedWith[]>();
  for (const documentId of documentIds) {
    const chain = chainByDoc.get(documentId) ?? [];
    const entries = answers
      .flatMap((answer) => {
        const grantId = str(answer, "authority_id");
        const entry = grantId ? entryByGrant.get(grantId) : undefined;
        if (!entry) return [];
        const reaches =
          entry.via === "document"
            ? entry.container_id === documentId
            : chain.includes(entry.container_id);
        return reaches ? [entry] : [];
      })
      .sort(
        (a, b) =>
          (a.via === "document" ? 0 : 1) - (b.via === "document" ? 0 : 1) ||
          a.label.localeCompare(b.label)
      );
    if (entries.length > 0) byDocument.set(documentId, entries);
  }
  return byDocument;
}
