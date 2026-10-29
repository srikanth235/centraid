//! `imports.made`: what a made vault brings in (R-ONBOARD-8), the Rust port of `PhoneImportSpec`
//! plus the two imports lane C3 dropped: the reminders import and the calendar import offered when
//! the vault is created (#1135, lane I).

mod imports_support;

use centraid_api_proto::core_v1 as wire;
use imports_support::{Shell, shell};
use wire::effect::Kind as K;
use wire::effect_result::Outcome as O;

fn shell_for_made() -> Shell {
    let mut shell = shell();
    // The services open together; the camera roll's first read of the grant is not this file's.
    shell.d.effects.clear();
    shell
}

fn made(shell: &mut Shell, reminders: bool) {
    let instance = shell.made;
    shell.d.send(
        instance,
        wire::screen_event::Kind::ImportsMade(wire::ImportsMadeEvent {
            kind: Some(wire::imports_made_event::Kind::Made(
                wire::imports_made_event::Made { reminders },
            )),
        }),
    );
}

fn view(shell: &Shell) -> wire::ImportsMadeState {
    match &shell.d.views[&shell.made].kind {
        Some(wire::view_state::Kind::ImportsMade(state)) => state.clone(),
        other => panic!("made draws {other:?}"),
    }
}

/// The kinds of the effects pending, oldest first.
fn asked(shell: &Shell) -> Vec<String> {
    shell
        .d
        .effects
        .iter()
        .filter_map(|request| {
            Some(match request.effect.as_ref()?.kind.as_ref()? {
                // The made vault's own photo prompt; the camera roll's reads are its own.
                K::LibraryPermission(read) if request.instance == shell.made => {
                    format!("photo_prompt:ask={}", read.ask)
                }
                K::ContactsRead(read) => format!("contacts:ask={}", read.ask_permission),
                K::CalendarRead(read) => format!("calendar:ask={}", read.ask_permission),
                K::RemindersRead(read) => format!("reminders:ask={}", read.ask_permission),
                K::Keychain(op) => format!("keychain:{}", op.op),
                K::PhoneWatch(watch) => format!("watch:{}", watch.on),
                _ => return None,
            })
        })
        .collect()
}

/// Answer the oldest pending effect that is a read of a store (the keychain and the watch a
/// following import adds are the shell's to answer in passing).
fn answer_read(shell: &mut Shell, outcome: O) {
    while let Some(first) = shell.d.effects.first() {
        let passing = matches!(
            first.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(K::Keychain(_) | K::PhoneWatch(_))
        );
        if !passing {
            break;
        }
        shell.d.answer_effect(O::Done(wire::EffectDone {}));
    }
    shell.d.answer_effect(outcome);
}

fn contacts(names: &[&str]) -> O {
    O::Contacts(wire::ContactsSnapshot {
        complete: true,
        device_id: "install-1".to_owned(),
        containers: Vec::new(),
        contacts: names
            .iter()
            .enumerate()
            .map(|(at, name)| wire::PhoneContact {
                name: (*name).to_owned(),
                phone_id: format!("lookup:c{at}"),
                ..wire::PhoneContact::default()
            })
            .collect(),
    })
}

fn calendar(titles: &[&str]) -> O {
    O::Calendar(wire::CalendarSnapshot {
        now_ms: 1_792_000_000_000,
        device_zone: "UTC".to_owned(),
        complete: true,
        calendars: vec![wire::PhoneCalendar {
            key: "work".to_owned(),
            source_title: "Google".to_owned(),
            title: "Work".to_owned(),
            color: "#34C759".to_owned(),
        }],
        events: titles
            .iter()
            .enumerate()
            .map(|(at, title)| wire::PhoneCalendarEvent {
                title: (*title).to_owned(),
                start: format!("2026-10-2{}T10:00:00", at + 1),
                end: format!("2026-10-2{}T11:00:00", at + 1),
                tz: "UTC".to_owned(),
                phone_id: format!("uid:e{at}"),
                calendar_key: "work".to_owned(),
                ..wire::PhoneCalendarEvent::default()
            })
            .collect(),
        device_id: "install-1".to_owned(),
    })
}

fn reminders(items: &[(&str, &str, &str)]) -> O {
    O::RemindersSnapshot(wire::RemindersSnapshot {
        reminders: items
            .iter()
            .map(|(title, notes, due)| wire::PhoneReminder {
                title: (*title).to_owned(),
                notes: (*notes).to_owned(),
                due: (*due).to_owned(),
            })
            .collect(),
    })
}

fn denied() -> O {
    O::Failed(wire::EffectFailed {
        reason: "denied".to_owned(),
        denied: true,
        cancelled: false,
    })
}

fn open_tasks(shell: &Shell) -> u32 {
    use centraid_screens::catalog::load;
    use centraid_screens::kit::read;
    use wire::app_query_response::Answer;
    shell.d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::agenda::Board {
                limit: 500,
                ..load::agenda::Board::default()
            },
            |answer| match answer {
                Answer::AgendaTaskBoard(board) => board.counts.map(|counts| counts.open),
                _ => None,
            },
        ) {
            read::Reading::Data(open) => open,
            _ => panic!("the board reads"),
        }
    })
}

