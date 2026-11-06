//! THE CORE'S PEOPLE ANSWERS, AS THE HOME DRAWS THEM. Pure; every day and count
//! is the core's, and every sentence is [`crate::strings::people`]'s.

use centraid_api_proto::core_v1 as wire;

use crate::kit::menu;
use crate::people::{fold, routes};
use crate::strings::{Locale, fill, people as words};

/// A reminder is a roster chip when it is at most this many days away.
const REMINDER_CHIP_DAYS: i64 = 30;

/// DAY ONE: nobody in People at all. The phone already holds the member's
/// people, so a shell that can read its contacts offers them here in place of
/// "Add person".
pub fn day_one(locale: Locale) -> wire::EmptyState {
    wire::EmptyState {
        headline: words::empty_roster_title(locale),
        body: words::empty_roster_body(locale),
        action_label: words::add_person(locale),
        import_source: wire::ImportSource::Contacts as i32,
    }
}

/// A CHIP WITH NOTHING IN IT over a roster that holds people: day one's words,
/// but not day one, so it does not offer the phone's contacts.
fn chip_empty(locale: Locale) -> wire::EmptyState {
    wire::EmptyState {
        import_source: wire::ImportSource::Unspecified as i32,
        ..day_one(locale)
    }
}

/// The filter section's key (`people-filter-show-starred` on a screen) and its
/// options' keys.
pub const FILTER: &str = "show";
pub const FILTER_ALL: &str = "all";
pub const FILTER_STARRED: &str = "starred";
pub const FILTER_DUE: &str = "due";

/// The sort section's options (`people-filter-sort-recent`).
pub const SORT_RECENT: &str = "recent";
pub const SORT_NAME: &str = "name";

/// THE HEADER'S MENU for the roster: All · Starred · Overdue with their counts
/// over the whole window (one picked, `current`), then the order (Recently added
/// · Name). Lit while Starred or Overdue narrows the roster; the order is no
/// filter.
pub fn filter_menu(
    locale: Locale,
    answer: &wire::PeopleRoster,
    current: wire::PeopleChipKey,
    order: wire::PeopleOrder,
) -> wire::FilterMenu {
    use wire::PeopleChipKey as K;
    let show = |key: &str, label: String, count: u32, chip: K| {
        menu::counted(key, label, count, current == chip)
    };
    menu::menu(
        locale,
        vec![
            menu::single(
                FILTER,
                words::filter_title(locale),
                vec![
                    show(
                        FILTER_ALL,
                        words::chip_all(locale),
                        answer.count_all,
                        K::All,
                    ),
                    show(
                        FILTER_STARRED,
                        words::chip_starred(locale),
                        answer.count_starred,
                        K::Starred,
                    ),
                    show(
                        FILTER_DUE,
                        words::chip_due(locale),
                        answer.count_due,
                        K::Due,
                    ),
                ],
            ),
            menu::single(
                menu::SORT,
                words::sort_heading(locale),
                vec![
                    menu::option(
                        SORT_RECENT,
                        words::sort_recent(locale),
                        order != wire::PeopleOrder::Name,
                    ),
                    menu::option(
                        SORT_NAME,
                        words::sort_name(locale),
                        order == wire::PeopleOrder::Name,
                    ),
                ],
            ),
        ],
        matches!(current, K::Starred | K::Due),
    )
}

/// The filter a pick of the filter section means, or None for any other pick.
#[must_use]
pub fn chip_of(pick: menu::Pick<'_>) -> Option<wire::PeopleChipKey> {
    use wire::PeopleChipKey as K;
    match (pick.section, pick.option) {
        (FILTER, FILTER_ALL) => Some(K::All),
        (FILTER, FILTER_STARRED) => Some(K::Starred),
        (FILTER, FILTER_DUE) => Some(K::Due),
        _ => None,
    }
}

/// The order a pick of the sort section means, or None for any other pick.
#[must_use]
pub fn order_of(pick: menu::Pick<'_>) -> Option<wire::PeopleOrder> {
    match (pick.section, pick.option) {
        (menu::SORT, SORT_RECENT) => Some(wire::PeopleOrder::Recent),
        (menu::SORT, SORT_NAME) => Some(wire::PeopleOrder::Name),
        _ => None,
    }
}

fn people_count(locale: Locale, n: u32) -> String {
    words::people_count(locale, u64::from(n))
}

