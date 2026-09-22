// GENERATED — do not edit. Written by
// `crates/evalsuite/grammar/derive/emit.py` from `derive/derived.json` (the
// ontology, walked) and `derive/terminals.json` (the names). Regenerate with
// `python3 derive/emit.py`; `python3 check.py` verifies it.

/// Kind -> (logical entity, door).
#[must_use]
pub fn kinds() -> BTreeMap<&'static str, (&'static str, &'static str)> {
    [
        ("events", ("core.event", "agenda")),
        ("tasks", ("schedule.task", "tasks")),
        ("notes", ("knowledge.note", "notes")),
        ("journal notes", ("knowledge.note", "people")),
        ("documents", ("core.document", "docs")),
        ("parties", ("core.party", "people")),
        ("members", ("core.party", "tally")),
        ("profiles", ("people.profile", "people")),
        ("important dates", ("people.important_date", "people")),
        ("contact channels", ("social.contact_channel", "people")),
        ("activities", ("core.activity", "people")),
        ("obligations", ("tally.obligation", "people")),
        ("photos", ("core.content_item", "photos")),
        ("albums", ("media.album", "photos")),
        ("notebooks", ("knowledge.notebook", "notes")),
        ("places", ("core.place", "photos")),
        ("expenses", ("tally.expense", "tally")),
        ("groups", ("tally.group", "tally")),
        ("circles", ("social.circle", "tally")),
        ("settlements", ("tally.settlement", "tally")),
        ("accounts", ("core.account", "tally")),
        ("transactions", ("core.transaction", "tally")),
        ("projects", ("schedule.project", "tasks")),
        ("locker items", ("locker.item", "locker")),
        ("things", ("*", "*")),
    ]
    .into_iter()
    .collect()
}

/// Base-table columns of the Kinds above, plus the reader-computed facts.
const FIELD_WORDS: &str = "
account_id activity_id actor_party_id address address_json album
album_titles amount_minor archived_at area asset_id attendee_party_ids
author_party_id avatar_color avatar_content_id birth_date body_content_id
brand byte_size cadence_days camera_device_id capture_group_id captured_at
cardholder category category_concept_id channel_id circle_id closed_at
collection_id color completed_at compromised connection_id content_hash
content_id content_uri counterparty_party_id cover_content_id created_at
creator_party_id currency current_content_id current_revision_id date_id
deleted_at description direction display_name document_id dtend dtstart
due_at duration_s effort_min email end_tz ended_at event_id exif_json
expense_id expiry external_id external_ref favorite folder format
from_party fullname geo_lat geo_lng geohash group_id height ical_uid icon
incurred_on institution_party_id is_asset is_preferred item_id key_id kind
kind_concept_id label language last_contacted_at location_place_id
member_party_ids met month_day name network next_occurrence nickname
normalized_value note_id notebooks notes obligation_id opened_at
organizer_party_id origin_device_id original_amount_minor
original_currency owed_to_me owed_to_them owner_party_id paid_by paid_on
parent_collection_id parent_place_id parent_task_id party_id
password_set_at phone pinned place place_id posted_at priority profile_id
project_id provenance_json purge_at rate_date rate_scale rate_scaled
rate_source reason recurrence_anchor recurrence_semantics
recurring_template_id remind_before_min reminder_on role row_version rrule
rrule_support section_id sequence series_id settled_at settlement_currency
settlement_id simplify_opt_in sort_name sort_order source_app_id
source_asset_id spent_on split_method split_params_json starred start_tz
started_at status summary task_id title to_party transfer_group_id txn_id
type tz tz_offset_min updated_at url url_match_policy username value width
";

#[must_use]
pub fn fields() -> Vec<&'static str> {
    FIELD_WORDS.split_whitespace().collect()
}

/// A verb whose command is fixed only once the anchor's Kind is.
#[must_use]
pub fn verb_classes() -> BTreeMap<&'static str, BTreeMap<&'static str, &'static str>> {
    [
        ("reschedule", [
            ("schedule.task", "schedule.edit_task"),
            ("core.event", "schedule.reschedule_event"),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>()),
        ("delete", [
            ("schedule.task", "schedule.delete_task"),
            ("core.event", "schedule.delete_event"),
            ("knowledge.note", "knowledge.delete_note"),
            ("core.document", "core.trash_document"),
            ("tally.expense", "tally.delete_expense"),
            ("locker.item", "locker.trash_item"),
            ("core.content_item", "media.delete_asset"),
            ("core.party", "people.trash_person"),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>()),
        ("restore", [
            ("schedule.task", "schedule.restore_task"),
            ("core.event", "schedule.restore_event"),
            ("knowledge.note", "knowledge.restore_note"),
            ("core.document", "core.restore_document"),
            ("tally.expense", "tally.restore_expense"),
            ("locker.item", "locker.restore_item"),
            ("core.content_item", "media.restore_asset"),
            ("core.party", "people.restore_person"),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>()),
        ("complete", [
            ("schedule.task", "people.complete_task"),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>()),
        ("cancel", [
            ("core.event", "schedule.cancel_event"),
        ]
        .into_iter()
        .collect::<BTreeMap<_, _>>()),
    ]
    .into_iter()
    .collect()
}

const REFS: [&str; 6] = [
    "it",
    "them",
    "that one",
    "the other one",
    "the earlier one",
    "the last thing I added",
];

const WINDOW_PHRASES: [&str; 13] = [
    "today",
    "tomorrow",
    "yesterday",
    "this week",
    "last week",
    "next week",
    "this weekend",
    "last weekend",
    "this month",
    "last month",
    "next month",
    "before now",
    "recently",
];

const DECLINE_REASONS: [&str; 4] = [
    "out_of_ontology",
    "sealed_egress",
    "fabricated_secret",
    "unbounded_destruction",
];

const EGRESS_VERBS: [&str; 2] = [
    "locker.export",
    "social.send_message",
];

/// Commands whose declared egress is not `none` — the registry's own
/// `DECLARED_EGRESS`, not a judgement made here. `exec.rs` reads this
/// and holds no list of its own.
#[must_use]
pub fn egress_verbs() -> &'static [&'static str] {
    &EGRESS_VERBS
}
