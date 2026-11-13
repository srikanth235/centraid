//! WHAT A MEMBER READS OF THE NEW BACKUP (#1191, lane B, row B16): every sentence in
//! `contracts/backup/states.json`, built from the readings the fixture describes and compared
//! word for word. The fixture is the one both shells' parity rests on: they draw the view state
//! the Rust screens make from these words, so a sentence changed here changes on both together.
//! Nothing here dials a gateway or reads a core.

use centraid_api_proto::core_v1 as wire;
use centraid_api_proto::core_v1::backup_line::Tone;
use centraid_screens::backup::line;
use centraid_screens::backup::reading::{Destination, Reading};
use centraid_screens::backup::states;
use centraid_screens::strings::Locale;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../contracts/backup/states.json");
const EN: Locale = Locale::En;

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("contracts/backup/states.json is JSON")
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or(0)
}

fn time(value: &Value, key: &str) -> Option<i64> {
    value[key].as_i64()
}

/// The core's own words for how a device stands, as the fixture spells them.
fn reach(name: &str) -> wire::DestinationReach {
    match name {
        "" => wire::DestinationReach::Ok,
        "moved" => wire::DestinationReach::Moved,
        "frozen" => wire::DestinationReach::Frozen,
        "gateway_old" => wire::DestinationReach::GatewayOld,
        "repairing" => wire::DestinationReach::Repairing,
        other => panic!("the fixture names a reach this test does not know: {other}"),
    }
}

/// A device as the core's status says it (the fixture uses the wire's field names), read the way
/// the screens read it: through `Reading::from_wire`, so the mapping is under test too.
fn wire_device(value: &Value) -> wire::Destination {
    let count = |key: &str| u32::try_from(number(value, key)).expect("a small count");
    wire::Destination {
        gateway_id: format!("id-{}", text(value, "label")),
        label: text(value, "label"),
        last_ack_ms: time(value, "last_ack_ms").unwrap_or(0),
        reach_state: reach(&text(value, "reach_state")) as i32,
        manifest_unreadable: flag(value, "manifest_unreadable"),
        held_count: count("held_count"),
        held_purge_at_ms: time(value, "held_purge_at_ms").unwrap_or(0),
        held_undoable: count("held_undoable"),
        sample_checked: count("sample_checked"),
        sample_of: count("sample_of"),
        ..wire::Destination::default()
    }
}

fn device(value: &Value) -> Destination {
    let status = wire::BackupStatusResponse {
        destinations: vec![wire_device(value)],
        ..wire::BackupStatusResponse::default()
    };
    Reading::from_wire(&status).destinations.remove(0)
}

fn reading(value: &Value) -> Reading {
    let status = wire::BackupStatusResponse {
        destinations: value["devices"]
            .as_array()
            .map(|devices| devices.iter().map(wire_device).collect())
            .unwrap_or_default(),
        acked_at_ms: time(value, "last_ack_ms"),
        content_total: number(value, "content_total"),
        content_confirmed: number(value, "content_confirmed"),
        ..wire::BackupStatusResponse::default()
    };
    Reading {
        // A DAMAGED VAULT IS THE OPEN ERROR, not a status field: the shell sets this flag.
        damaged: flag(value, "damaged"),
        ..Reading::from_wire(&status)
    }
}

fn tone(name: &str) -> i32 {
    (match name {
        "urgent" => Tone::Urgent,
        "attention" => Tone::Attention,
        "quiet" => Tone::Quiet,
        other => panic!("the fixture names a tone this test does not know: {other}"),
    }) as i32
}

fn cases<'a>(fixture: &'a Value, key: &str) -> &'a Vec<Value> {
    fixture[key]
        .as_array()
        .unwrap_or_else(|| panic!("the fixture has no `{key}`"))
}

