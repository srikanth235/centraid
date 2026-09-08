/*
 * WHAT THE TWO CAPTURE SCREENS PICK FROM (#996 wave 4b, R8).
 *
 * Capture and Scan both offer the member a destination — a calendar, a group,
 * a circle — and both used to ask for those tables whole with
 * the truncation flag. They are pickers: small, ordered sets, read to fill
 * a control. Stating that is the whole change; what it buys is that the picker
 * cannot silently be missing the entry the member is looking for.
 *
 * The two screens share this module because they share four of the six reads,
 * and a picker that lists groups one way on one screen and another way on the
 * other is a bug nobody would find.
 */

import type { PageQuery } from "@centraid/core/page";

export const CAPTURE_CALENDARS: PageQuery = {
  name: "phone.capture.calendars",
  select: "calendar_id, owner_party_id, name, color, default_tz, visibility",
  from: "schedule_calendar",
  order: { sortColumn: "name", pkColumn: "calendar_id", descending: false },
};

/** Live groups only: an archived group is not somewhere to file a capture. */
export const CAPTURE_GROUPS: PageQuery = {
  name: "phone.capture.groups",
  select: "group_id, circle_id, icon, color, simplify_opt_in, currency",
  from: "tally_group",
  where: "archived_at IS NULL",
  order: { sortColumn: "created_at", pkColumn: "group_id", descending: false },
};

export const CAPTURE_CIRCLES: PageQuery = {
  name: "phone.capture.circles",
  select: "circle_id, owner_party_id, name, kind",
  from: "social_circle",
  order: { sortColumn: "name", pkColumn: "circle_id", descending: false },
};

export const CAPTURE_CIRCLE_MEMBERS: PageQuery = {
  name: "phone.capture.circle-members",
  select: "member_id, circle_id, party_id, capability, added_at",
  from: "social_circle_member",
  order: { sortColumn: "circle_id", pkColumn: "member_id", descending: false },
};

export const CAPTURE_PARTIES: PageQuery = {
  name: "phone.capture.parties",
  select: "party_id, kind, display_name, sort_name, avatar_content_id",
  from: "core_party",
  where: "deleted_at IS NULL",
  order: { sortColumn: "sort_name", pkColumn: "party_id", descending: false },
};

/**
 * A seat opens ONE vault (#996 wave 3), so this read is one row — but it is
 * still a read, and the statement says which row rather than leaning on the
 * table having exactly one.
 */
export const CAPTURE_VAULT: PageQuery = {
  name: "phone.capture.vault",
  select: "vault_id, self_party_id, display_name, status, base_currency",
  from: "core_vault",
  order: { sortColumn: "vault_id", pkColumn: "vault_id", descending: false },
};
