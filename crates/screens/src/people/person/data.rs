//! `people.person`'s ANSWER AS THE SHEET DRAWS IT. Pure; days are the core's.

use centraid_api_proto::core_v1 as wire;

use crate::kit::civil::{self, HourCycle};
use crate::people::fold;
use crate::strings::{Locale, fill, people as words};

/// The id a birthday carries in the sheet's dates: it is a column of the person,
/// not a row of its own; its reminder is the person's own switch.
pub const BIRTHDAY_PREFIX: &str = "birthday:";

fn head(title: String, count: usize, verb: String) -> wire::PeopleSectionHead {
    wire::PeopleSectionHead {
        title,
        count: u32::try_from(count).unwrap_or(u32::MAX),
        verb_label: verb,
    }
}

fn empty_if(none: bool, sentence: String) -> String {
    if none { sentence } else { String::new() }
}

/// The channel a hero action reaches: the preferred one of that kind, else the first. The
/// order is the member's own (`position`), which is the order the sheet lists them in.
#[must_use]
pub fn channel_of<'a>(sheet: &'a wire::PeopleSheet, kind: &str) -> Option<&'a wire::PeopleChannel> {
    let of_kind = || {
        sheet
            .channels
            .iter()
            .filter(move |channel| channel.kind == kind && !channel.value.trim().is_empty())
    };
    of_kind()
        .find(|channel| channel.preferred)
        .or_else(|| of_kind().next())
}

/// THE HERO'S ACTIONS (#1173): Message and Call when the person has a phone, Mail when they
/// have an email, and Log a touch. An action the data cannot back is not offered. The
/// owner's own card has none: there is no one to reach and no touch to log.
#[must_use]
pub fn hero(locale: Locale, sheet: &wire::PeopleSheet) -> Vec<wire::PeopleHeroAction> {
    if sheet.is_me {
        return Vec::new();
    }
    let name = sheet
        .person
        .as_ref()
        .map(|person| person.name.as_str())
        .unwrap_or_default();
    let action = |key: &str, label: String, spoken: String, icon: &str, primary: bool| {
        wire::PeopleHeroAction {
            key: key.to_owned(),
            label,
            accessibility_label: fill(&spoken, &[("name", name)]),
            icon_key: icon.to_owned(),
            primary,
        }
    };
    let mut hero = Vec::new();
    if channel_of(sheet, "phone").is_some() {
        hero.push(action(
            HERO_MESSAGE,
            words::hero_message(locale),
            words::hero_message_a11y(locale),
            "MessageCircle",
            false,
        ));
        hero.push(action(
            HERO_CALL,
            words::hero_call(locale),
            words::hero_call_a11y(locale),
            "Phone",
            false,
        ));
    }
    if channel_of(sheet, "email").is_some() {
        hero.push(action(
            HERO_MAIL,
            words::hero_mail(locale),
            words::hero_mail_a11y(locale),
            "EnvelopeSimple",
            false,
        ));
    }
    hero.push(action(
        HERO_LOG,
        words::hero_log(locale),
        words::hero_log_a11y(locale),
        "Activity",
        true,
    ));
    hero
}

/// The hero actions' keys.
pub const HERO_MESSAGE: &str = "message";
pub const HERO_CALL: &str = "call";
pub const HERO_MAIL: &str = "mail";
pub const HERO_LOG: &str = "log";

/// An item's page in its own app. Built as the wire route that app registers under, because a
/// screen never names another app's module (as Notes' "Send to Agenda" is).
fn vault_route(item: &wire::PeopleVaultItem, today: &str) -> Option<wire::Route> {
    let (screen, args) = match item.kind.as_str() {
        "event" => (
            "calendar.event",
            wire::route::Args::AgendaEvent(wire::AgendaEventRoute {
                event_id: item.id.clone(),
                instance_key: String::new(),
                original_start_local: None,
                day: item
                    .local_start
                    .get(..10)
                    .filter(|day| !day.is_empty())
                    .unwrap_or(today)
                    .to_owned(),
            }),
        ),
        "task" => (
            "reminders.task",
            wire::route::Args::TodoDetail(wire::TodoDetailRoute {
                task_id: item.id.clone(),
            }),
        ),
        "note" => (
            "notes.editor",
            wire::route::Args::NotesEditor(wire::NotesEditorRoute {
                note_id: item.id.clone(),
                is_new: false,
            }),
        ),
        "document" => (
            "docs.document",
            wire::route::Args::DocsDocument(wire::DocsDocumentRoute {
                document_id: item.id.clone(),
                title: item.title.clone(),
                parent: String::new(),
            }),
        ),
        "txn" => (
            "money.transaction",
            wire::route::Args::MoneyTransaction(wire::MoneyTransactionRoute {
                txn_id: item.id.clone(),
                parent: String::new(),
            }),
        ),
        "photo" => (
            "photos.lightbox",
            wire::route::Args::PhotosLightbox(wire::PhotosLightboxRoute {
                photo_id: item.id.clone(),
                neighbour_ids: Vec::new(),
                album_id: String::new(),
            }),
        ),
        _ => return None,
    };
    Some(wire::Route {
        sheet: false,
        screen: screen.to_owned(),
        args: Some(args),
    })
}

