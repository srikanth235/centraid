use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const ACCOUNT: &str = "01900000-0000-7000-8000-000000009301";
const PERSON: &str = "01900000-0000-7000-8000-000000009302";
const CALENDAR: &str = "01900000-0000-7000-8000-000000009303";
const EVENT: &str = "01900000-0000-7000-8000-000000009304";
const TASK: &str = "01900000-0000-7000-8000-000000009305";
const TXN: &str = "01900000-0000-7000-8000-000000009306";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("room-exports")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("the vault is founded");
    handle
        .open_own_bytes(dir.join("vault.bytes"))
        .expect("the byte store opens");
    centraid_screens::attach(&handle);
    handle
}

fn command(handle: &Handle, name: &str, input: serde_json::Value, key: &str) {
    let outcome = handle.command(name, &input, key).expect("command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> wire::RoomResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room call answers")
        .kind
        .expect("room response exists");
    let wire::response::Kind::Room(response) = answer else {
        panic!("expected room response")
    };
    response
}

fn open(handle: &Handle, key: &str, tab: &str) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: tab.to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .shown
    .into_iter()
    .last()
    .expect("opened room is shown")
}

fn send(
    handle: &Handle,
    shown: &wire::RoomShown,
    kind: wire::room_event::Kind,
) -> wire::RoomResponse {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: shown.instance,
            event: Some(wire::RoomEvent { kind: Some(kind) }),
        }),
    )
}

fn tap(selector: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: selector.to_owned(),
    })
}

fn effect(
    response: &wire::RoomResponse,
    matches: impl Fn(&wire::shell_effect::Kind) -> bool,
) -> wire::ShellEffect {
    response
        .effects
        .iter()
        .find(|effect| effect.kind.as_ref().is_some_and(&matches))
        .cloned()
        .expect("the expected shell effect is returned")
}

fn no_saved_paths(dir: &std::path::Path) {
    let staging = dir.join("vault.bytes").join("staging");
    let exports = staging.parent().unwrap().join("room-exports");
    if exports.exists() {
        assert_eq!(
            std::fs::read_dir(exports)
                .expect("room export directory is readable")
                .count(),
            0,
            "cancelled or finished exports leave no private staging file"
        );
    }
}

fn has_success_line(response: &wire::RoomResponse) -> bool {
    response.shown.iter().any(|shown| {
        shown
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .is_some_and(|line| line.sentence.starts_with("Export saved"))
    })
}

fn run_export(
    handle: &Handle,
    dir: &std::path::Path,
    key: &str,
    tab: &str,
    selector: &str,
    health_choice: Option<&str>,
    extension: &str,
) {
    let root = open(handle, key, tab);
    let asked = send(handle, &root, tap(selector));
    let chooser_or_owner = asked.shown.last().cloned().unwrap_or_else(|| root.clone());
    let owner_response = if let Some(kind) = health_choice {
        assert!(
            asked.effects.is_empty(),
            "Health first opens its export choices"
        );
        let choice = send(handle, &chooser_or_owner, tap(&format!("export/{kind}")));
        assert_eq!(choice.effects.len(), 1);
        choice
    } else {
        asked
    };
    let owner_check = effect(&owner_response, |kind| {
        matches!(kind, wire::shell_effect::Kind::OwnerCheck(_))
    });
    assert_eq!(owner_response.effects.len(), 1, "OwnerCheck is first");
    assert!(!has_success_line(&owner_response));
    no_saved_paths(dir);

    let cancelled = send(
        handle,
        &chooser_or_owner,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: owner_check.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Owner(
                wire::ShellOwner {
                    cancelled: true,
                    ..Default::default()
                },
            )),
        }),
    );
    assert!(
        cancelled.effects.is_empty(),
        "owner cancellation asks for no save"
    );
    assert!(!has_success_line(&cancelled));
    no_saved_paths(dir);

    let owner_retry = if let Some(kind) = health_choice {
        send(handle, &chooser_or_owner, tap(&format!("export/{kind}")))
    } else {
        send(handle, &root, tap(selector))
    };
    let retry_owner = effect(&owner_retry, |kind| {
        matches!(kind, wire::shell_effect::Kind::OwnerCheck(_))
    });
    let passed = send(
        handle,
        &chooser_or_owner,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: retry_owner.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Owner(
                wire::ShellOwner {
                    passed: true,
                    ..Default::default()
                },
            )),
        }),
    );
    let save = effect(&passed, |kind| {
        matches!(kind, wire::shell_effect::Kind::SaveFile(_))
    });
    assert_eq!(
        passed.effects.len(),
        1,
        "owner pass creates one save effect"
    );
    assert!(!has_success_line(&passed), "success waits for ShellDone");
    let Some(wire::shell_effect::Kind::SaveFile(file)) = save.kind.as_ref() else {
        unreachable!()
    };
    assert!(file.name.ends_with(extension), "{}", file.name);
    let path = std::path::Path::new(&file.path);
    let bytes = std::fs::read(path).expect("real formatter bytes were staged");
    assert!(!bytes.is_empty(), "the saved file is nonempty");
    match file.media_type.as_str() {
        "text/calendar" => assert!(bytes.starts_with(b"BEGIN:VCALENDAR")),
        "text/vcard" => assert!(bytes.starts_with(b"BEGIN:VCARD")),
        "application/zip" => assert!(bytes.starts_with(b"PK")),
        "text/csv" => assert!(
            bytes.starts_with(b"Date,")
                || bytes.starts_with(b"Time,")
                || bytes.starts_with(b"Date,Metric")
                || bytes.starts_with(b"Start,End,Type,"),
            "CSV has its formatter header: {}",
            String::from_utf8_lossy(&bytes)
        ),
        other => panic!("unexpected formatter media type {other}"),
    }

    let (pending_room, pending_status) = passed
        .shown
        .last()
        .and_then(|shown| shown.room.as_ref())
        .map(|room| (room.key.clone(), room.status_line.clone()))
        .unwrap_or_default();
    let save_cancelled = send(
        handle,
        &chooser_or_owner,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: save.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Failed(
                wire::ShellFailed {
                    cancelled: true,
                    ..Default::default()
                },
            )),
        }),
    );
    assert!(!has_success_line(&save_cancelled));
    assert!(!path.exists(), "cancelled save removes staged export bytes");
    assert_eq!(
        save_cancelled
            .shown
            .last()
            .and_then(|shown| shown.room.as_ref())
            .map(|room| room.key.as_str()),
        Some(pending_room.as_str())
    );
    let _ = pending_status;
    no_saved_paths(dir);

    let owner_retry = if let Some(kind) = health_choice {
        send(handle, &chooser_or_owner, tap(&format!("export/{kind}")))
    } else {
        send(handle, &root, tap(selector))
    };
    let retry_owner = effect(&owner_retry, |kind| {
        matches!(kind, wire::shell_effect::Kind::OwnerCheck(_))
    });
    let passed = send(
        handle,
        &chooser_or_owner,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: retry_owner.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Owner(
                wire::ShellOwner {
                    passed: true,
                    ..Default::default()
                },
            )),
        }),
    );
    let save = effect(&passed, |kind| {
        matches!(kind, wire::shell_effect::Kind::SaveFile(_))
    });
    let Some(wire::shell_effect::Kind::SaveFile(file)) = save.kind.as_ref() else {
        unreachable!()
    };
    let saved_path = std::path::PathBuf::from(&file.path);
    assert!(!has_success_line(&passed));
    assert!(
        !std::fs::read(&file.path)
            .expect("save retry bytes exist")
            .is_empty()
    );
    let completed = send(
        handle,
        &chooser_or_owner,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: save.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Done(wire::ShellDone {})),
        }),
    );
    assert!(
        has_success_line(&completed),
        "success follows ShellDone only"
    );
    assert!(
        !saved_path.exists(),
        "completed save cleans private staged bytes"
    );
    no_saved_paths(dir);
}

