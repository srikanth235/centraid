// THE APP READ PATH'S ORDERING INDEXES (#996, W5; ruling R8).
//
// Every shipped handler runs through the paged door, and a keyset page is
// `WHERE <predicate> ORDER BY <sort column>, <primary key> LIMIT ?`. Without an
// index that already holds that order, SQLite materialises the whole filtered
// set in a temp B-tree and sorts it before it can answer one page — which is
// the one shape an outer LIMIT cannot bound. `app-query-plans.snapshot.md`
// printed `USE TEMP B-TREE FOR ORDER BY` for thirty (table, ORDER BY) groups;
// each index below removes exactly one of them, and the snapshot is the
// evidence.
//
// THE SHAPE IS `(equality predicate columns…, sort column, primary key)`, and
// the equality prefix is not optional. `(sort, pk)` alone is the obvious
// reading and it was measured wrong for seven of the groups: given
// `WHERE deleted_at IS NULL ORDER BY updated_at DESC`, SQLite prefers the
// index that SEEKS — the one on the predicate — and then sorts, so a bare
// `(updated_at, note_id)` is simply not chosen. Leading with the equality
// columns makes one index do both: the seek lands, and the rest of the index
// is already in the page's order.
//
// FOUR OF THE GROUPS ORDER ON THE PRIMARY KEY ALONE, and for those the pair
// would be the key twice over; they take the predicate columns followed by the
// key. Their other half is in `@centraid/core/page` — `ORDER BY id, id` sorts
// one-row groups in a temp B-tree, and the statement builder now states the
// tiebreaker once.
//
// DIRECTION IS NOT PART OF THE CHOICE: SQLite walks an ASC index backwards for
// a fully-DESC ORDER BY, so `core_event(dtstart, event_id)` serves the ASC
// window and the DESC recurring-anchor walk from one index.
//
// STATED IN THE BASELINE, not as a rung. Pre-1.0, with the golden corpus
// re-frozen in the same slice — the same reading `CONTENT_TEXT_DDL` is stated
// under, and the reason `IF NOT EXISTS` is on every statement here.

/**
 * Indexes over tables the composed baseline (rung one) creates. Placed after
 * every table the domains create: `schedule_task.due_at` and `.completed_at`
 * are `TIME_ORGANIZE_DDL`'s ALTERs, `media_asset_phash` is `ENRICH_DDL`'s, and
 * an index cannot precede the column it names, so this block runs last of the
 * base tables' DDL.
 */
export const READ_PATH_INDEX_DDL = `
-- access band
CREATE INDEX IF NOT EXISTS access_provenance_occurred_page_idx
  ON access_provenance(entity_type, entity_id, occurred_at, prov_id);
CREATE INDEX IF NOT EXISTS access_receipt_occurred_page_idx
  ON access_receipt(occurred_at, receipt_id);

-- core
CREATE INDEX IF NOT EXISTS core_collection_sort_page_idx
  ON core_collection(sort_order, collection_id);
CREATE INDEX IF NOT EXISTS core_entity_revision_recorded_page_idx
  ON core_entity_revision(entity_type, entity_id, recorded_at, revision_id);
CREATE INDEX IF NOT EXISTS core_event_dtstart_page_idx
  ON core_event(dtstart, event_id);
CREATE INDEX IF NOT EXISTS core_party_display_name_page_idx
  ON core_party(display_name, party_id);
CREATE INDEX IF NOT EXISTS core_transaction_posted_page_idx
  ON core_transaction(posted_at, txn_id);
-- Ordered on the key alone: the predicate leads, the key closes the walk.
CREATE INDEX IF NOT EXISTS core_link_from_to_page_idx
  ON core_link(from_type, to_type, link_id);
CREATE INDEX IF NOT EXISTS core_attachment_target_role_page_idx
  ON core_attachment(target_type, role, attachment_id);

-- knowledge / media
CREATE INDEX IF NOT EXISTS knowledge_note_deleted_page_idx
  ON knowledge_note(deleted_at, note_id);
CREATE INDEX IF NOT EXISTS knowledge_note_updated_page_idx
  ON knowledge_note(deleted_at, updated_at, note_id);
CREATE INDEX IF NOT EXISTS media_asset_captured_page_idx
  ON media_asset(deleted_at, archived_at, captured_at, asset_id);
CREATE INDEX IF NOT EXISTS media_asset_deleted_page_idx
  ON media_asset(deleted_at, asset_id);
CREATE INDEX IF NOT EXISTS media_asset_phash_cluster_page_idx
  ON media_asset_phash(cluster_id, asset_id);
CREATE INDEX IF NOT EXISTS media_face_region_asset_page_idx
  ON media_face_region(asset_id, region_id);

-- locker / people
CREATE INDEX IF NOT EXISTS locker_item_updated_page_idx
  ON locker_item(updated_at, item_id);
CREATE INDEX IF NOT EXISTS locker_item_type_updated_page_idx
  ON locker_item(type, deleted_at, updated_at, item_id);
CREATE INDEX IF NOT EXISTS people_profile_created_page_idx
  ON people_profile(deleted_at, created_at, party_id);
CREATE INDEX IF NOT EXISTS people_profile_deleted_page_idx
  ON people_profile(deleted_at, party_id);

-- schedule
CREATE INDEX IF NOT EXISTS schedule_project_sort_page_idx
  ON schedule_project(sort_order, project_id);
CREATE INDEX IF NOT EXISTS schedule_section_sort_page_idx
  ON schedule_section(sort_order, section_id);
CREATE INDEX IF NOT EXISTS schedule_task_completed_page_idx
  ON schedule_task(completed_at, task_id);
CREATE INDEX IF NOT EXISTS schedule_task_created_page_idx
  ON schedule_task(created_at, task_id);
CREATE INDEX IF NOT EXISTS schedule_task_due_page_idx
  ON schedule_task(due_at, task_id);
CREATE INDEX IF NOT EXISTS schedule_recurrence_exception_target_page_idx
  ON schedule_recurrence_exception(target_type, exception_id);

-- tally
CREATE INDEX IF NOT EXISTS tally_expense_deleted_page_idx
  ON tally_expense(deleted_at, expense_id);
CREATE INDEX IF NOT EXISTS tally_expense_spent_page_idx
  ON tally_expense(deleted_at, spent_on, expense_id);
CREATE INDEX IF NOT EXISTS tally_nudge_prepared_page_idx
  ON tally_nudge(prepared_at, nudge_id);
CREATE INDEX IF NOT EXISTS tally_recurring_expense_updated_page_idx
  ON tally_recurring_expense(updated_at, template_id);
`;

/**
 * The one read-path index over a table the baseline does not create.
 * `share_subscription` is stated beside its own DDL for that reason, and for no
 * other: it is the same statement, under the same reading, as the block above.
 */
export const SUBSCRIPTION_READ_PATH_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS share_subscription_subscribed_page_idx
  ON share_subscription(subscribed_at, authority_id);
`;
