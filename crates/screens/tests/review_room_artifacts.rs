//! Opt-in protobuf exporter for review screenshots. Every fixture comes from a real Core room
//! runtime response after registered vault commands; the test never constructs a Room tree.

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use prost::Message;
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const PERSON: &str = "01900000-0000-7000-8000-000000009101";
const PERSON_OTHER: &str = "01900000-0000-7000-8000-000000009110";
const ACCOUNT: &str = "01900000-0000-7000-8000-000000009102";
const TXN: &str = "01900000-0000-7000-8000-000000009103";
const BULK_TXN: &str = "01900000-0000-7000-8000-000000009111";
const SAVINGS: &str = "01900000-0000-7000-8000-000000009106";
const GROCERIES: &str = "01900000-0000-7000-8000-000000009107";
const DINING: &str = "01900000-0000-7000-8000-000000009108";
const HAND: &str = "01900000-0000-7000-8000-000000009109";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("review-room-artifacts")),
            ),
    )
    .expect("core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Review household", "Alex Review")?))
        .expect("vault is founded");
    centraid_screens::attach(&handle);
    handle
}

fn command(handle: &Handle, name: &str, input: serde_json::Value, key: &str) {
    let outcome = handle
        .command(name, &input, key)
        .expect("registered command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn room(handle: &Handle, kind: wire::room_request::Kind) -> wire::RoomShown {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room request succeeds")
        .kind
        .expect("room response exists");
    let wire::response::Kind::Room(response) = answer else {
        panic!("expected room response");
    };
    response.shown.into_iter().last().expect("room is shown")
}

fn open(handle: &Handle, key: &str, tab: &str, root: bool) -> wire::RoomShown {
    room(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: tab.to_owned(),
            root,
            ..Default::default()
        }),
    )
}

fn tap(handle: &Handle, shown: &wire::RoomShown, selector: &str) -> wire::RoomShown {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(wire::room_request::Kind::Send(wire::RoomSend {
                    instance: shown.instance,
                    event: Some(wire::RoomEvent {
                        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                            selector_id: selector.to_owned(),
                        })),
                    }),
                })),
            })),
        })
        .expect("tap is processed")
        .kind
        .expect("tap response exists");
    let wire::response::Kind::Room(response) = answer else {
        panic!("expected room response");
    };
    response.shown.into_iter().last().expect("room is shown")
}

fn text_change(
    handle: &Handle,
    shown: &wire::RoomShown,
    selector: &str,
    seq: u64,
    value: &str,
) -> wire::RoomShown {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(wire::room_request::Kind::Send(wire::RoomSend {
                    instance: shown.instance,
                    event: Some(wire::RoomEvent {
                        kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
                            selector_id: selector.to_owned(),
                            seq,
                            value: Some(wire::room_change::Value::Text(value.to_owned())),
                        })),
                    }),
                })),
            })),
        })
        .expect("field change is processed")
        .kind
        .expect("change response exists");
    let wire::response::Kind::Room(response) = answer else {
        panic!("expected room response");
    };
    response.shown.into_iter().last().expect("room is shown")
}

fn option_change(
    handle: &Handle,
    shown: &wire::RoomShown,
    selector: &str,
    seq: u64,
    value: &str,
) -> wire::RoomShown {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(wire::room_request::Kind::Send(wire::RoomSend {
                    instance: shown.instance,
                    event: Some(wire::RoomEvent {
                        kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
                            selector_id: selector.to_owned(),
                            seq,
                            value: Some(wire::room_change::Value::Option(value.to_owned())),
                        })),
                    }),
                })),
            })),
        })
        .expect("option change is processed")
        .kind
        .expect("change response exists");
    let wire::response::Kind::Room(response) = answer else {
        panic!("expected room response");
    };
    response.shown.into_iter().last().expect("room is shown")
}

fn stage_fixture(
    destination: &std::path::Path,
    filename: &str,
    shown: &wire::RoomShown,
    screen_key: &str,
    scenario: &str,
    source_test: &str,
    fixtures: &mut Vec<serde_json::Value>,
) {
    let room = shown.room.as_ref().expect("real Room runtime response");
    assert_eq!(room.key, screen_key, "fixture belongs to requested room");
    std::fs::write(destination.join(filename), room.encode_to_vec()).expect("write Room protobuf");
    fixtures.push(json!({
        "file": filename,
        "screen_key": screen_key,
        "scenario": scenario,
        "source_test": source_test,
        "origin": "real Core registered commands + Room runtime",
        "native_owner_or_save_effect_performed": false
    }));
}