#[test]
fn each_device_says_how_it_stands_and_what_it_holds_for_a_week() {
    let fixture = fixture();
    let zone = text(&fixture, "zone");
    let rows = cases(&fixture, "devices");
    assert!(rows.len() >= 10, "the fixture lost its device cases");
    for case in rows {
        let name = text(case, "name");
        let device = device(&case["device"]);
        assert_eq!(
            states::standing_words(EN, &device),
            text(case, "standing"),
            "{name}: how it stands"
        );
        let notes: Vec<String> = case["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|note| note.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            states::notes(EN, &zone, &device),
            notes,
            "{name}: its notes"
        );
        assert_eq!(
            states::can_undo(&device),
            flag(case, "undo"),
            "{name}: whether it offers Undo"
        );
    }
}

#[test]
fn a_device_that_is_not_simply_behind_is_named_with_its_reason() {
    let fixture = fixture();
    let zone = text(&fixture, "zone");
    let now = fixture["now_ms"].as_i64().unwrap();
    for case in cases(&fixture, "lines") {
        let name = text(case, "name");
        if case["reading"]["damaged"].is_null() {
            let read = reading(&case["reading"]);
            let built = line::line(EN, Some(&read), false, false, now);
            assert_eq!(built.sentence, text(case, "sentence"), "{name}: the line");
            assert_eq!(
                line::behind_reason(EN, &zone, &read, now).unwrap_or_default(),
                text(case, "reason"),
                "{name}: the reason under it"
            );
            assert_eq!(built.tone, tone(&text(case, "tone")), "{name}: the tone");
        }
    }
}

#[test]
fn a_damaged_vault_says_so_and_is_never_called_backed_up() {
    let fixture = fixture();
    let now = fixture["now_ms"].as_i64().unwrap();
    let mut seen = 0;
    for case in cases(&fixture, "lines") {
        if !flag(&case["reading"], "damaged") {
            continue;
        }
        seen += 1;
        let read = reading(&case["reading"]);
        assert!(read.damaged);
        let built = line::line(EN, Some(&read), false, false, now);
        assert_eq!(built.sentence, text(case, "sentence"));
        assert_eq!(built.status, text(case, "status"));
        assert_eq!(built.detail, text(case, "detail"), "what is safe is said");
        assert_eq!(built.tone, tone(&text(case, "tone")));
        // A backup 2 minutes old would otherwise read "Backed up": a damaged vault must not.
        assert!(!built.sentence.contains("Backed up"));
        assert!(line::warns(&read, now, false));
    }
    assert_eq!(seen, 1);
}

#[test]
fn the_rate_sentence_states_what_was_read() {
    let fixture = fixture();
    for case in cases(&fixture, "rate") {
        let name = text(case, "name");
        let said = states::rate_sentence(EN, number(case, "read"), number(case, "stored"));
        assert_eq!(
            said.as_deref(),
            case["sentence"].as_str(),
            "{name}: the rate sentence"
        );
    }
}

#[test]
fn the_restore_ask_names_the_date_and_the_device_and_does_not_claim() {
    let fixture = fixture();
    for case in cases(&fixture, "restore_ask") {
        let sentence = states::restore_ask(EN, &text(case, "date"), &text(case, "label"));
        assert_eq!(sentence, text(case, "sentence"), "{}", text(case, "name"));
    }
}

#[test]
fn no_sentence_says_what_the_member_is_never_told() {
    let fixture = fixture();
    let banned: Vec<String> = fixture["never_said"]
        .as_array()
        .unwrap()
        .iter()
        .map(|word| word.as_str().unwrap().to_lowercase())
        .collect();
    let mut every = Vec::new();
    for case in cases(&fixture, "devices") {
        every.push(text(case, "standing"));
        every.extend(case["notes"].as_array().unwrap().iter().map(text_of));
    }
    for key in ["lines", "rate", "restore_ask"] {
        for case in cases(&fixture, key) {
            for field in ["sentence", "status", "reason"] {
                if let Some(said) = case[field].as_str() {
                    every.push(said.to_owned());
                }
            }
        }
    }
    for said in every {
        for word in &banned {
            assert!(
                !said.to_lowercase().contains(word.as_str()),
                "\"{said}\" says \"{word}\""
            );
        }
    }
}

fn text_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}
