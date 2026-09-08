/*
 * THE DRIVE'S READS, AS STATEMENTS (#996 wave 4b, R8).
 *
 * Fifteen reads used to be fifteen the truncation flag entity requests —
 * "the whole table, and whatever window you have", which was 1,000 rows nobody
 * chose. A drive of 1,200 documents rendered 1,000 of them and said nothing.
 *
 * They are here rather than inline in `useDocs.ts` for the reason the blueprint
 * handlers keep theirs beside the handler: a statement is a review diff. What
 * columns the drive reads, which tables it joins and where each walk stops are
 * one screen's worth of facts, and `useDocs.ts` is already the file that
 * assembles them into a projection.
 *
 * `from` names the PHYSICAL table because the same statement runs against the
 * seat's own `vault.db` and against the gateway's paged door for a seat that
 * holds no file (W4-D2).
 *
 * THE BYTE-KEYED TABLES ARE BOUNDED BY THE DRIVE, NOT READ WHOLE. Content
 * items, representations and custody rows are the drive's decoration of the
 * documents it is already showing; read whole they are the entire library of
 * bytes, most of which no document on this screen names. A subquery over
 * `core_document.current_content_id` bounds them by the drive itself — and it
 * is a subquery rather than a JOIN because the keyset compares the ORDER BY's
 * own two columns by NAME, and a join that has to alias `created_at` past a
 * collision is a keyset predicate that no longer says what it seems to.
 */

import type { PageQuery } from "@centraid/core/page";

export { DOCS_CUSTODY } from "../../kit/storage/custody-pages";

/** The bytes some document on this drive currently reads as its own. */
const CURRENT_DOCUMENT_BYTES = (column: string): string =>
  `${column} IN (SELECT current_content_id FROM core_document
     WHERE current_content_id IS NOT NULL)`;

export const DOCS_DOCUMENTS: PageQuery = {
  name: "phone.docs.documents",
  select:
    "document_id, title, current_content_id, current_revision_id, " +
    "created_at, updated_at, deleted_at, purge_at",
  from: "core_document",
  order: {
    sortColumn: "updated_at",
    pkColumn: "document_id",
    descending: true,
  },
};

export const DOCS_CONTENTS: PageQuery = {
  name: "phone.docs.contents",
  select:
    "content_id, content_uri, sha256, byte_size, language, created_at, " +
    "deleted_at",
  from: "core_content_item",
  where: CURRENT_DOCUMENT_BYTES("content_id"),
  order: { sortColumn: "created_at", pkColumn: "content_id", descending: true },
};

export const DOCS_REPRESENTATIONS: PageQuery = {
  name: "phone.docs.representations",
  select:
    "representation_id, content_id, owner_type, owner_id, media_type, " +
    "charset, interpretation",
  from: "core_content_representation",
  where: CURRENT_DOCUMENT_BYTES("content_id"),
  order: {
    sortColumn: "content_id",
    pkColumn: "representation_id",
    descending: false,
  },
};

/** Only the tags on documents; a photo's tags are not this drive's business. */
export const DOCS_TAGS: PageQuery = {
  name: "phone.docs.tags",
  select: "tag_id, target_type, target_id, concept_id, tagged_at",
  from: "core_tag",
  where: "target_type = ?",
  bind: ["core.document"],
  order: { sortColumn: "target_id", pkColumn: "tag_id", descending: false },
};

export const DOCS_CONCEPTS: PageQuery = {
  name: "phone.docs.concepts",
  select: "concept_id, scheme_id, notation, pref_label, broader_concept_id",
  from: "core_concept",
  order: { sortColumn: "scheme_id", pkColumn: "concept_id", descending: false },
};

export const DOCS_SCHEMES: PageQuery = {
  name: "phone.docs.schemes",
  select: "scheme_id, uri, title",
  from: "core_concept_scheme",
  order: { sortColumn: "uri", pkColumn: "scheme_id", descending: false },
};

export const DOCS_AUTHORITIES: PageQuery = {
  name: "phone.docs.authorities",
  select:
    "authority_id, principal_kind, principal_id, subject_type, subject_id, " +
    "verb, duration, expires_at, decision, granted_at, revoked_at",
  from: "share_authority",
  order: {
    sortColumn: "granted_at",
    pkColumn: "authority_id",
    descending: true,
  },
};

export const DOCS_CIRCLES: PageQuery = {
  name: "phone.docs.circles",
  select: "circle_id, owner_party_id, name, kind",
  from: "social_circle",
  order: { sortColumn: "name", pkColumn: "circle_id", descending: false },
};

export const DOCS_CIRCLE_MEMBERS: PageQuery = {
  name: "phone.docs.circle-members",
  select: "member_id, circle_id, party_id, capability, added_at",
  from: "social_circle_member",
  order: { sortColumn: "circle_id", pkColumn: "member_id", descending: false },
};

/*
 * THE COMPOSITE-KEY TABLES ORDER ON THEIR OWN KEY. A keyset needs a unique
 * `(sort, pk)` pair, and these four tables have no single-column id — so the
 * two columns the ORDER BY names ARE the key, rather than one of them plus a
 * tiebreak that does not break the tie.
 */
export const DOCS_FULFILLMENTS: PageQuery = {
  name: "phone.docs.fulfillments",
  select: "grant_id, peer_vault_id, state, detail, delivered_at",
  from: "share_fulfillment",
  order: {
    sortColumn: "peer_vault_id",
    pkColumn: "grant_id",
    descending: false,
  },
};

export const DOCS_PARTIES: PageQuery = {
  name: "phone.docs.parties",
  select:
    "party_id, kind, display_name, sort_name, avatar_content_id, deleted_at",
  from: "core_party",
  order: { sortColumn: "sort_name", pkColumn: "party_id", descending: false },
};

export const DOCS_SUBSCRIPTIONS: PageQuery = {
  name: "phone.docs.subscriptions",
  select:
    "authority_id, audience_vault_id, origin_vault_id, subject_type, state, " +
    "subscribed_at, removed_at, detail",
  from: "share_subscription",
  order: {
    sortColumn: "audience_vault_id",
    pkColumn: "authority_id",
    descending: false,
  },
};

export const DOCS_LINEAGE: PageQuery = {
  name: "phone.docs.lineage",
  select: "authority_id, target_type, target_id, origin_item_id",
  from: "share_subscription_lineage",
  order: {
    sortColumn: "target_id",
    pkColumn: "authority_id",
    descending: false,
  },
};

export const DOCS_BINDINGS: PageQuery = {
  name: "phone.docs.bindings",
  select: "binding_id, party_id, vault_id, linked_at, revoked_at",
  from: "share_party_vault_binding",
  order: { sortColumn: "party_id", pkColumn: "binding_id", descending: false },
};
