// The SHARING half of the drive projection — who sent a document into this
// vault, and who this vault has sent it on to. Split out of
// `docs-projection.ts` when that file outgrew the size limit; the two answer
// different questions over the same rows, and only this one needs the link
// plane.
//
// Same law as its parent: nothing is fabricated. Every field is a replica fact
// or `null` where the replica cannot say — "unknown" is never "shared with
// nobody" (#903).

import type {
  SharedMember,
  SharedWith,
} from "@centraid/blueprints/apps/docs/types";

import {
  DOCUMENT_TARGET_TYPE,
  folderChain,
  FOLDER_CONTAINER_TYPE,
  num,
  str,
} from "./docs-projection-rows";
import type { EntityRow } from "./docs-projection-rows";

/**
 * Where a document in THIS vault came from, when it came from another one.
 *
 * `core_share_origin` is written by delivery, so its presence is the whole
 * answer to "was this shared with me" — there is no second signal, and a
 * document with no row here simply arrived some other way.
 */
export interface SharedFrom {
  /** The vault it was delivered from. Always known; the name may not be. */
  vaultId: string;
  /** The linked person that vault belongs to, where a binding names one.
   *  `null` is "this device cannot say who", never "nobody". */
  partyId: string | null;
  name: string | null;
  /** When it landed here, epoch milliseconds. */
  at: number;
}

export interface OriginEntityRows {
  /** `core.share_origin` — one row per projected item. */
  origins: readonly EntityRow[];
  /** `share.party_vault_binding` — what turns an origin VAULT into a person. */
  bindings: readonly EntityRow[];
  parties: readonly EntityRow[];
}

export interface ShareEntityRows {
  grants: readonly EntityRow[];
  circles: readonly EntityRow[];
  members: readonly EntityRow[];
  states: readonly EntityRow[];
  parties: readonly EntityRow[];
}

function shareLabel(
  implicit: boolean,
  circleName: string | null,
  memberLabels: readonly string[]
): string {
  if (!implicit && circleName) return circleName;
  if (memberLabels.length === 0) return circleName ?? "a circle";
  const shown = memberLabels.slice(0, 2).join(" and ");
  const rest = memberLabels.length - 2;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * Inbound placements, by document id — the Shared shelf's whole source.
 *
 * The vault id is the durable fact; the NAME is a courtesy the vault can only
 * extend where a link binding already says which person that vault belongs to
 * (`share_party_vault_binding`, the same mechanism every share sheet resolves
 * an audience through). No binding, no name — never a truncated vault id worn
 * as one, and never a guess from the `shared_by` attribution, which is an
 * owner id or `peer:<vaultId>` rather than a party.
 */
export function originsByDocument(
  rows: OriginEntityRows
): Map<string, SharedFrom> {
  const partyByVault = new Map(
    rows.bindings.flatMap((binding) => {
      const vaultId = str(binding, "vault_id");
      const partyId = str(binding, "party_id");
      // A revoked binding no longer says whose vault that is; the placement it
      // once explained stays, unnamed.
      return vaultId && partyId && str(binding, "revoked_at") === null
        ? [[vaultId, partyId] as const]
        : [];
    })
  );
  const nameByParty = new Map(
    rows.parties.flatMap((party) => {
      const partyId = str(party, "party_id");
      const name = str(party, "display_name")?.trim();
      return partyId && name ? [[partyId, name] as const] : [];
    })
  );
  return new Map(
    rows.origins.flatMap((origin) => {
      if (str(origin, "item_type") !== DOCUMENT_TARGET_TYPE) return [];
      const itemId = str(origin, "item_id");
      const vaultId = str(origin, "origin_vault_id");
      if (!itemId || !vaultId) return [];
      const partyId = partyByVault.get(vaultId) ?? null;
      return [
        [
          itemId,
          {
            vaultId,
            partyId,
            name: partyId ? (nameByParty.get(partyId) ?? null) : null,
            at: num(origin, "shared_at") ?? 0,
          },
        ] as const,
      ];
    })
  );
}

export function sharesByDocument(
  rows: ShareEntityRows,
  {
    documentIds,
    folderByDoc,
    folderConcepts,
  }: {
    documentIds: readonly string[];
    folderByDoc: ReadonlyMap<string, string>;
    folderConcepts: readonly EntityRow[];
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

  const grants = rows.grants.filter(
    (grant) =>
      str(grant, "plane") === "commons" &&
      str(grant, "revoked_at") === null &&
      (str(grant, "container_type") === DOCUMENT_TARGET_TYPE ||
        str(grant, "container_type") === FOLDER_CONTAINER_TYPE)
  );
  if (grants.length === 0) return new Map();

  const circleById = new Map(
    rows.circles.flatMap((circle) => {
      const id = str(circle, "circle_id");
      return id ? [[id, circle] as const] : [];
    })
  );
  const membersByCircle = new Map<string, EntityRow[]>();
  for (const member of rows.members) {
    const circleId = str(member, "circle_id");
    if (!circleId) continue;
    const list = membersByCircle.get(circleId);
    if (list) list.push(member);
    else membersByCircle.set(circleId, [member]);
  }
  const statusByGrantParty = new Map(
    rows.states.flatMap((state) => {
      const grantId = str(state, "grant_id");
      const partyId = str(state, "party_id");
      const status = str(state, "status");
      return grantId && partyId && status
        ? [[`${grantId} ${partyId}`, status] as const]
        : [];
    })
  );
  const nameByParty = new Map(
    rows.parties.flatMap((party) => {
      const id = str(party, "party_id");
      return id ? [[id, str(party, "display_name")] as const] : [];
    })
  );

  const entryByGrant = new Map<string, SharedWith>();
  for (const grant of grants) {
    const grantId = str(grant, "grant_id");
    const circleId = str(grant, "circle_id");
    const containerId = str(grant, "container_id");
    if (!grantId || !circleId || !containerId) continue;
    const roster: SharedMember[] = (membersByCircle.get(circleId) ?? [])
      .flatMap((member) => {
        const partyId = str(member, "party_id");
        if (!partyId) return [];
        const status =
          statusByGrantParty.get(`${grantId} ${partyId}`) ?? "invited";
        if (status === "refused") return [];
        const capability = str(member, "capability");
        return [
          {
            party_id: partyId,
            label: nameByParty.get(partyId) ?? "Someone",
            capability: capability === "read+write" ? "read+write" : "read",
            status: status === "current" ? "current" : "invited",
          } satisfies SharedMember,
        ];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    const circle = circleById.get(circleId);
    entryByGrant.set(grantId, {
      grant_id: grantId,
      circle_id: circleId,
      label: shareLabel(
        Number(grant["implicit_circle"] ?? 0) === 1,
        circle ? str(circle, "name") : null,
        roster.map((member) => member.label)
      ),
      via:
        str(grant, "container_type") === DOCUMENT_TARGET_TYPE
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
    const entries = grants
      .flatMap((grant) => {
        const grantId = str(grant, "grant_id");
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