/// One roster or search row. `today` is the answer's (empty on a search row,
/// whose "last touch" is then the core's own count).
pub fn row(locale: Locale, person: &wire::PeopleRosterRow, today: &str) -> wire::PeopleRow {
    let mut chips = Vec::new();
    if person.due {
        chips.push(wire::StatusChip {
            label: words::chip_overdue(locale),
            tone: wire::status_chip::Tone::Net as i32,
        });
    }
    if let Some(date) = person
        .reminders
        .iter()
        .filter(|date| date.in_days.is_some_and(|days| days <= REMINDER_CHIP_DAYS))
        .min_by_key(|date| date.in_days)
    {
        chips.push(wire::StatusChip {
            label: fill(
                &words::chip_reminder(locale),
                &[
                    ("label", &date.label),
                    (
                        "when",
                        &fold::in_days(locale, date.in_days.unwrap_or(0)).to_lowercase(),
                    ),
                ],
            ),
            tone: wire::status_chip::Tone::Neutral as i32,
        });
    }
    let accessibility = match (person.starred, person.due) {
        (true, true) => words::row_a11y_due_starred(locale),
        (true, false) => words::row_a11y_starred(locale),
        (false, true) => words::row_a11y_due(locale),
        (false, false) => words::row_a11y(locale),
    };
    wire::PeopleRow {
        party_id: person.party_id.clone(),
        name: person.name.clone(),
        avatar: Some(fold::avatar(&person.party_id, &person.name)),
        role: person.role.clone(),
        meta: fold::last_touch(
            locale,
            person.last_contacted_at.is_some(),
            &person.last_contacted_local_day,
            today,
            person.days_since_contact,
        ),
        chips,
        starred: person.starred,
        star_label: fill(
            &if person.starred {
                words::unstar(locale)
            } else {
                words::star(locale)
            },
            &[("name", &person.name)],
        ),
        accessibility_label: fill(&accessibility, &[("name", &person.name)]),
        route: Some(routes::person(&person.party_id, &person.name, false)),
    }
}

