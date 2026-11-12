//! One person's page through the door a shell uses: the sheet's fold, the write
//! sheets and their refusals, the confirms, the channel effects and the merge.
//! Ports the Person cases of `PeopleSpec` over a real vault.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::people::routes;
use centraid_screens::testing::Driver;
use people_support::*;
use wire::people_person_event::{self as ev, Kind as P};

/// A person with a nickname, how-we-met, two channels, a date, a note and a touch.
fn dana(d: &Driver) -> String {
    let id = id_of(&arrange(
        d,
        act::people::AddPerson {
            title: "Dana Reyes".to_owned(),
            role: Some("Designer".to_owned()),
            nickname: Some("Dee".to_owned()),
            cadence_days: Some(14),
            ..Default::default()
        },
    ));
    arrange(
        d,
        act::people::SaveContactChannel {
            contact_point_id: id.clone(),
            kind: act::people::SaveContactChannelKind::Phone,
            value: "+44 20 7946 0000".to_owned(),
            preferred: Some(true),
            ..Default::default()
        },
    );
    arrange(
        d,
        act::people::SaveContactChannel {
            contact_point_id: id.clone(),
            kind: act::people::SaveContactChannelKind::Email,
            value: "dana@example.com".to_owned(),
            ..Default::default()
        },
    );
    arrange(
        d,
        act::people::AddImportantDate {
            id: id.clone(),
            label: "Anniversary".to_owned(),
            month_day: "08-14".to_owned(),
            reminder_on: Some(true),
        },
    );
    arrange(
        d,
        act::people::AddNote {
            id: id.clone(),
            text: "Loves ceramics".to_owned(),
        },
    );
    arrange(
        d,
        act::people::LogInteraction {
            person_id: id.clone(),
            kind: "call".to_owned(),
            text: Some("Caught up".to_owned()),
        },
    );
    id
}

fn opened(d: &mut Driver) -> (u64, String) {
    let id = dana(d);
    let i = open_person(d, &id, "Dana Reyes");
    (i, id)
}

fn sheet_of_view(v: &wire::ViewState) -> &wire::PeoplePersonSheet {
    person_state(v).sheet.as_ref().expect("a sheet is up")
}

#[test]
fn the_sheet_folds_the_header_facts_channels_dates_notes_and_the_touch_log() {
    let mut d = clean();
    let (i, id) = opened(&mut d);
    let state = person_state(d.view(i));
    assert_eq!(state.name_hint, "Dana Reyes");
    assert_eq!(state.edit, Some(routes::editor(&id)));
    let data = person_data(d.view(i));
    assert_eq!(data.name, "Dana Reyes");
    assert_eq!(data.role, "Designer");
    assert_eq!(data.avatar.as_ref().unwrap().initials, "DR");
    assert_eq!(data.cadence_line, "Every 14 days · last touch today");
    assert_eq!(data.star_label, "Star");
    assert_eq!(
        data.facts
            .iter()
            .map(|f| (f.label.as_str(), f.value.as_str()))
            .collect::<Vec<_>>(),
        [("Nickname", "Dee")]
    );
    let channels: Vec<(&str, &str)> = data
        .channels
        .iter()
        .map(|c| (c.kind_label.as_str(), c.action_label.as_str()))
        .collect();
    assert!(channels.contains(&("Phone", "Call")));
    assert!(channels.contains(&("Email", "Email")));
    let phone = data
        .channels
        .iter()
        .find(|c| c.kind_label == "Phone")
        .unwrap();
    assert_eq!(phone.preferred_label, "preferred");
    assert_eq!(phone.remove_label, "Remove this phone");
    assert_eq!(data.channels_head.as_ref().unwrap().count, 2);
    assert_eq!(
        data.channels_head.as_ref().unwrap().verb_label,
        "Add channel"
    );
    assert_eq!(data.channels_empty, "");
    let date = data
        .dates
        .iter()
        .find(|d| d.label == "Anniversary")
        .unwrap();
    assert_eq!(date.reminder_label, "Reminder on");
    assert!(date.toggleable);
    assert!(
        date.when_label == "Today"
            || date.when_label == "Tomorrow"
            || date.when_label.starts_with("In ")
    );
    assert_eq!(data.notes[0].text, "Loves ceramics");
    assert_eq!(data.notes[0].when_label, "Today");
    // THE LOG v0 NEVER SHOWED.
    assert_eq!(data.touches[0].kind_label, "Call");
    assert_eq!(data.touches[0].text, "Caught up");
    assert_eq!(data.touches_head.as_ref().unwrap().count, 1);
}

