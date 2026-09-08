/*
 * PEOPLE'S READS, AS STATEMENTS (#996 wave 5, R8).
 *
 * Twenty declarative entity requests drew the roster, the dashboard and one
 * person in full. Each named `MOBILE_ENTITY_READ_WINDOW` and asked the old
 * store for an entity; each is a statement over the seat's own `vault.db` now,
 * naming its table, its columns and the order its keyset walks.
 *
 * THE WINDOW STAYS, AND IT IS A WINDOW. A roster is a set a member scrolls, so
 * these are pages rather than walks: the year-3 window is the phone's declared
 * ceiling on how much of a household it draws at once, and `useSeatWindow`
 * reports from the page's own cursor when the rows ran past it — which is the
 * fact the old default window swallowed.
 *
 * ORDERED ON THE PRIMARY KEY, because every one of these sets is folded and
 * re-sorted by `people-model.ts` against the others. A sort column nobody
 * reads would only be an index to keep in step.
 *
 * `from` names the PHYSICAL table: the same statement runs against the seat's
 * file and against the gateway's paged door for a seat holding none (W4-D2).
 */

import type { PageQuery } from "@centraid/core/page";

const byKey = (column: string): PageQuery["order"] => ({
  sortColumn: column,
  pkColumn: column,
  descending: false,
});

export const PEOPLE_PROFILES: PageQuery = {
  name: "phone.people.profiles",
  select:
    "profile_id, party_id, role, nickname, avatar_color, cadence_days, " +
    "last_contacted_at, met, created_at, updated_at, deleted_at, purge_at",
  from: "people_profile",
  order: byKey("profile_id"),
};

export const PEOPLE_PARTIES: PageQuery = {
  name: "phone.people.parties",
  select:
    "party_id, kind, display_name, sort_name, birth_date, " +
    "avatar_content_id, created_at, deleted_at, purge_at",
  from: "core_party",
  order: byKey("party_id"),
};

/** Only the tags that decorate a PERSON; a photo's tags are Photos' rows. */
export const PEOPLE_PARTY_TAGS: PageQuery = {
  name: "phone.people.party-tags",
  select: "tag_id, target_type, target_id, concept_id, tagged_at",
  from: "core_tag",
  where: "target_type = ?",
  bind: ["core.party"],
  order: byKey("tag_id"),
};

export const PEOPLE_CONCEPTS: PageQuery = {
  name: "phone.people.concepts",
  select: "concept_id, scheme_id, notation, pref_label, broader_concept_id",
  from: "core_concept",
  order: byKey("concept_id"),
};

export const PEOPLE_SCHEMES: PageQuery = {
  name: "phone.people.concept-schemes",
  select: "scheme_id, uri, title",
  from: "core_concept_scheme",
  order: byKey("scheme_id"),
};

export const PEOPLE_DATES: PageQuery = {
  name: "phone.people.important-dates",
  select: "date_id, party_id, label, month_day, reminder_on, deleted_at",
  from: "people_important_date",
  order: byKey("date_id"),
};

/** The activities a party was part of, and the notes written on either. */
export const PEOPLE_ACTIVITIES: PageQuery = {
  name: "phone.people.activities",
  select:
    "activity_id, actor_party_id, kind_concept_id, started_at, ended_at, " +
    "location_place_id, source_app_id, created_at",
  from: "core_activity",
  order: byKey("activity_id"),
};

/** Bindings degrade ALONE (#821 L-read): absent link facts, never an error. */
export const PEOPLE_BINDINGS: PageQuery = {
  name: "phone.people.bindings",
  select: "binding_id, party_id, vault_id, linked_at, revoked_at",
  from: "share_party_vault_binding",
  order: byKey("binding_id"),
};

export const PEOPLE_CHANNELS: PageQuery = {
  name: "phone.people.contact-channels",
  select:
    "channel_id, party_id, kind, label, value, normalized_value, " +
    "is_preferred, created_at",
  from: "social_contact_channel",
  order: byKey("channel_id"),
};

const ANNOTATION_SELECT =
  "annotation_id, author_party_id, target_type, target_id, body_text, " +
  "created_at, updated_at";

/** Notes written on a target kind — the roster reads every party's. */
export function annotationsOn(
  target: "core.party" | "core.activity",
  partyId?: string
): PageQuery {
  return {
    name: `phone.people.notes-on-${target.replace(".", "-")}`,
    select: ANNOTATION_SELECT,
    from: "knowledge_annotation",
    where: partyId ? "target_type = ? AND target_id = ?" : "target_type = ?",
    bind: partyId ? [target, partyId] : [target],
    order: byKey("annotation_id"),
  };
}

const LINK_SELECT =
  "link_id, from_type, from_id, to_type, to_id, relation_concept_id, " +
  "valid_from, valid_to";

/**
 * Activity → party edges. `usePerson` narrows to ONE party in the statement
 * rather than filtering afterwards: the whole point of a per-person read is
 * that it costs that person's edges, not the household's.
 */
export function activityLinksTo(partyId?: string): PageQuery {
  return {
    name: partyId
      ? "phone.people.activity-links-for-party"
      : "phone.people.activity-links",
    select: LINK_SELECT,
    from: "core_link",
    where: partyId
      ? "from_type = ? AND to_type = ? AND to_id = ?"
      : "from_type = ? AND to_type = ?",
    bind: partyId
      ? ["core.activity", "core.party", partyId]
      : ["core.activity", "core.party"],
    order: byKey("link_id"),
  };
}

/** One party's important dates, narrowed in the statement. */
export function datesFor(partyId: string): PageQuery {
  return {
    name: "phone.people.important-dates-for-party",
    select: "date_id, party_id, label, month_day, reminder_on, deleted_at",
    from: "people_important_date",
    where: "party_id = ?",
    bind: [partyId],
    order: byKey("date_id"),
  };
}