/// The member answered the photo prompt (no to it, so the camera roll stays still).
fn photos_answered(shell: &mut Shell) {
    let at = shell
        .d
        .effects
        .iter()
        .position(|request| {
            request.instance == shell.made
                && matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(K::LibraryPermission(_))
                )
        })
        .expect("the photo prompt was asked");
    let request = shell.d.effects.remove(at);
    shell.d.send(
        shell.made,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(O::LibraryPermissionRead(wire::LibraryPermissionRead {
                permission: wire::PhotosMediaPermission::Denied as i32,
            })),
        }),
    );
}

#[test]
fn photo_access_is_asked_once_and_only_after_it_is_answered_the_importers_run_in_turn() {
    let mut shell = shell_for_made();
    made(&mut shell, true);
    // TWO SYSTEM PROMPTS NEVER STACK: the photo prompt first, and nothing else until it is answered.
    assert_eq!(asked(&shell), vec!["photo_prompt:ask=true"]);
    assert!(view(&shell).running);
    photos_answered(&mut shell);
    assert_eq!(asked(&shell), vec!["contacts:ask=true"]);
    answer_read(&mut shell, contacts(&["Ada", "Grace"]));
    assert!(asked(&shell).contains(&"calendar:ask=true".to_owned()));
    answer_read(&mut shell, calendar(&["Standup"]));
    assert!(asked(&shell).contains(&"reminders:ask=true".to_owned()));
}

#[test]
fn one_line_says_what_came_in_and_opens_the_first_app_that_received_anything() {
    let mut shell = shell_for_made();
    made(&mut shell, true);
    photos_answered(&mut shell);
    answer_read(&mut shell, contacts(&["Ada", "Grace", "Linus"]));
    answer_read(&mut shell, calendar(&["Standup"]));
    answer_read(
        &mut shell,
        reminders(&[
            ("Renew passport", "bring photos", "2026-10-13"),
            ("Call mum", "", ""),
        ]),
    );
    let view = view(&shell);
    // THE SHARED LAST WORD IS SAID ONCE.
    assert_eq!(view.summary, "3 people, 1 event, 2 tasks imported");
    assert_eq!(view.open_label, "Open People");
    assert_eq!(view.open_route.expect("a route").screen, "people.home");
    assert!(view.finished && !view.running);
}

#[test]
fn reminders_become_ordinary_tasks_with_their_notes_and_due_day_and_a_duplicate_is_folded() {
    let mut shell = shell_for_made();
    let opened = open_tasks(&shell);
    made(&mut shell, true);
    photos_answered(&mut shell);
    answer_read(&mut shell, denied());
    answer_read(&mut shell, denied());
    answer_read(
        &mut shell,
        reminders(&[
            ("  Renew passport ", "bring photos", "2026-10-13"),
            ("renew passport", "", "2026-10-13"),
            ("Call mum", "", "not-a-day"),
        ]),
    );
    assert_eq!(view(&shell).summary, "2 tasks imported");
    assert_eq!(view(&shell).open_label, "Open Agenda");
    // The tasks are the vault's: the open count grew by the two that were not duplicates.
    assert_eq!(open_tasks(&shell), opened + 2);
}

#[test]
fn a_store_the_member_refused_or_with_nothing_to_bring_says_nothing() {
    let mut shell = shell_for_made();
    made(&mut shell, true);
    photos_answered(&mut shell);
    answer_read(&mut shell, denied());
    answer_read(&mut shell, calendar(&[]));
    answer_read(&mut shell, reminders(&[]));
    let view = view(&shell);
    assert_eq!(view.summary, "", "no line shows when nothing came in");
    assert_eq!(view.open_label, "");
    assert!(view.open_route.is_none());
    assert!(view.finished);
}

#[test]
fn a_phone_without_a_reminders_source_never_asks_for_them() {
    let mut shell = shell_for_made();
    made(&mut shell, false);
    photos_answered(&mut shell);
    answer_read(&mut shell, contacts(&["Ada"]));
    answer_read(&mut shell, calendar(&[]));
    assert!(!asked(&shell).iter().any(|a| a.starts_with("reminders")));
    let view = view(&shell);
    assert_eq!(view.summary, "1 person imported");
    assert!(view.finished);
}

#[test]
fn the_calendar_offered_when_the_vault_is_made_is_followed_from_then_on() {
    let mut shell = shell_for_made();
    made(&mut shell, false);
    photos_answered(&mut shell);
    answer_read(&mut shell, denied());
    answer_read(&mut shell, calendar(&["Standup"]));
    // The import marked this device as following and asked the shell to watch the store.
    let pending = asked(&shell);
    assert!(pending.contains(&"keychain:2".to_owned()), "{pending:?}");
    assert!(pending.contains(&"watch:true".to_owned()), "{pending:?}");
}

#[test]
fn a_made_event_is_heard_once() {
    let mut shell = shell_for_made();
    made(&mut shell, false);
    made(&mut shell, false);
    assert_eq!(
        asked(&shell),
        vec!["photo_prompt:ask=true"],
        "one prompt, however many times it is told"
    );
}