/// IN YOUR VAULT (#1173): the rows, each in its own app's colour (the shell looks `app_key`
/// up), in the core's order: events, tasks, notes, documents, payments, photos. An item of a kind this build does not know
/// is not shown.
#[must_use]
pub fn vault(
    locale: Locale,
    cycle: HourCycle,
    sheet: &wire::PeopleSheet,
    today: &str,
) -> Vec<wire::PeopleVaultRow> {
    sheet
        .vault
        .iter()
        .filter_map(|item| {
            let route = vault_route(item, today)?;
            let (app_key, kind_label) = match item.kind.as_str() {
                "event" => ("calendar", words::vault_kind_event(locale)),
                "task" => ("reminders", words::vault_kind_task(locale)),
                "document" => ("docs", words::vault_kind_document(locale)),
                "txn" => ("money", words::vault_kind_payment(locale)),
                "photo" => ("photos", words::vault_kind_photo(locale)),
                _ => ("notes", words::vault_kind_note(locale)),
            };
            // A photograph or a payment with no title is still a row: it is called its kind.
            let title = if item.title.trim().is_empty() {
                kind_label.clone()
            } else {
                item.title.clone()
            };
            let when = if item.kind == "event" {
                event_when(locale, cycle, item)
            } else if item.kind == "document" && !item.via.is_empty() {
                // ON THE ITEM IT IS ATTACHED TO ("On Dinner with Maya").
                fill(&words::vault_on(locale), &[("item", &item.via)])
            } else {
                fold::when_logged(locale, &item.created_local_day, today)
            };
            Some(wire::PeopleVaultRow {
                id: item.id.clone(),
                app_key: app_key.to_owned(),
                accessibility_label: if when.is_empty() {
                    fill(
                        &words::vault_a11y_undated(locale),
                        &[("kind", &kind_label), ("title", &title)],
                    )
                } else {
                    fill(
                        &words::vault_a11y(locale),
                        &[("kind", &kind_label), ("title", &title), ("when", &when)],
                    )
                },
                kind_label,
                title,
                when_label: when,
                route: Some(route),
            })
        })
        .collect()
}

/// "Sat 7 Nov, 12:30", "Sat 7 Nov · all day", or empty for a recurring event.
fn event_when(locale: Locale, cycle: HourCycle, item: &wire::PeopleVaultItem) -> String {
    let Some(day) = item.local_start.get(..10) else {
        return String::new();
    };
    let day = civil::day_month(locale, day);
    if item.all_day {
        return fill(&words::vault_all_day(locale), &[("day", &day)]);
    }
    let time = civil::clock_for(locale, &item.local_start, cycle);
    if time.is_empty() {
        day
    } else {
        fill(&words::vault_at(locale), &[("day", &day), ("time", &time)])
    }
}