#[test]
fn a_person_with_no_channels_says_so_and_one_who_is_not_there_is_gone() {
    let mut d = clean();
    let id = person(&d, "Sam");
    let i = open_person(&mut d, &id, "Sam");
    let data = person_data(d.view(i));
    assert_eq!(data.channels_empty, "No channels.");
    assert_eq!(data.channels_head.as_ref().unwrap().count, 0);
    assert_eq!(data.cadence_line, "No cadence · no touch logged yet");

    let gone = open_person(&mut d, "p-nobody", "Nobody");
    // A person no longer there is a final failure in its own words, never an empty page.
    let state = person_state(d.view(gone));
    assert!(state.content.is_none());
    assert_eq!(
        people_support::gone_of(&state.page).sentence,
        "This person is not in People."
    );
    // Gone is not an error, and there is no editor to open on nothing.
    assert!(person_state(d.view(gone)).edit.is_none());
}

#[test]
fn log_a_touch_is_a_write_sheet_and_a_commit_closes_it() {
    let mut d = clean();
    let id = dana(&d);
    // Touch's card opens the page with the sheet already up.
    let i = d.push("people", routes::person(&id, "Dana Reyes", true));
    let log = match &sheet_of_view(d.view(i)).kind {
        Some(wire::people_person_sheet::Kind::LogTouch(log)) => log.clone(),
        other => panic!("expected the log sheet, found {other:?}"),
    };
    assert_eq!(
        log.kinds
            .iter()
            .map(|k| k.label.as_str())
            .collect::<Vec<_>>(),
        ["Message", "Call", "Met up", "Note"]
    );
    assert_eq!(log.hint, "Logging stamps last contacted.");
    assert!(log.frame.as_ref().unwrap().submit_enabled);

    send_person(
        &mut d,
        i,
        P::KindPicked(ev::KindPicked {
            key: "met up".into(),
        }),
    );
    send_person(
        &mut d,
        i,
        P::Text(ev::TextChanged {
            text: "Coffee in town".into(),
        }),
    );
    send_person(&mut d, i, P::Submitted(ev::SheetSubmitted {}));
    let state = person_state(d.view(i));
    assert!(state.sheet.is_none());
    assert_eq!(
        state.status.as_ref().unwrap().sentence,
        "Met up logged · Dana Reyes"
    );
    let data = person_data(d.view(i));
    assert_eq!(data.touches_head.as_ref().unwrap().count, 2);
    assert!(
        data.touches
            .iter()
            .any(|t| t.kind_label == "Met up" && t.text == "Coffee in town")
    );
}

#[test]
fn a_refused_write_keeps_the_sheet_and_the_words_with_the_sentence_over_them() {
    let mut d = clean();
    let (i, _) = opened(&mut d);
    send_person(
        &mut d,
        i,
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::Channel as i32,
        }),
    );
    // A value the vault will not take (past its ceiling).
    let long = "x".repeat(600);
    send_person(&mut d, i, P::Text(ev::TextChanged { text: long.clone() }));
    send_person(&mut d, i, P::Submitted(ev::SheetSubmitted {}));
    let sheet = sheet_of_view(d.view(i));
    let Some(wire::people_person_sheet::Kind::Channel(channel)) = &sheet.kind else {
        panic!("the channel sheet stays");
    };
    assert_eq!(channel.value, long);
    let failure = channel
        .frame
        .as_ref()
        .unwrap()
        .failure
        .as_ref()
        .expect("a sentence");
    assert!(!failure.sentence.is_empty());
    // A field edit clears the sentence: the member is answering it.
    send_person(
        &mut d,
        i,
        P::Text(ev::TextChanged {
            text: "dana@elsewhere.example".into(),
        }),
    );
    let Some(wire::people_person_sheet::Kind::Channel(channel)) = &sheet_of_view(d.view(i)).kind
    else {
        panic!("the channel sheet stays");
    };
    assert!(channel.frame.as_ref().unwrap().failure.is_none());
}

