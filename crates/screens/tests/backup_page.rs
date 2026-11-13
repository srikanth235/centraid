//! WHAT A MEMBER READS OF THE NEW BACKUP (#1191, lane B, row B16): every sentence in
//! `contracts/backup/states.json`, built from the readings the fixture describes and compared
//! word for word. The fixture is the one both shells' parity rests on: they draw the view state
//! the Rust screens make from these words, so a sentence changed here changes on both together.
//! Nothing here dials a gateway or reads a core.

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

fn device(value: &Value) -> Destination {
    Destination {
        gateway_id: format!("id-{}", text(value, "label")),
        label: text(value, "label"),
        last_ack_ms: time(value, "last_ack_ms"),
        moved: flag(value, "moved"),
        paused: flag(value, "paused"),
        too_old: flag(value, "too_old"),
        unreadable_backup: flag(value, "unreadable_backup"),
        damage_found: flag(value, "damage_found"),
        held_files: number(value, "held_files"),
        held_until_ms: time(value, "held_until_ms"),
        ..Destination::default()
    }
}

fn reading(value: &Value) -> Reading {
    Reading {
        destinations: value["devices"]
            .as_array()
            .map(|devices| devices.iter().map(device).collect())
            .unwrap_or_default(),
        last_ack_ms: time(value, "last_ack_ms"),
        content_total: number(value, "content_total"),
        content_confirmed: number(value, "content_confirmed"),
        damaged: flag(value, "damaged"),
        ..Reading::default()
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