#[test]
fn emit_review_room_artifacts_when_opted_in() {
    if std::env::var("CENTRAID_REVIEW_CAPTURE").ok().as_deref() != Some("1") {
        return;
    }

    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../mobile/androidApp/build/review/rooms");
    std::fs::create_dir_all(&root).expect("artifact directory exists");
    let mut fixtures = Vec::new();

    let people_dir = tempfile::tempdir().expect("people vault directory");
    let people = phone(people_dir.path());
    command(
        &people,
        "person.add",
        json!({"id": PERSON, "title": "Alex Morgan", "role": "Architect", "org": "North Studio", "nickname": "Alex"}),
        "review-person",
    );
    command(
        &people,
        "person.save_contact_point",
        json!({"id": PERSON, "kind": "email", "value": "alex@example.test", "label": "Work", "preferred": true}),
        "review-person-email",
    );
    let people_root = open(&people, "people", "home", true);
    stage_fixture(
        &root,
        "people_root.pb",
        &people_root,
        "people",
        "People root after registering a person with a work email",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );

    let people_detail = open(&people, &format!("person/{PERSON}"), "home", false);
    stage_fixture(
        &root,
        "people_detail.pb",
        &people_detail,
        &format!("person/{PERSON}"),
        "Person detail with persisted role, organization, and contact point",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );

    let people_edit = open(&people, &format!("person/{PERSON}/edit"), "home", false);
    stage_fixture(
        &root,
        "people_edit_form.pb",
        &people_edit,
        &format!("person/{PERSON}/edit"),
        "Person editor populated from registered person and contact-point commands",
        "room_people::new_and_edit_person_forms_keep_and_clear_d1_drafts",
        &mut fixtures,
    );

    command(
        &people,
        "person.add",
        json!({"id": PERSON_OTHER, "title": "Jordan Lee", "role": "Designer"}),
        "review-person-other",
    );
    command(
        &people,
        "entity.retitle",
        json!({"id": PERSON, "title": "Alex Morgan, updated"}),
        "review-person-retitle",
    );
    let versions = open(&people, &format!("person/{PERSON}/versions"), "home", false);
    stage_fixture(
        &root,
        "people_versions.pb",
        &versions,
        &format!("person/{PERSON}/versions"),
        "Earlier person revisions after a registered retitle command",
        "room_people::person_detail_shows_timeline_footers_catch_up_and_date_reminder_toggle",
        &mut fixtures,
    );

    let link_picker = open(&people, &format!("person/{PERSON}/link"), "home", false);
    stage_fixture(
        &root,
        "people_link_picker.pb",
        &link_picker,
        &format!("person/{PERSON}/link"),
        "Link picker with another registered person available; no link has been committed",
        "room_link_picker::link_picker_adds_a_search_result_and_undoes_the_link",
        &mut fixtures,
    );

    // Earlier detail sheets were opened on this tab after the root snapshot;
    // reopen the actual list before tapping its selector.
    let people_root = open(&people, "people", "home", true);
    let selecting = tap(&people, &people_root, &format!("row/{PERSON}/menu/select"));
    stage_fixture(
        &root,
        "people_selection_mode.pb",
        &selecting,
        "people",
        "People list selection mode before a bulk action",
        "room_people::home_tile_opens_people_and_list_flows_work",
        &mut fixtures,
    );

    command(
        &people,
        "follow.contacts",
        json!({
            "origin": {"ref": "review-phone", "label": "Phone", "device_id": "review-device"},
            "complete": true,
            "records": [{"external_id": "review-phone-jordan", "device_id": "review-device", "fields": {"title": "Jordan Phone", "given": "Jordan", "family": "Lee"}}]
        }),
        "review-phone-first-pass",
    );
    let followed_people = open(&people, "people", "home", true);
    let followed_id = snapshot::render(followed_people.room.as_ref().expect("People room"))
        .lines()
        .find(|line| line.contains("Jordan Phone\""))
        .and_then(|line| line.split("#row/").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .expect("registered follow creates a visible person row")
        .to_owned();
    command(
        &people,
        "entity.retitle",
        json!({"id": followed_id, "title": "Jordan Member Title"}),
        "review-member-title-correction",
    );
    command(
        &people,
        "follow.contacts",
        json!({
            "origin": {"ref": "review-phone", "label": "Phone", "device_id": "review-device"},
            "complete": true,
            "records": [{"external_id": "review-phone-jordan", "device_id": "review-device", "fields": {"title": "Jordan Phone Updated", "given": "Jordan", "family": "Lee"}}]
        }),
        "review-phone-second-pass",
    );
    let phone_says = open(&people, &format!("person/{followed_id}"), "home", false);
    let room = phone_says.room.as_ref().expect("Phone Says detail room");
    let ready = match room.state.as_ref().expect("detail state") {
        wire::room::State::Ready(ready) => ready,
        other => panic!("Phone Says detail should be ready: {other:?}"),
    };
    let says = ready
        .blocks
        .iter()
        .find_map(|block| match block.kind.as_ref() {
            Some(wire::room_block::Kind::Says(says)) => Some(says),
            _ => None,
        })
        .expect("a real phone title difference is rendered as RoomSays");
    assert_eq!(
        wire::RoomSaysSource::try_from(says.source),
        Ok(wire::RoomSaysSource::Phone)
    );
    assert!(
        says.fields.iter().any(|field| {
            field.label == "Name"
                && field.stated == "Jordan Phone Updated"
                && field.mine == "Jordan Member Title"
                && !field.take_selector_id.is_empty()
        }),
        "RoomSays must contain the phone title, member title, and scoped take selector: {says:?}"
    );
    stage_fixture(
        &root,
        "people_phone_says.pb",
        &phone_says,
        &format!("person/{followed_id}"),
        "Phone-stated title difference with a field-scoped take action",
        "vault/tests/lane_follow_people.rs::a_person_reports_title_scalars_and_points_while_they_differ_and_nothing_once_equal",
        &mut fixtures,
    );

    let money_dir = tempfile::tempdir().expect("money vault directory");
    let money = phone(money_dir.path());
    command(
        &money,
        "account.add",
        json!({"id": ACCOUNT, "title": "Everyday checking", "type": "checking", "currency": "USD", "opening_minor": 125000, "opening_on": "2026-01-01"}),
        "review-account",
    );
    command(
        &money,
        "account.add",
        json!({"id": SAVINGS, "title": "Savings", "type": "savings", "currency": "USD", "opening_minor": 50000, "opening_on": "2026-01-01"}),
        "review-savings",
    );
    command(
        &money,
        "txn.add",
        json!({"id": TXN, "account_id": ACCOUNT, "posted_on": "2026-11-24", "amount_minor": -8450, "title": "Market Fresh", "memo": "Weekly produce"}),
        "review-transaction",
    );
    command(
        &money,
        "txn.add",
        json!({"id": BULK_TXN, "account_id": ACCOUNT, "posted_on": "2026-11-22", "amount_minor": -2400, "title": "Pharmacy"}),
        "review-bulk-transaction",
    );
    command(
        &money,
        "category.add",
        json!({"id": GROCERIES, "title": "Groceries"}),
        "review-groceries",
    );
    command(
        &money,
        "category.add",
        json!({"id": DINING, "title": "Dining"}),
        "review-dining",
    );
    let money_root = open(&money, "money", "home", true);
    stage_fixture(
        &root,
        "money_root.pb",
        &money_root,
        "money",
        "Money activity with a checking account and posted expense",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );
    let selecting = tap(&money, &money_root, &format!("row/{TXN}/menu/select"));
    let selecting = tap(&money, &selecting, &format!("row/{TXN}"));
    let selected = tap(&money, &selecting, &format!("row/{BULK_TXN}"));
    let selected_text = snapshot::render(selected.room.as_ref().expect("selection screen"));
    assert!(selected_text.contains("2 selected"), "{selected_text}");
    stage_fixture(
        &root,
        "money_selection_mode.pb",
        &selected,
        "money",
        "Two selected transactions before one bulk category action and one Undo",
        "room_money::home_tile_opens_money_activity_and_list_flows_work",
        &mut fixtures,
    );

    let csv = open(&money, "money/import-csv", "home", true);
    let csv = text_change(
        &money,
        &csv,
        "field/csv",
        1,
        "Date,Description,Amount\n2026-11-03,Transit,-3.25\n2026-11-01,Bakery,-12.50\n2026-11-02,Refund,5.00",
    );
    let csv = option_change(&money, &csv, "csv/date_col", 1, "Date");
    let csv = option_change(&money, &csv, "csv/desc_col", 1, "Description");
    let mapped = option_change(&money, &csv, "csv/amount_col", 1, "Amount");
    stage_fixture(
        &root,
        "money_import_mapping.pb",
        &mapped,
        "money/import-csv",
        "CSV mapping preview from source rows supplied out of date order",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );

    let ambiguous_csv = open(&money, "money/import-csv", "home", true);
    let ambiguous_csv = text_change(
        &money,
        &ambiguous_csv,
        "field/csv",
        1,
        "Date,Description,Amount\n03/04/2026,Market,-18.25\n04/03/2026,Transit,-3.25",
    );
    let ambiguous_csv = option_change(&money, &ambiguous_csv, "csv/date_col", 1, "Date");
    let ambiguous_csv = option_change(&money, &ambiguous_csv, "csv/desc_col", 1, "Description");
    let ambiguous_csv = option_change(&money, &ambiguous_csv, "csv/amount_col", 1, "Amount");
    let question = ambiguous_csv
        .room
        .as_ref()
        .expect("ambiguous CSV form is shown");
    let question_text = centraid_screens::room::snapshot::render(question);
    assert!(question_text.contains("03/04/2026 could mean March 4 or April 3"));
    assert!(!question_text.contains("section #section/preview"));
    stage_fixture(
        &root,
        "money_csv_date_order_question.pb",
        &ambiguous_csv,
        "money/import-csv",
        "Ambiguous slash dates pause import and ask the member to choose month/day or day/month",
        "room_money::ambiguous_slash_dates_are_not_importable_until_member_chooses_order",
        &mut fixtures,
    );
    let ambiguous_csv = option_change(&money, &ambiguous_csv, "csv/date_order", 1, "mdy");
    assert!(
        centraid_screens::room::snapshot::render(
            ambiguous_csv
                .room
                .as_ref()
                .expect("chosen preview is shown")
        )
        .contains("2026-03-04")
    );
    stage_fixture(
        &root,
        "money_ambiguous_csv_date_order.pb",
        &ambiguous_csv,
        "money/import-csv",
        "Slash dates that can be read as month/day or day/month, with the member's explicit month/day choice visible",
        "room_money::csv_import_maps_columns_previews_three_rows_and_imports",
        &mut fixtures,
    );

    let currency = open(
        &money,
        &format!("money/account/{SAVINGS}/currency"),
        "home",
        false,
    );
    let currency = text_change(&money, &currency, "field/currency", 1, "EUR");
    let currency_confirm = tap(&money, &currency, "form/save");
    let currency_key = currency_confirm
        .room
        .as_ref()
        .expect("currency confirmation room")
        .key
        .clone();
    stage_fixture(
        &root,
        "money_currency_correction.pb",
        &currency_confirm,
        &currency_key,
        "Currency change confirmation before committing account currency correction",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );

    command(
        &money,
        "txn.add",
        json!({"id": HAND, "account_id": ACCOUNT, "posted_on": "2026-11-26", "amount_minor": -4800, "title": "Monthly Utility"}),
        "review-hand-transaction",
    );
    command(
        &money,
        "follow.statement",
        json!({"origin": {"ref": ACCOUNT, "label": "Monthly utility statement", "fills": ACCOUNT}, "records": [
            {"external_id": "review:utility-sep", "fields": {"title": "Monthly Utility", "posted_on": "2026-09-30", "amount_minor": -4800}},
            {"external_id": "review:utility-oct", "fields": {"title": "Monthly Utility", "posted_on": "2026-10-30", "amount_minor": -4800}},
            {"external_id": "review:utility-nov", "fields": {"title": "Monthly Utility", "posted_on": "2026-11-26", "amount_minor": -4800}}
        ]}),
        "review-recurring-statements",
    );
    let recurring = open(&money, "money/recurring", "home", false);
    stage_fixture(
        &root,
        "money_recurring.pb",
        &recurring,
        "money/recurring",
        "Derived recurring observation summary from three imported monthly statements",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );
    let match_accounts = open(&money, "money/matches", "home", false);
    let match_hands = tap(&money, &match_accounts, &format!("account/{ACCOUNT}"));
    stage_fixture(
        &root,
        "money_match_proposals.pb",
        &match_hands,
        &format!("money/matches/account/{ACCOUNT}"),
        "Hand-entered transaction list with statement match proposals",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );
    let match_candidates = tap(&money, &match_hands, &format!("hand/{HAND}"));
    stage_fixture(
        &root,
        "money_match_candidates.pb",
        &match_candidates,
        &format!("money/matches/hand/{HAND}"),
        "Statement candidates shown for explicit review before any match commit",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );

    command(
        &money,
        "txn.add",
        json!({"id": "01900000-0000-7000-8000-000000009104", "account_id": ACCOUNT, "posted_on": "2026-11-10", "amount_minor": -50000, "title": "Transfer to Savings"}),
        "review-transfer-out",
    );
    command(
        &money,
        "txn.add",
        json!({"id": "01900000-0000-7000-8000-000000009105", "account_id": SAVINGS, "posted_on": "2026-11-10", "amount_minor": 50000, "title": "Transfer from Checking"}),
        "review-transfer-in",
    );
    command(
        &money,
        "txn.link_transfer",
        json!({"id": "01900000-0000-7000-8000-000000009104", "other_id": "01900000-0000-7000-8000-000000009105"}),
        "review-transfer-link",
    );
    let transfers = open(&money, "money/transfers", "home", true);
    stage_fixture(
        &root,
        "money_transfer.pb",
        &transfers,
        "money/transfers",
        "Transfer list after a registered linked transfer command",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );
    let money_detail = open(&money, &format!("money/txn/{TXN}"), "home", false);
    stage_fixture(
        &root,
        "money_detail.pb",
        &money_detail,
        &format!("money/txn/{TXN}"),
        "Transaction detail for a persisted checking expense",
        "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
        &mut fixtures,
    );

    command(
        &money,
        "follow.statement",
        json!({
            "origin": {"ref": ACCOUNT, "label": "Checking statement", "fills": ACCOUNT},
            "records": [{
                "external_id": "review:statement-line",
                "fields": {
                    "title": "CORNER COOP #44",
                    "posted_on": "2026-11-19",
                    "amount_minor": -6200,
                    "line": {"memo": "Bank memo", "imported_from": "CSV"}
                }
            }]
        }),
        "review-statement-import",
    );
    let reimport = money
        .command(
            "follow.statement",
            &json!({
                "origin": {"ref": ACCOUNT, "label": "Checking statement", "fills": ACCOUNT},
                "records": [{
                    "external_id": "review:statement-line",
                    "fields": {
                        "title": "CORNER COOP #44",
                        "posted_on": "2026-11-19",
                        "amount_minor": -6200,
                        "line": {"memo": "Bank memo", "imported_from": "CSV"}
                    }
                }]
            }),
            "review-statement-reimport",
        )
        .expect("statement reimport runs with a new invoke key");
    assert_eq!(
        reimport.status,
        centraid_vault::CommandStatus::Executed,
        "statement reimport: {:?}",
        reimport.reason
    );
    assert_eq!(reimport.output["unchanged"].as_i64(), Some(1));
    let reimported_activity = open(&money, "money", "home", true);
    stage_fixture(
        &root,
        "money_statement_reimport_unchanged.pb",
        &reimported_activity,
        "money",
        "After a second statement import with a new invoke key reports one unchanged row and no duplicate transaction",
        "vault/tests/money.rs::a_statement_is_followed_line_by_line_and_a_reimport_writes_nothing",
        &mut fixtures,
    );
    let activity = open(&money, "money", "home", true);
    let statement_id = snapshot::render(activity.room.as_ref().expect("activity room"))
        .lines()
        .find(|line| line.contains("CORNER COOP #44"))
        .and_then(|line| line.split("#row/").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .expect("statement line is visible in activity")
        .to_owned();
    command(
        &money,
        "entity.retitle",
        json!({"id": statement_id, "title": "Corner Co-op"}),
        "review-statement-retitle",
    );
    command(
        &money,
        "txn.edit",
        json!({"id": statement_id, "amount_minor": -6000, "posted_on": "2026-11-20"}),
        "review-statement-edit",
    );
    command(
        &money,
        "txn.split",
        json!({"id": statement_id, "parts": [
            {"category_id": GROCERIES, "amount_minor": -4000},
            {"category_id": DINING, "amount_minor": -2000}
        ]}),
        "review-statement-split",
    );
    let statement_detail = open(&money, &format!("money/txn/{statement_id}"), "home", false);
    let statement_text =
        snapshot::render(statement_detail.room.as_ref().expect("statement detail"));
    assert!(
        statement_text.contains("Groceries"),
        "split has a Groceries part: {statement_text}"
    );
    assert!(
        statement_text.contains("Dining"),
        "split has a Dining part: {statement_text}"
    );
    stage_fixture(
        &root,
        "money_statement_says.pb",
        &statement_detail,
        &format!("money/txn/{statement_id}"),
        "Edited statement entry showing both split parts and the retained values the statement originally supplied",
        "room_money::txn_detail_shows_splits_statement_says_and_footers",
        &mut fixtures,
    );

    // Layout-pressure input for Android's overlay/glass check. Keep this outside the owner-review
    // manifest so it does not alter the 20 promise and Money scenario fixtures above.
    let glass_dir = tempfile::tempdir().expect("glass fixture vault directory");
    let glass = phone(glass_dir.path());
    const GLASS_ACCOUNT: &str = "01900000-0000-7000-8000-000000009112";
    command(
        &glass,
        "account.add",
        json!({"id": GLASS_ACCOUNT, "title": "Scroll pressure", "type": "checking", "currency": "USD", "opening_minor": 125000, "opening_on": "2026-01-01"}),
        "glass-account",
    );
    for index in 1..=40_u32 {
        let id = format!("01900000-0000-7000-8000-{index:012}");
        let day = (index - 1) % 28 + 1;
        command(
            &glass,
            "txn.add",
            json!({
                "id": id,
                "account_id": GLASS_ACCOUNT,
                "posted_on": format!("2026-11-{day:02}"),
                "amount_minor": -i64::from(index) * 125,
                "title": format!("Glass row {index:02}")
            }),
            &format!("glass-row-{index:02}"),
        );
    }
    let glass_activity = open(&glass, "money", "home", true);
    let glass_room = glass_activity.room.as_ref().expect("glass Money room");
    assert_eq!(glass_room.key, "money");
    let glass_text = snapshot::render(glass_room);
    assert!(
        glass_text
            .lines()
            .filter(|line| line.trim_start().starts_with("row #row/"))
            .count()
            >= 40,
        "layout fixture has 40 transaction rows to extend behind the footer: {glass_text}"
    );
    std::fs::write(
        root.join("money_glass_scroll.pb"),
        glass_room.encode_to_vec(),
    )
    .expect("layout fixture protobuf is written");
    std::fs::write(
        root.join("money_glass_scroll.json"),
        serde_json::to_vec_pretty(&json!({
            "file": "money_glass_scroll.pb",
            "screen_key": "money",
            "scenario": "40 registered Money transactions provide content beneath the overlaid footer for a layout-pressure check",
            "source_test": "review_room_artifacts::emit_review_room_artifacts_when_opted_in",
            "origin": "real Core registered commands + Room runtime",
            "owner_review_fixture": false
        }))
        .expect("layout fixture metadata encodes"),
    )
    .expect("layout fixture metadata is written");

    let manifest = json!({
        "schema_version": 1,
        "generated_by": "crates/screens/tests/review_room_artifacts.rs::emit_review_room_artifacts_when_opted_in",
        "artifact_format": "prost-encoded centraid.core.v1.Room",
        "native_os_owner_or_save_effects_simulated": false,
        "fixtures": fixtures,
        "coverage_notes": [
            "These artifacts prove Rust Room output only; they are not native-device approval.",
            "Owner authentication, OS save sheets, clipboard behavior, and hardware picker behavior are not simulated.",
            "This capture includes the unanswered ambiguous slash-date question with import blocked, the preview after explicit date order choice, CSV mapping, account currency confirmation, linked transfer, a second statement import reporting one unchanged row, and split statement-says detail.",
            "People captures cover root/detail, populated editor, version list, link picker, selection mode, and a real registered Phone-stated title difference. The link picker capture does not commit a link; the selection capture does not commit a bulk action.",
            "People import review/confirmation, successful vCard export, attachment staging, OS clipboard, and native share sheets are not captured here. Import and effect outcomes remain shell-owned; see room_people and room_link_picker behavior tests for supported interactions.",
            "Each fixture records its source behavior test or registered-command sequence in the fixture manifest; unsupported or native-owned work is stated here rather than drawn as completed."
        ]
    });
    std::fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).expect("manifest encodes"),
    )
    .expect("manifest is written");
}