#[test]
fn a_dates_month_and_day_are_checked_before_the_write_and_the_leap_day_counts() {
    let mut d = clean();
    let (i, _) = opened(&mut d);
    send_person(
        &mut d,
        i,
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::Date as i32,
        }),
    );
    send_person(
        &mut d,
        i,
        P::Text(ev::TextChanged {
            text: "Birthday".into(),
        }),
    );
    send_person(
        &mut d,
        i,
        P::SecondText(ev::SecondTextChanged {
            text: "13-45".into(),
        }),
    );
    let date = |v: &wire::ViewState| match &sheet_of_view(v).kind {
        Some(wire::people_person_sheet::Kind::Date(date)) => date.clone(),
        other => panic!("expected the date sheet, found {other:?}"),
    };
    let typed = date(d.view(i));
    assert_eq!(typed.month_day_invalid, "Use month and day, like 08-14.");
    assert!(!typed.frame.as_ref().unwrap().submit_enabled);
    send_person(&mut d, i, P::Submitted(ev::SheetSubmitted {}));
    assert!(person_state(d.view(i)).sheet.is_some(), "nothing was sent");

    send_person(
        &mut d,
        i,
        P::SecondText(ev::SecondTextChanged {
            text: "02-29".into(),
        }),
    );
    assert!(date(d.view(i)).frame.as_ref().unwrap().submit_enabled);
    send_person(&mut d, i, P::Submitted(ev::SheetSubmitted {}));
    let state = person_state(d.view(i));
    assert_eq!(
        state.status.as_ref().unwrap().sentence,
        "Date added · Dana Reyes"
    );
    let data = person_data(d.view(i));
    assert!(data.dates.iter().any(|d| d.label == "Birthday"));
}

#[test]
fn a_reminder_is_set_not_toggled_blind_and_its_outcome_names_the_date() {
    let mut d = clean();
    let (i, _) = opened(&mut d);
    let anniversary = person_data(d.view(i))
        .dates
        .iter()
        .find(|date| date.label == "Anniversary")
        .unwrap()
        .date_id
        .clone();
    send_person(
        &mut d,
        i,
        P::Reminder(ev::ReminderToggled {
            date_id: anniversary.clone(),
        }),
    );
    assert_eq!(
        person_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Reminder off · Anniversary"
    );
    let date = person_data(d.view(i))
        .dates
        .iter()
        .find(|date| date.date_id == anniversary)
        .unwrap()
        .clone();
    assert!(!date.reminder_on);
    assert_eq!(date.toggle_label, "Turn on the reminder for Anniversary");
    send_person(
        &mut d,
        i,
        P::Reminder(ev::ReminderToggled {
            date_id: anniversary,
        }),
    );
    assert_eq!(
        person_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Reminder on · Anniversary"
    );
}

#[test]
fn the_star_is_a_write_and_the_label_follows_the_vault() {
    let mut d = clean();
    let (i, _) = opened(&mut d);
    send_person(&mut d, i, P::Star(ev::StarToggled {}));
    assert_eq!(
        person_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Dana Reyes starred"
    );
    let data = person_data(d.view(i));
    assert!(data.starred);
    assert_eq!(data.star_label, "Remove star");
    send_person(&mut d, i, P::Star(ev::StarToggled {}));
    assert_eq!(
        person_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Star removed · Dana Reyes"
    );
}

#[test]
fn move_to_trash_and_remove_a_channel_are_asked_first_and_the_trash_commit_pops_the_screen() {
    let mut d = clean();
    let (i, id) = opened(&mut d);
    let email = person_data(d.view(i))
        .channels
        .iter()
        .find(|c| c.kind_label == "Email")
        .unwrap()
        .channel_id
        .clone();
    send_person(
        &mut d,
        i,
        P::RemoveChannel(ev::RemoveChannelTapped { channel_id: email }),
    );
    let confirm = person_state(d.view(i))
        .confirm
        .clone()
        .expect("asked first");
    assert_eq!(confirm.title, "Remove this email?");
    assert_eq!(confirm.body, "There is no undo for this one.");
    assert!(confirm.destructive);
    send_person(&mut d, i, P::Dismissed(ev::Dismissed {}));
    assert!(person_state(d.view(i)).confirm.is_none());
    assert_eq!(
        person_data(d.view(i)).channels.len(),
        2,
        "dismissing wrote nothing"
    );

    let email = person_data(d.view(i))
        .channels
        .iter()
        .find(|c| c.kind_label == "Email")
        .unwrap()
        .channel_id
        .clone();
    send_person(
        &mut d,
        i,
        P::RemoveChannel(ev::RemoveChannelTapped { channel_id: email }),
    );
    send_person(&mut d, i, P::Confirmed(ev::Confirmed {}));
    assert_eq!(
        person_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Email removed"
    );
    assert_eq!(person_data(d.view(i)).channels.len(), 1);

    send_person(&mut d, i, P::TrashTapped(ev::TrashTapped {}));
    let confirm = person_state(d.view(i)).confirm.clone().unwrap();
    assert_eq!(confirm.title, "Move Dana Reyes to trash?");
    assert_eq!(confirm.body, "Restorable for 30 days.");
    assert!(!person_state(d.view(i)).done);
    send_person(&mut d, i, P::Confirmed(ev::Confirmed {}));
    let state = person_state(d.view(i));
    assert!(state.done, "the shell pops");
    assert_eq!(
        state.status.as_ref().unwrap().sentence,
        "Dana Reyes moved to trash"
    );
    assert!(
        sheet_of(&d, &id).sheet.is_none(),
        "the person is in the trash"
    );
}

