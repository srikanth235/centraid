//! `people.person`'s ANSWER AS THE SHEET DRAWS IT. Pure; days are the core's.

use centraid_api_proto::core_v1 as wire;

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

pub fn person(locale: Locale, sheet: &wire::PeopleSheet, today: &str) -> wire::PeoplePersonData {
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
                intent: intent as i32,
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
                reminder_label: if date.reminder_on {
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
                toggleable: true,
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
    wire::PeoplePersonData {
        party_id: person.party_id.clone(),
        name: person.name.clone(),
        avatar: Some(fold::avatar(&person.party_id, &person.name)),
        role: person.role.clone(),
        cadence_line: format!("{} · {lowered}", fold::cadence(locale, person.cadence_days)),
        due_chip: person.due.then(|| wire::StatusChip {
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
    }
}

/// The page when the person is not there.
pub fn gone(locale: Locale) -> wire::EmptyState {
    wire::EmptyState {
        headline: words::gone_title(locale),
        body: words::gone_body(locale),
        action_label: words::back(locale),
        import_source: wire::ImportSource::Unspecified as i32,
    }
}
