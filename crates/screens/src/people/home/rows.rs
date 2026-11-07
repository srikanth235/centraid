//! THE CORE'S PEOPLE ANSWERS, AS THE HOME DRAWS THEM. Pure; every day and count
//! is the core's, and every sentence is [`crate::strings::people`]'s.

use centraid_api_proto::core_v1 as wire;

use crate::kit::menu;
use crate::people::{fold, routes, sections};
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

/// MY CARD (#1173): the owner's own card, above the list. Offered only under the All filter
/// (a filter narrows the list, and My card is not a person in it) and only when the vault names
/// an owner. A nameless owner is "Me".
fn my_card(
    locale: Locale,
    answer: &wire::PeopleRoster,
    current: wire::PeopleChipKey,
) -> Option<wire::PeopleMyCard> {
    if current != wire::PeopleChipKey::All {
        return None;
    }
    let owner = answer.owner.as_ref()?;
    let name = if owner.name.trim().is_empty() {
        words::my_card_unnamed(locale)
    } else {
        owner.name.clone()
    };
    Some(wire::PeopleMyCard {
        party_id: owner.party_id.clone(),
        avatar: Some(fold::avatar(&owner.party_id, &name)),
        label: words::my_card(locale),
        accessibility_label: fill(&words::my_card_a11y(locale), &[("name", &name)]),
        route: Some(routes::person(&owner.party_id, &name, false)),
        name,
    })
}

/// THE RECONNECT LINE (#1173): "3 to reconnect · Dana is 26 days over". The count is the whole
/// window's; the person named is the most overdue of the rows (ties by id), so it is said only
/// under the All filter, where the rows are the whole window. Nobody overdue, no line.
fn reconnect(
    locale: Locale,
    answer: &wire::PeopleRoster,
    current: wire::PeopleChipKey,
) -> Option<wire::PeopleReconnectLine> {
    if current != wire::PeopleChipKey::All || answer.count_due == 0 {
        return None;
    }
    let count = answer.count_due.to_string();
    let worst = answer
        .people
        .iter()
        .filter(|person| person.due)
        .map(|person| (person.days_since_contact - person.cadence_days, person))
        .filter(|(over, _)| *over > 0)
        .max_by(|(left, a), (right, b)| left.cmp(right).then_with(|| b.party_id.cmp(&a.party_id)));
    let text = match worst {
        Some((over, person)) => fill(
            &words::reconnect_line_who(locale),
            &[
                ("n", &count),
                ("name", &person.name),
                ("over", &words::days_over(locale, over.unsigned_abs())),
            ],
        ),
        None => fill(&words::reconnect_line(locale), &[("n", &count)]),
    };
    Some(wire::PeopleReconnectLine {
        accessibility_label: fill(&words::reconnect_a11y(locale), &[("text", &text)]),
        action_label: words::band_touch(locale),
        text,
    })
}

