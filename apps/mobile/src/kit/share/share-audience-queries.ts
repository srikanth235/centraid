/*
 * WHO IS IN THE ROOM, AS STATEMENTS (#996 wave 5, R8).
 *
 * Five reads answer "who can this be shared with" on every sheet the phone
 * opens — the share sheet, the grant sheets in Docs and Photos, the named
 * circles, the group commons. They were five declarative entity requests with
 * hand-picked windows (500 parties, 2,000 members) against the old store's
 * `replica_row`; they are five statements over the seat's own `vault.db` now,
 * and the window is the walk's, not a number somebody guessed.
 *
 * THEY ARE HERE, ONCE. The five sheets asked for the same rows in five files
 * and drifted in their windows while doing it. A roster is one fact about a
 * vault, so it is one statement, and a sheet that needs a column nobody
 * selected changes it here where every other sheet sees the change.
 *
 * `from` names the PHYSICAL table because the same statement runs against the
 * seat's file and against the gateway's paged door for a seat that holds none
 * (W4-D2).
 */

import type { PageQuery } from "@centraid/core/page";

/** Everyone this vault knows; `kind` is what makes one addressable. */
export const SHARE_PARTIES: PageQuery = {
  name: "phone.share.parties",
  select: "party_id, kind, display_name, created_at",
  from: "core_party",
  order: { sortColumn: "created_at", pkColumn: "party_id", descending: false },
};

/** This vault's own row — `self_party_id` is who "me" is on every sheet. */
export const SHARE_VAULT: PageQuery = {
  name: "phone.share.vault",
  select: "vault_id, self_party_id, created_at",
  from: "core_vault",
  order: { sortColumn: "created_at", pkColumn: "vault_id", descending: false },
};

/** Circles; only an OWNED, group-decorated one is a deliberate audience. */
export const SHARE_CIRCLES: PageQuery = {
  name: "phone.share.circles",
  select: "circle_id, owner_party_id, name, kind, created_at",
  from: "social_circle",
  order: { sortColumn: "created_at", pkColumn: "circle_id", descending: false },
};

/** Membership, with the capability the commons is bound to. */
export const SHARE_CIRCLE_MEMBERS: PageQuery = {
  name: "phone.share.circle-members",
  select: "member_id, circle_id, party_id, capability, added_at",
  from: "social_circle_member",
  order: { sortColumn: "added_at", pkColumn: "member_id", descending: false },
};

/** The Tally group that decorates a circle into a named audience. */
export const SHARE_GROUPS: PageQuery = {
  name: "phone.share.groups",
  select: "group_id, circle_id, created_at",
  from: "tally_group",
  order: { sortColumn: "created_at", pkColumn: "group_id", descending: false },
};