pub fn person(
    locale: Locale,
    cycle: HourCycle,
    sheet: &wire::PeopleSheet,
    today: &str,
) -> wire::PeoplePersonData {
    let person = sheet.person.clone().unwrap_or_default();
    let last_touch = fold::last_touch(
        locale,
        person.last_contacted_at.is_some(),
        &person.last_contacted_local_day,
        today,
        person.days_since_contact,
    );
    let lowered = {
        let mut chars = last_touch.chars();
        chars
            .next()
            .map(|first| format!("{}{}", first.to_lowercase(), chars.as_str()))
            .unwrap_or_default()
    };
    let mut facts = Vec::new();
    if !sheet.nickname.trim().is_empty() {
        facts.push(wire::PeopleFact {
            label: words::fact_nickname(locale),
            value: sheet.nickname.clone(),
        });
    }
    if !sheet.met.trim().is_empty() {
        facts.push(wire::PeopleFact {
            label: words::fact_met(locale),
            value: sheet.met.clone(),
        });
    }
    let channels: Vec<wire::PeopleChannelRow> = sheet
        .channels
        .iter()
        .map(|channel| {
            let kind = fold::channel_kind(locale, &channel.kind);
            let intent = fold::channel_intent(&channel.kind);
            wire::PeopleChannelRow {
                channel_id: channel.channel_id.clone(),
                kind_label: kind.clone(),
                value: channel.value.clone(),
                label: channel.label.clone().unwrap_or_default(),
                preferred_label: if channel.preferred {
                    words::preferred(locale)
                } else {
                    String::new()
                },
                duplicate_note: if channel.duplicate_names.is_empty() {
                    String::new()
                } else {
                    fill(
                        &words::also_on(locale),
                        &[("names", &channel.duplicate_names.join(", "))],
                    )
                },
                action_label: fold::channel_action(locale, intent),
                remove_label: fill(
                    &words::remove_channel(locale),
                    &[("kind", &kind.to_lowercase())],
                ),
                accessibility_label: fill(
                    &words::channel_a11y(locale),
                    &[("kind", &kind), ("value", &channel.value)],
                ),
            }
        })
        .collect();
    let dates: Vec<wire::PeopleDateRow> = sheet
        .dates
        .iter()
        .map(|date| {
            let day = fold::day_label(locale, today, date.in_days, &date.month_day);
            wire::PeopleDateRow {
                date_id: date.date_id.clone(),
                label: date.label.clone(),
                when_label: date
                    .in_days
                    .map(|days| fold::in_days(locale, days))
                    .unwrap_or_default(),
                reminder_on: date.reminder_on,
                // A BIRTHDAY HAS NO REMINDER: it is shown on its day and notifies nobody, so its row
                // carries no reminder wording at all.
                reminder_label: if date.date_id.starts_with(BIRTHDAY_PREFIX) {
                    String::new()
                } else if date.reminder_on {
                    words::reminder_on(locale)
                } else {
                    words::reminder_off(locale)
                },
                toggle_label: fill(
                    &if date.reminder_on {
                        words::reminder_turn_off(locale)
                    } else {
                        words::reminder_turn_on(locale)
                    },
                    &[("label", &date.label)],
                ),
                accessibility_label: fill(
                    &words::date_a11y(locale),
                    &[("label", &date.label), ("day", &day)],
                ),
                toggleable: !date.date_id.starts_with(BIRTHDAY_PREFIX),
                day_label: day,
            }
        })
        .collect();
    let notes: Vec<wire::PeopleNoteRow> = sheet
        .notes
        .iter()
        .map(|note| wire::PeopleNoteRow {
            annotation_id: note.annotation_id.clone(),
            text: note.text.clone(),
            when_label: fold::when_logged(locale, &note.created_local_day, today),
        })
        .collect();
    // v0 NEVER SHOWED THE LOG it wrote (audit): here it is.
    let touches: Vec<wire::PeopleTouchRow> = sheet
        .touches
        .iter()
        .map(|touch| {
            let kind = fold::touch_kind(locale, &touch.kind);
            let when = fold::when_logged(locale, &touch.occurred_local_day, today);
            wire::PeopleTouchRow {
                interaction_id: touch.interaction_id.clone(),
                accessibility_label: fill(
                    &words::touch_a11y(locale),
                    &[("kind", &kind), ("when", &when)],
                ),
                kind_label: kind,
                text: touch.text.clone(),
                when_label: when,
            }
        })
        .collect();
    // A RELATIONSHIP READS RIGHT FROM EACH SIDE: Ada's sheet says Beth is her "Mum"; Beth's sheet
    // says "Beth is their Mum" of Ada, because the edge is labelled by what its target is.
    let relations: Vec<wire::PeopleRelationRow> = sheet
        .relations
        .iter()
        .map(|relation| {
            let (meta, spoken) = if relation.incoming {
                let values = [
                    ("person", person.name.as_str()),
                    ("label", relation.label.as_str()),
                ];
                (
                    fill(&words::relation_in(locale), &values),
                    fill(
                        &words::relation_in_a11y(locale),
                        &[("name", relation.name.as_str()), values[0], values[1]],
                    ),
                )
            } else {
                (
                    relation.label.clone(),
                    fill(
                        &words::relation_out_a11y(locale),
                        &[
                            ("name", relation.name.as_str()),
                            ("person", person.name.as_str()),
                            ("label", relation.label.as_str()),
                        ],
                    ),
                )
            };
            wire::PeopleRelationRow {
                party_id: relation.party_id.clone(),
                name: relation.name.clone(),
                meta,
                accessibility_label: spoken,
            }
        })
        .collect();
    let vault = vault(locale, cycle, sheet, today);
    wire::PeoplePersonData {
        party_id: person.party_id.clone(),
        name: person.name.clone(),
        avatar: Some(fold::avatar(&person.party_id, &person.name)),
        role: person.role.clone(),
        // The owner's own card has no cadence to keep and nothing overdue.
        cadence_line: if sheet.is_me {
            String::new()
        } else {
            format!("{} · {lowered}", fold::cadence(locale, person.cadence_days))
        },
        due_chip: (person.due && !sheet.is_me).then(|| wire::StatusChip {
            label: words::chip_overdue(locale),
            tone: wire::status_chip::Tone::Net as i32,
        }),
        starred: person.starred,
        star_label: if person.starred {
            words::unstar_verb(locale)
        } else {
            words::star_verb(locale)
        },
        facts,
        channels_head: Some(head(
            words::section_channels(locale),
            channels.len(),
            words::add_channel(locale),
        )),
        channels_empty: empty_if(channels.is_empty(), words::empty_channels(locale)),
        channels,
        dates_head: Some(head(
            words::section_dates(locale),
            dates.len(),
            words::add_date(locale),
        )),
        dates_empty: empty_if(dates.is_empty(), words::empty_dates(locale)),
        dates,
        notes_head: Some(head(
            words::section_notes(locale),
            notes.len(),
            words::add_note(locale),
        )),
        notes_empty: empty_if(notes.is_empty(), words::empty_notes(locale)),
        notes,
        touches_head: Some(head(
            words::section_touches(locale),
            touches.len(),
            words::log_touch(locale),
        )),
        touches_empty: empty_if(touches.is_empty(), words::empty_touches(locale)),
        touches,
        relations_head: Some(head(
            words::section_relations(locale),
            relations.len(),
            String::new(),
        )),
        relations,
        hero: hero(locale, sheet),
        vault_head: Some(head(
            words::vault_head(locale),
            vault.len() + sheet.vault_more as usize,
            String::new(),
        )),
        vault_more: if sheet.vault_more == 0 {
            String::new()
        } else {
            fill(
                &words::vault_more(locale),
                &[("n", &sheet.vault_more.to_string())],
            )
        },
        vault,
        is_me: sheet.is_me,
        my_card_label: if sheet.is_me {
            words::my_card(locale)
        } else {
            String::new()
        },
        // The phone's words are the screen's second read, laid on by `Person::view`.
        name_phone_says: None,
        role_phone_says: None,
        nickname_phone_says: None,
        birthday_phone_says: None,
        channels_phone_says: Vec::new(),
        // The "Linked to" section is the screen's own read, laid on by `Person::view`.
        links: None,
        // The attachments are the screen's own read, laid on by `Person::view`.
        attachments: None,
    }
}