/// The roster surface: its rows and the sentence that stands in for none.
pub fn roster(
    locale: Locale,
    answer: &wire::PeopleRoster,
    current: wire::PeopleChipKey,
    order: wire::PeopleOrder,
) -> wire::PeopleRosterData {
    use wire::PeopleChipKey as K;
    let rows: Vec<wire::PeopleRow> = answer
        .people
        .iter()
        .map(|person| row(locale, person, &answer.today))
        .collect();
    let empty = if !rows.is_empty() {
        None
    } else if answer.count_all == 0 {
        Some(day_one(locale))
    } else if current == K::Starred {
        Some(wire::EmptyState {
            headline: words::empty_starred(locale),
            ..wire::EmptyState::default()
        })
    } else if current == K::Due {
        Some(wire::EmptyState {
            headline: words::empty_due(locale),
            ..wire::EmptyState::default()
        })
    } else {
        Some(chip_empty(locale))
    };
    let mut sections: Vec<wire::PeopleRosterSection> = Vec::new();
    if order == wire::PeopleOrder::Name {
        for row in &rows {
            let key = row
                .name
                .trim()
                .chars()
                .next()
                .filter(|letter| letter.is_alphabetic())
                .map(|letter| letter.to_uppercase().to_string())
                .unwrap_or_else(|| "#".to_owned());
            if let Some(section) = sections.last_mut().filter(|section| section.key == key) {
                section.rows.push(row.clone());
            } else {
                sections.push(wire::PeopleRosterSection {
                    title: key.clone(),
                    key,
                    rows: vec![row.clone()],
                });
            }
        }
    }
    wire::PeopleRosterData {
        sections,
        my_card: answer.my_card.as_ref().map(|person| {
            let mut card = row(locale, person, &answer.today);
            card.meta = words::my_card(locale);
            card.accessibility_label = [card.name.as_str(), card.role.as_str(), card.meta.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            card.star_label.clear();
            card.chips.clear();
            card
        }),
        my_card_label: words::my_card(locale),
        rows,
        empty,
        status_line: fill(
            &if answer.truncated {
                words::status_roster_shown(locale)
            } else {
                words::status_roster(locale)
            },
            &[
                ("people", &people_count(locale, answer.count_all)),
                ("due", &answer.count_due.to_string()),
                ("starred", &answer.count_starred.to_string()),
            ],
        ),
        truncated: answer.truncated,
    }
}

fn head(title: String, count: usize) -> wire::PeopleSectionHead {
    wire::PeopleSectionHead {
        title,
        count: u32::try_from(count).unwrap_or(u32::MAX),
        verb_label: String::new(),
    }
}

fn tile(
    locale: Locale,
    key: &str,
    label: String,
    count: u32,
    net: bool,
    tappable: bool,
) -> wire::PeopleTile {
    wire::PeopleTile {
        key: key.to_owned(),
        accessibility_label: fill(
            &words::chip_a11y(locale),
            &[("label", &label), ("count", &count.to_string())],
        ),
        label,
        count,
        net,
        tappable,
    }
}

/// The Touch surface: tiles, Reconnect (most overdue first, each with "Log a
/// touch"), Upcoming (nearest first) and Recent.
pub fn touch(locale: Locale, answer: &wire::PeopleTouch) -> wire::PeopleTouchData {
    let today = &answer.today;
    let reconnect: Vec<wire::PeopleCardRow> = answer
        .reconnect
        .iter()
        .map(|card| {
            let detail = words::days_over(locale, card.days_over.unwrap_or(0).unsigned_abs());
            wire::PeopleCardRow {
                party_id: card.party_id.clone(),
                name: card.name.clone(),
                avatar: Some(fold::avatar(&card.party_id, &card.name)),
                role: card.role.clone(),
                accessibility_label: format!("{}, {detail}", card.name),
                detail,
                action_label: words::log_touch(locale),
                route: Some(routes::person(&card.party_id, &card.name, false)),
                log_route: Some(routes::person(&card.party_id, &card.name, true)),
            }
        })
        .collect();
    let upcoming: Vec<wire::PeopleUpcomingRow> = answer
        .upcoming
        .iter()
        .filter_map(|up| {
            let (person, date) = (up.person.as_ref()?, up.date.as_ref()?);
            let when = date
                .in_days
                .map(|days| fold::in_days(locale, days))
                .unwrap_or_default();
            let day = fold::day_label(locale, today, date.in_days, &date.month_day);
            Some(wire::PeopleUpcomingRow {
                party_id: person.party_id.clone(),
                date_id: date.date_id.clone(),
                name: person.name.clone(),
                avatar: Some(fold::avatar(&person.party_id, &person.name)),
                label: date.label.clone(),
                accessibility_label: fill(
                    &words::upcoming_a11y(locale),
                    &[
                        ("name", &person.name),
                        ("label", &date.label),
                        ("when", if when.is_empty() { &day } else { &when }),
                    ],
                ),
                when_label: when,
                day_label: day,
                route: Some(routes::person(&person.party_id, &person.name, false)),
            })
        })
        .collect();
    let recent: Vec<wire::PeopleRecentRow> = answer
        .recent
        .iter()
        .map(|entry| {
            let kind = fold::touch_kind(locale, &entry.kind);
            let when = fold::when_logged(locale, &entry.occurred_local_day, today);
            wire::PeopleRecentRow {
                interaction_id: entry.interaction_id.clone(),
                party_id: entry.party_id.clone(),
                name: entry.name.clone(),
                avatar: Some(fold::avatar(&entry.party_id, &entry.name)),
                accessibility_label: fill(
                    &words::recent_a11y(locale),
                    &[("kind", &kind), ("name", &entry.name), ("when", &when)],
                ),
                kind_label: kind,
                text: entry.text.clone(),
                when_label: when,
                route: Some(routes::person(&entry.party_id, &entry.name, false)),
            }
        })
        .collect();
    wire::PeopleTouchData {
        tiles: vec![
            tile(
                locale,
                "all",
                words::tile_all(locale),
                answer.count_all,
                false,
                true,
            ),
            tile(
                locale,
                "reconnect",
                words::tile_reconnect(locale),
                answer.count_reconnect,
                true,
                true,
            ),
            // UPCOMING IS A FIGURE, NOT A CONTROL: its rows are right below it, and v0's tile
            // was a button that did nothing (audit).
            tile(
                locale,
                "upcoming",
                words::tile_upcoming(locale),
                answer.count_upcoming,
                false,
                false,
            ),
            tile(
                locale,
                "starred",
                words::tile_starred(locale),
                answer.count_starred,
                false,
                true,
            ),
        ],
        reconnect_head: Some(head(words::section_reconnect(locale), reconnect.len())),
        reconnect_empty: if reconnect.is_empty() {
            words::empty_reconnect(locale)
        } else {
            String::new()
        },
        reconnect,
        upcoming_head: Some(head(words::section_upcoming(locale), upcoming.len())),
        upcoming_empty: if upcoming.is_empty() {
            words::empty_upcoming(locale)
        } else {
            String::new()
        },
        upcoming,
        recent_head: Some(head(words::section_recent(locale), 0)),
        recent_empty: if recent.is_empty() {
            words::empty_recent(locale)
        } else {
            String::new()
        },
        recent,
        status_line: fill(
            &words::status_touch(locale),
            &[
                ("people", &people_count(locale, answer.count_all)),
                ("due", &answer.count_reconnect.to_string()),
            ],
        ),
        empty: (answer.count_all == 0).then(|| day_one(locale)),
    }
}

/// Search's rows, while a term is answering. Names only (the core's search).
pub fn search(locale: Locale, answer: &wire::PeopleSearch) -> wire::PeopleSearchResults {
    wire::PeopleSearchResults {
        rows: answer.people.iter().map(|p| row(locale, p, "")).collect(),
        empty: answer.people.is_empty().then(|| wire::EmptyState {
            headline: words::empty_no_match(locale),
            body: words::empty_no_match_body(locale),
            ..wire::EmptyState::default()
        }),
    }
}