/// The roster surface: its rows and the sentence that stands in for none. Under the Name
/// order the rows are A to Z in `sections` with their `index`; under any other they are the
/// flat `rows`.
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
    let (rows, sections, index) = if order == wire::PeopleOrder::Name {
        let (sections, index) = sections::sectioned(locale, rows);
        (Vec::new(), sections, index)
    } else {
        (rows, Vec::new(), Vec::new())
    };
    wire::PeopleRosterData {
        rows,
        sections,
        index,
        my_card: my_card(locale, answer, current),
        reconnect: reconnect(locale, answer, current),
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

#[cfg(test)]
mod tests {
    use super::*;
    use wire::PeopleChipKey as K;

    const EN: Locale = Locale::En;

    fn person(id: &str, name: &str, cadence: i64, since: i64, due: bool) -> wire::PeopleRosterRow {
        wire::PeopleRosterRow {
            party_id: id.to_owned(),
            name: name.to_owned(),
            cadence_days: cadence,
            days_since_contact: since,
            due,
            ..wire::PeopleRosterRow::default()
        }
    }

    fn answer(people: Vec<wire::PeopleRosterRow>, due: u32) -> wire::PeopleRoster {
        wire::PeopleRoster {
            count_all: u32::try_from(people.len()).unwrap(),
            count_due: due,
            people,
            owner: Some(wire::PeopleCard {
                party_id: "me".to_owned(),
                name: "Srikanth R".to_owned(),
                role: String::new(),
                days_over: None,
            }),
            ..wire::PeopleRoster::default()
        }
    }

    #[test]
    fn the_roster_is_a_to_z_under_the_name_order_and_flat_under_any_other() {
        let people = vec![
            person("1", "Ada", 0, 0, false),
            person("2", "Émile", 0, 0, false),
            person("3", "Дана", 0, 0, false),
        ];
        let by_name = roster(
            EN,
            &answer(people.clone(), 0),
            K::All,
            wire::PeopleOrder::Name,
        );
        assert!(by_name.rows.is_empty(), "the rows are in the sections");
        assert_eq!(
            by_name
                .sections
                .iter()
                .map(|s| s.key.as_str())
                .collect::<Vec<_>>(),
            ["A", "E", "#"]
        );
        assert_eq!(by_name.index.len(), 27);
        assert!(by_name.empty.is_none());
        let recent = roster(EN, &answer(people, 0), K::All, wire::PeopleOrder::Recent);
        assert!(recent.sections.is_empty() && recent.index.is_empty());
        assert_eq!(
            recent
                .rows
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["Ada", "Émile", "Дана"],
            "the core's order, untouched"
        );
    }

    #[test]
    fn no_one_is_the_day_one_sentence_and_no_index() {
        let data = roster(EN, &answer(Vec::new(), 0), K::All, wire::PeopleOrder::Name);
        assert!(data.sections.is_empty() && data.index.is_empty());
        assert!(data.empty.is_some());
    }

    #[test]
    fn my_card_is_the_owner_under_the_all_filter_alone() {
        let people = vec![person("1", "Ada", 0, 0, false)];
        let all = roster(
            EN,
            &answer(people.clone(), 0),
            K::All,
            wire::PeopleOrder::Name,
        );
        let card = all.my_card.expect("My card");
        assert_eq!(
            (
                card.party_id.as_str(),
                card.name.as_str(),
                card.label.as_str()
            ),
            ("me", "Srikanth R", "My card")
        );
        assert_eq!(card.accessibility_label, "My card, Srikanth R");
        assert_eq!(card.avatar.unwrap().initials, "SR");
        assert_eq!(card.route, Some(routes::person("me", "Srikanth R", false)));
        for chip in [K::Starred, K::Due] {
            let narrowed = roster(
                EN,
                &answer(people.clone(), 0),
                chip,
                wire::PeopleOrder::Name,
            );
            assert!(narrowed.my_card.is_none(), "{chip:?}");
        }
        // No owner, no card; a nameless owner is "Me".
        let mut none = answer(people.clone(), 0);
        none.owner = None;
        assert!(
            roster(EN, &none, K::All, wire::PeopleOrder::Name)
                .my_card
                .is_none()
        );
        let mut nameless = answer(people, 0);
        nameless.owner.as_mut().unwrap().name = "  ".to_owned();
        let card = roster(EN, &nameless, K::All, wire::PeopleOrder::Name)
            .my_card
            .unwrap();
        assert_eq!(card.name, "Me");
    }

    #[test]
    fn the_reconnect_line_names_the_most_overdue_and_counts_the_window() {
        let people = vec![
            person("1", "Ada", 14, 20, true),
            person("2", "Dana Reyes", 14, 40, true),
            person("3", "Mum", 7, 2, false),
        ];
        let line = reconnect(EN, &answer(people.clone(), 3), K::All).expect("a line");
        // 40 - 14 = 26 days over is the most; the count is the core's whole window (3).
        assert_eq!(line.text, "3 to reconnect · Dana Reyes is 26 days over");
        assert_eq!(line.action_label, "Touch");
        assert_eq!(
            line.accessibility_label,
            "3 to reconnect · Dana Reyes is 26 days over. Open Touch"
        );
        // A tie is broken by id, so the line does not flicker between two people.
        let tied = vec![
            person("b", "Bea", 7, 17, true),
            person("a", "Abe", 7, 17, true),
        ];
        assert_eq!(
            reconnect(EN, &answer(tied, 2), K::All).unwrap().text,
            "2 to reconnect · Abe is 10 days over"
        );
        // One day over is singular; nobody overdue is no line; a filter says no name.
        let one = vec![person("1", "Ada", 7, 8, true)];
        assert_eq!(
            reconnect(EN, &answer(one, 1), K::All).unwrap().text,
            "1 to reconnect · Ada is 1 day over"
        );
        assert!(reconnect(EN, &answer(people.clone(), 0), K::All).is_none());
        assert!(reconnect(EN, &answer(people, 3), K::Starred).is_none());
        // A window that holds due people the rows do not name still counts them.
        let line = reconnect(
            EN,
            &answer(vec![person("3", "Mum", 7, 2, false)], 4),
            K::All,
        );
        assert_eq!(line.unwrap().text, "4 to reconnect");
    }
}