/// The page when the person is not there.
pub fn gone(locale: Locale) -> wire::EmptyState {
    wire::EmptyState {
        headline: words::gone_title(locale),
        body: words::gone_body(locale),
        action_label: words::back(locale),
        import_source: wire::ImportSource::Unspecified as i32,
        icon_key: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    fn channel(id: &str, kind: &str, value: &str, preferred: bool) -> wire::PeopleChannel {
        wire::PeopleChannel {
            channel_id: id.to_owned(),
            kind: kind.to_owned(),
            value: value.to_owned(),
            preferred,
            ..wire::PeopleChannel::default()
        }
    }

    fn sheet(channels: Vec<wire::PeopleChannel>) -> wire::PeopleSheet {
        wire::PeopleSheet {
            person: Some(wire::PeopleRosterRow {
                party_id: "ada".to_owned(),
                name: "Ada Lovelace".to_owned(),
                ..wire::PeopleRosterRow::default()
            }),
            channels,
            ..wire::PeopleSheet::default()
        }
    }

    fn keys(hero: &[wire::PeopleHeroAction]) -> Vec<&str> {
        hero.iter().map(|action| action.key.as_str()).collect()
    }

    #[test]
    fn the_hero_offers_only_what_the_data_allows() {
        // Nothing to reach them by: Log a touch alone.
        assert_eq!(keys(&hero(EN, &sheet(Vec::new()))), ["log"]);
        // A phone gives Message and Call; an email gives Mail; both, all four.
        let phone = channel("p", "phone", "+44 20 7946 0000", false);
        let email = channel("e", "email", "ada@analytical.example", false);
        assert_eq!(
            keys(&hero(EN, &sheet(vec![phone.clone()]))),
            ["message", "call", "log"]
        );
        assert_eq!(
            keys(&hero(EN, &sheet(vec![email.clone()]))),
            ["mail", "log"]
        );
        assert_eq!(
            keys(&hero(EN, &sheet(vec![email, phone]))),
            ["message", "call", "mail", "log"]
        );
        // An address or a handle is not a way to call or mail; a blank value is no channel.
        let other = vec![
            channel("a", "address", "12 Crescent Rd", false),
            channel("h", "handle", "@ada", false),
            channel("b", "phone", "   ", false),
            channel("c", "email", "", false),
        ];
        assert_eq!(keys(&hero(EN, &sheet(other))), ["log"]);
    }

    #[test]
    fn the_hero_s_words_are_the_boards_and_log_is_the_filled_one() {
        let all = hero(
            EN,
            &sheet(vec![
                channel("p", "phone", "1", false),
                channel("e", "email", "a@b.c", false),
            ]),
        );
        assert_eq!(
            all.iter().map(|a| a.label.as_str()).collect::<Vec<_>>(),
            ["message", "call", "mail", "log touch"]
        );
        assert_eq!(all[0].accessibility_label, "Message Ada Lovelace");
        assert_eq!(all[3].accessibility_label, "Log a touch with Ada Lovelace");
        assert_eq!(
            all.iter().map(|a| a.primary).collect::<Vec<_>>(),
            [false, false, false, true]
        );
    }

    #[test]
    fn the_owner_s_own_card_has_no_hero() {
        let mut mine = sheet(vec![channel("p", "phone", "1", false)]);
        mine.is_me = true;
        assert!(hero(EN, &mine).is_empty());
        let data = person(EN, HourCycle::default(), &mine, "2026-11-07");
        assert!(data.is_me && data.hero.is_empty());
        assert_eq!(data.my_card_label, "My card");
        assert!(
            data.cadence_line.is_empty(),
            "no cadence to keep on your own card"
        );
    }

    #[test]
    fn a_hero_reaches_the_preferred_channel_else_the_first() {
        let sheet = sheet(vec![
            channel("p1", "phone", "111", false),
            channel("p2", "phone", "222", true),
            channel("e1", "email", "x@y.z", false),
        ]);
        assert_eq!(channel_of(&sheet, "phone").unwrap().channel_id, "p2");
        assert_eq!(channel_of(&sheet, "email").unwrap().channel_id, "e1");
        assert!(channel_of(&sheet, "address").is_none());
    }

    fn item(kind: &str, id: &str, title: &str) -> wire::PeopleVaultItem {
        wire::PeopleVaultItem {
            id: id.to_owned(),
            kind: kind.to_owned(),
            title: title.to_owned(),
            created_local_day: "2026-11-04".to_owned(),
            ..wire::PeopleVaultItem::default()
        }
    }

    #[test]
    fn in_your_vault_keeps_the_cores_order_wears_each_apps_key_and_says_how_many_more() {
        let mut sheet = sheet(Vec::new());
        sheet.vault = vec![
            wire::PeopleVaultItem {
                local_start: "2026-11-07T12:30".to_owned(),
                ..item("event", "ev", "Lunch with Ada")
            },
            wire::PeopleVaultItem {
                local_start: "2026-12-25".to_owned(),
                all_day: true,
                ..item("event", "ev2", "Christmas")
            },
            item("event", "ev3", "Standing call"),
            item("task", "tk", "Send Ada the book"),
            item("note", "nt", "Loves chess, hates tea"),
            wire::PeopleVaultItem {
                via: "Lunch with Ada".to_owned(),
                ..item("document", "dc", "Menu.pdf")
            },
            item("document", "dc2", "Passport scan"),
            item("diary", "xx", "A kind this build does not know"),
        ];
        sheet.vault_more = 3;
        let data = person(EN, HourCycle::default(), &sheet, "2026-11-07");
        let head = data.vault_head.unwrap();
        assert_eq!(head.title, "In your vault");
        assert_eq!(
            head.count, 10,
            "the 7 shown and the 3 more: an unknown kind is not shown"
        );
        assert_eq!(
            data.vault
                .iter()
                .map(|row| (
                    row.app_key.as_str(),
                    row.kind_label.as_str(),
                    row.title.as_str()
                ))
                .collect::<Vec<_>>(),
            [
                ("calendar", "Event", "Lunch with Ada"),
                ("calendar", "Event", "Christmas"),
                ("calendar", "Event", "Standing call"),
                ("reminders", "Task", "Send Ada the book"),
                ("notes", "Note", "Loves chess, hates tea"),
                ("docs", "Doc", "Menu.pdf"),
                ("docs", "Doc", "Passport scan"),
            ]
        );
        assert_eq!(
            data.vault
                .iter()
                .map(|r| r.when_label.as_str())
                .collect::<Vec<_>>(),
            [
                "Sat 7 November, 12:30",
                "Fri 25 December · all day",
                "",
                "Wed 4 November",
                "Wed 4 November",
                "On Lunch with Ada",
                "Wed 4 November"
            ]
        );
        assert_eq!(data.vault_more, "and 3 more");
        assert_eq!(
            data.vault[0].accessibility_label,
            "Event: Lunch with Ada, Sat 7 November, 12:30"
        );
        assert_eq!(data.vault[2].accessibility_label, "Event: Standing call");
    }

    #[test]
    fn a_payment_and_a_photograph_wear_their_apps_and_open_their_own_pages() {
        let mut sheet = sheet(Vec::new());
        sheet.vault = vec![item("txn", "tx", "Rent"), item("photo", "ph", "")];
        let data = person(EN, HourCycle::default(), &sheet, "2026-11-07");
        assert_eq!(
            data.vault
                .iter()
                .map(|row| (row.app_key.as_str(), row.kind_label.as_str()))
                .collect::<Vec<_>>(),
            [("money", "Payment"), ("photos", "Photo")]
        );
        assert_eq!(
            data.vault[0].route.as_ref().unwrap().screen,
            "money.transaction"
        );
        assert_eq!(
            data.vault[1].route.as_ref().unwrap().screen,
            "photos.lightbox"
        );
    }

    #[test]
    fn an_item_opens_its_own_apps_page() {
        let mut sheet = sheet(Vec::new());
        sheet.vault = vec![
            wire::PeopleVaultItem {
                local_start: "2026-11-07T12:30".to_owned(),
                ..item("event", "ev", "Lunch")
            },
            item("event", "ev2", "Standing call"),
            item("task", "tk", "Send"),
            item("note", "nt", "Chess"),
            item("document", "dc", "Menu.pdf"),
        ];
        let rows = person(EN, HourCycle::default(), &sheet, "2026-11-09").vault;
        let routed: Vec<(&str, String)> = rows
            .iter()
            .map(|row| {
                let route = row.route.as_ref().unwrap();
                let detail = match route.args.as_ref().unwrap() {
                    wire::route::Args::AgendaEvent(e) => format!("{}@{}", e.event_id, e.day),
                    wire::route::Args::TodoDetail(t) => t.task_id.clone(),
                    wire::route::Args::NotesEditor(n) => format!("{}:{}", n.note_id, n.is_new),
                    wire::route::Args::DocsDocument(d) => format!("{}:{}", d.document_id, d.title),
                    other => panic!("{other:?}"),
                };
                (route.screen.as_str(), detail)
            })
            .collect();
        assert_eq!(
            routed,
            [
                ("calendar.event", "ev@2026-11-07".to_owned()),
                ("calendar.event", "ev2@2026-11-09".to_owned()),
                ("reminders.task", "tk".to_owned()),
                ("notes.editor", "nt:false".to_owned()),
                ("docs.document", "dc:Menu.pdf".to_owned()),
            ],
            "a dated event opens on its day, a repeating one on today"
        );
    }

    #[test]
    fn nothing_else_in_the_vault_draws_no_rows_and_no_more_line() {
        let data = person(EN, HourCycle::default(), &sheet(Vec::new()), "2026-11-07");
        assert!(data.vault.is_empty() && data.vault_more.is_empty());
        assert_eq!(data.vault_head.unwrap().count, 0);
    }
}