#[test]
fn merge_is_a_choices_sheet_from_the_roster_then_a_confirm_then_the_merge() {
    let mut d = clean();
    let (i, id) = opened(&mut d);
    let dupe = person(&d, "Dana R");
    send_person(
        &mut d,
        i,
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::Merge as i32,
        }),
    );
    let merge = match &sheet_of_view(d.view(i)).kind {
        Some(wire::people_person_sheet::Kind::Merge(merge)) => merge.clone(),
        other => panic!("expected the merge sheet, found {other:?}"),
    };
    assert_eq!(merge.title, "Merge in");
    let Some(wire::people_merge_sheet::Content::Choices(choices)) = &merge.content else {
        panic!("the choices stand");
    };
    // Everyone but the person themselves.
    let offered: Vec<&str> = choices
        .choices
        .iter()
        .map(|c| c.party_id.as_str())
        .collect();
    assert_eq!(offered, [dupe.as_str()]);
    send_person(
        &mut d,
        i,
        P::MergePicked(ev::MergePicked {
            party_id: dupe.clone(),
        }),
    );
    let state = person_state(d.view(i));
    assert!(state.sheet.is_none());
    let confirm = state.confirm.clone().unwrap();
    assert_eq!(confirm.title, "Merge Dana R into Dana Reyes?");
    assert_eq!(confirm.body, "Merging cannot be undone.");
    send_person(&mut d, i, P::Confirmed(ev::Confirmed {}));
    assert_eq!(
        person_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Dana R merged into Dana Reyes"
    );
    assert!(sheet_of(&d, &dupe).sheet.is_none(), "the duplicate is gone");
    assert!(sheet_of(&d, &id).sheet.is_some());
}

#[test]
fn nobody_else_to_merge_in_is_said_in_one_sentence() {
    let mut d = clean();
    let id = person(&d, "Solo");
    let i = open_person(&mut d, &id, "Solo");
    send_person(
        &mut d,
        i,
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::Merge as i32,
        }),
    );
    let Some(wire::people_person_sheet::Kind::Merge(merge)) = &sheet_of_view(d.view(i)).kind else {
        panic!("the merge sheet");
    };
    assert!(merge.content.is_none());
    assert_eq!(
        people_support::empty_of(&merge.page).headline,
        "Nobody to merge in."
    );
}

#[test]
fn a_channel_tap_asks_the_os_to_call_mail_map_or_copy() {
    use wire::effect::Kind as K;
    let mut d = clean();
    let (i, id) = opened(&mut d);
    for (kind, value) in [("address", "1 High St, Leeds"), ("handle", "@dana")] {
        arrange(
            &d,
            act::people::SaveContactChannel {
                contact_point_id: id.clone(),
                kind: match kind {
                    "address" => act::people::SaveContactChannelKind::Address,
                    _ => act::people::SaveContactChannelKind::Handle,
                },
                value: value.to_owned(),
                ..Default::default()
            },
        );
    }
    d.pump(std::time::Duration::from_millis(300));
    let channels = person_data(d.view(i)).channels.clone();
    let tap = |d: &mut Driver, kind: &str| -> wire::Effect {
        let row = channels.iter().find(|c| c.kind_label == kind).unwrap();
        let update = d.send(
            i,
            wire::screen_event::Kind::PeoplePerson(wire::PeoplePersonEvent {
                kind: Some(P::Channel(ev::ChannelTapped {
                    channel_id: row.channel_id.clone(),
                })),
            }),
        );
        update.effects[0].effect.clone().expect("an effect")
    };
    assert_eq!(
        tap(&mut d, "Phone").kind,
        Some(K::OpenUrl(wire::OpenUrl {
            url: "tel:+442079460000".into()
        }))
    );
    assert_eq!(
        tap(&mut d, "Email").kind,
        Some(K::OpenUrl(wire::OpenUrl {
            url: "mailto:dana@example.com".into()
        }))
    );
    assert_eq!(
        tap(&mut d, "Address").kind,
        Some(K::OpenMap(wire::OpenMap {
            query: "1 High St, Leeds".into()
        }))
    );
    assert_eq!(
        tap(&mut d, "Handle").kind,
        Some(K::ClipboardSet(wire::ClipboardSet {
            text: "@dana".into(),
            sensitive: false,
            clear_after_ms: 0
        }))
    );
}