#[test]
fn every_non_locker_export_runs_owner_check_then_real_formatter_and_save_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    command(
        &handle,
        "container.create",
        json!({"id": CALENDAR, "kind": "calendar", "title": "Family"}),
        "export-calendar",
    );
    command(
        &handle,
        "event.propose",
        json!({"id": EVENT, "title": "Dentist", "starts": "2026-11-28T09:00", "ends": "2026-11-28T09:30", "timing": "floating", "calendar_id": CALENDAR}),
        "export-event",
    );
    command(
        &handle,
        "task.add",
        json!({"id": TASK, "title": "Pay bill", "due": "2026-11-30"}),
        "export-task",
    );
    command(
        &handle,
        "person.add",
        json!({"id": PERSON, "title": "Jordan Lee"}),
        "export-person",
    );
    command(
        &handle,
        "note.create",
        json!({"title": "Meeting notes", "body": "Bring the folder."}),
        "export-note",
    );
    command(
        &handle,
        "account.add",
        json!({"id": ACCOUNT, "title": "Checking", "type": "checking", "currency": "USD", "opening_minor": 5000, "opening_on": "2026-01-01"}),
        "export-account",
    );
    command(
        &handle,
        "txn.add",
        json!({"id": TXN, "account_id": ACCOUNT, "posted_on": "2026-11-27", "amount_minor": -1250, "title": "Coffee"}),
        "export-transaction",
    );
    command(
        &handle,
        "measurement.log",
        json!({"day": "2026-11-27", "metric": "steps", "value": 8000}),
        "export-measurement",
    );
    command(
        &handle,
        "reading.add",
        json!({"metric": "weight_kg", "at": "2026-11-27T07:00:00Z", "value": 70.5}),
        "export-reading",
    );
    command(
        &handle,
        "workout.log",
        json!({"starts": "2026-11-27T07:00:00Z", "title": "Morning walk", "type": "walking", "distance_m": 1200}),
        "export-workout",
    );

    for (key, tab, selector, health, extension) in [
        ("calendar", "calendar", "more/export", None, ".ics"),
        ("docs", "home", "more/export", None, ".zip"),
        ("money", "home", "more/export", None, ".csv"),
        ("notes", "home", "more/export", None, ".zip"),
        ("people", "home", "more/export", None, ".vcf"),
        ("photos", "home", "more/export", None, ".zip"),
        ("reminders", "home", "more/export", None, ".ics"),
        (
            "health",
            "home",
            "more/export",
            Some("measurements"),
            ".csv",
        ),
        ("health", "home", "more/export", Some("readings"), ".csv"),
        ("health", "home", "more/export", Some("workouts"), ".csv"),
    ] {
        run_export(&handle, dir.path(), key, tab, selector, health, extension);
    }
}