#[test]
fn a_relationship_is_on_both_sheets_each_read_from_its_own_side() {
    let mut d = clean();
    let ada = person(&d, "Ada");
    let beth = person(&d, "Beth");
    arrange(
        &d,
        act::people::AddRelationship {
            person_id: ada.clone(),
            kind: "Mum".to_owned(),
            name: "Beth".to_owned(),
            related_id: Some(beth.clone()),
            ..Default::default()
        },
    );
    let i = open_person(&mut d, &ada, "Ada");
    let data = person_data(d.view(i));
    assert_eq!(data.relations_head.as_ref().unwrap().count, 1);
    assert_eq!(
        data.relations
            .iter()
            .map(|r| (
                r.name.as_str(),
                r.meta.as_str(),
                r.accessibility_label.as_str()
            ))
            .collect::<Vec<_>>(),
        [("Beth", "Mum", "Beth, Ada's Mum")],
        "Ada's sheet: Beth is her Mum"
    );
    let j = open_person(&mut d, &beth, "Beth");
    let data = person_data(d.view(j));
    assert_eq!(
        data.relations
            .iter()
            .map(|r| (
                r.name.as_str(),
                r.meta.as_str(),
                r.accessibility_label.as_str()
            ))
            .collect::<Vec<_>>(),
        [("Ada", "Beth is their Mum", "Ada, Beth is their Mum")],
        "Beth's sheet: she is Ada's Mum"
    );
}

#[test]
fn a_birthday_says_no_reminder_and_has_no_switch() {
    let mut d = clean();
    let id = id_of(&arrange(
        &d,
        act::people::AddPerson {
            title: "Cy".to_owned(),
            birthday: Some("03-04".to_owned()),
            ..Default::default()
        },
    ));
    let i = open_person(&mut d, &id, "Cy");
    let birthday = |d: &Driver, i| {
        person_data(d.view(i))
            .dates
            .iter()
            .find(|date| date.label == "Birthday")
            .expect("the birthday stays on the sheet")
            .clone()
    };
    let before = birthday(&d, i);
    assert!(!before.toggleable, "{before:?}");
    // A birthday is shown on its day and notifies nobody: its row carries no reminder wording.
    assert_eq!(before.reminder_label, "");
    send_person(
        &mut d,
        i,
        P::Reminder(ev::ReminderToggled {
            date_id: before.date_id.clone(),
        }),
    );
    let after = birthday(&d, i);
    assert!(!after.toggleable, "{after:?}");
    assert_eq!(after.reminder_label, "");
}

fn hero_keys(d: &Driver, i: u64) -> Vec<String> {
    person_data(d.view(i))
        .hero
        .iter()
        .map(|action| action.key.clone())
        .collect()
}

fn hero_tap(d: &mut Driver, i: u64, key: &str) -> wire::ScreenUpdate {
    d.send(
        i,
        wire::screen_event::Kind::PeoplePerson(wire::PeoplePersonEvent {
            kind: Some(P::Hero(ev::HeroTapped {
                key: key.to_owned(),
            })),
        }),
    )
}

#[test]
fn the_hero_reaches_the_preferred_phone_and_the_email_and_log_opens_its_sheet() {
    use wire::effect::Kind as K;
    let mut d = clean();
    let (i, _) = opened(&mut d);
    assert_eq!(hero_keys(&d, i), ["message", "call", "mail", "log"]);
    let effect = |update: wire::ScreenUpdate| update.effects[0].effect.clone().expect("an effect");
    assert_eq!(
        effect(hero_tap(&mut d, i, "message")).kind,
        Some(K::OpenUrl(wire::OpenUrl {
            url: "sms:+442079460000".into()
        }))
    );
    assert_eq!(
        effect(hero_tap(&mut d, i, "call")).kind,
        Some(K::OpenUrl(wire::OpenUrl {
            url: "tel:+442079460000".into()
        }))
    );
    assert_eq!(
        effect(hero_tap(&mut d, i, "mail")).kind,
        Some(K::OpenUrl(wire::OpenUrl {
            url: "mailto:dana@example.com".into()
        }))
    );
    // An unknown action is nothing; Log a touch opens the sheet and asks the OS for nothing.
    assert!(hero_tap(&mut d, i, "fax").effects.is_empty());
    assert!(person_state(d.view(i)).sheet.is_none());
    assert!(hero_tap(&mut d, i, "log").effects.is_empty());
    let Some(wire::people_person_sheet::Kind::LogTouch(_)) = &sheet_of_view(d.view(i)).kind else {
        panic!("the Log a touch sheet is up");
    };
}

#[test]
fn a_person_with_no_phone_or_email_is_offered_log_a_touch_alone() {
    let mut d = clean();
    let id = person(&d, "Bea Okafor");
    let i = open_person(&mut d, &id, "Bea Okafor");
    assert_eq!(hero_keys(&d, i), ["log"]);
    // A tap on what is not offered asks the OS for nothing.
    for key in ["message", "call", "mail"] {
        assert!(hero_tap(&mut d, i, key).effects.is_empty(), "{key}");
    }
}

#[test]
fn in_your_vault_lists_a_task_about_the_person_in_agendas_own_page_and_colour() {
    let mut d = clean();
    let id = person(&d, "Ada Lovelace");
    let task = arrange(
        &d,
        act::people::AddTask {
            id: id.clone(),
            text: "Send Ada the book".to_owned(),
        },
    );
    let i = open_person(&mut d, &id, "Ada Lovelace");
    let data = person_data(d.view(i));
    assert_eq!(data.vault_head.as_ref().unwrap().title, "In your vault");
    assert_eq!(data.vault_head.as_ref().unwrap().count, 1);
    assert_eq!(data.vault.len(), 1);
    let row = &data.vault[0];
    assert_eq!(
        (
            row.app_key.as_str(),
            row.kind_label.as_str(),
            row.title.as_str()
        ),
        ("reminders", "Task", "Send Ada the book")
    );
    let task: serde_json::Value = serde_json::from_slice(&task.output).unwrap();
    assert_eq!(row.id, task["task_id"].as_str().unwrap());
    assert_eq!(row.route.as_ref().unwrap().screen, "reminders.task");
    assert!(data.vault_more.is_empty());
    // The follow-up is also the person's own, and a person with nothing else has none.
    let other = person(&d, "Bea Okafor");
    let j = open_person(&mut d, &other, "Bea Okafor");
    assert!(person_data(d.view(j)).vault.is_empty());
}

#[test]
fn my_card_is_the_owner_s_own_sheet_and_offers_no_star_merge_trash_or_touch() {
    let mut d = clean();
    let owner = roster_of(&d).owner.expect("the vault has an owner");
    let i = open_person(&mut d, &owner.party_id, &owner.name);
    let data = person_data(d.view(i));
    assert!(data.is_me);
    assert_eq!(data.my_card_label, "My card");
    assert!(data.hero.is_empty() && data.due_chip.is_none());
    assert_eq!(data.party_id, owner.party_id);
    // The writes that are about someone else are not made on it.
    for event in [
        P::Star(ev::StarToggled {}),
        P::TrashTapped(ev::TrashTapped {}),
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::Merge as i32,
        }),
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::LogTouch as i32,
        }),
    ] {
        send_person(&mut d, i, event);
        let state = person_state(d.view(i));
        assert!(state.sheet.is_none() && state.confirm.is_none() && !state.done);
        assert!(!person_data(d.view(i)).starred);
    }
    // Your own notes and dates are still yours to write.
    send_person(
        &mut d,
        i,
        P::SheetOpened(ev::SheetOpened {
            which: ev::sheet_opened::Which::Note as i32,
        }),
    );
    assert!(person_state(d.view(i)).sheet.is_some());
}
