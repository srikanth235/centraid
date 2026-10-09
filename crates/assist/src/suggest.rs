//! SUGGESTED PROMPTS: three questions this vault can answer.
//!
//! An empty thread would be a blank wall, so the chat offers three starting
//! points — and they are real: the names and titles in them are read from the
//! vault's [`World`], the rows the native plane itself reads, so a tap on one
//! asks a question about data that exists. Opened from an app, all three come
//! from that app.
//!
//! Every suggestion is a question the native plane answers by READING (`find`,
//! `search`, `compute`), never one that would write; the date words in them
//! (`today`, `tomorrow`, `this week`) are ones the runtime resolves itself
//! (`native::phrases::dates_line`).
//!
//! Deterministic: the same world gives the same three, in the same order. A row
//! is picked by a stable key (a name, a date, an id), never by the order a
//! table happened to be read in.

use jiff::civil::Date;

use crate::app::App;
use crate::native::door::Door;
use crate::native::meta::Kind;
use crate::native::world::{Row, Standing, Val, World};
use crate::native_turn::civil_at;

/// How many suggestions the chat offers.
pub const SUGGESTIONS: usize = 3;

/// A question to offer, and the app it is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub app: App,
    pub text: String,
}

fn say(app: App, text: impl Into<String>) -> Suggestion {
    Suggestion {
        app,
        text: text.into(),
    }
}

/// The first `count` words of a title, without the punctuation around them:
/// enough to find it again, short enough to say.
fn lead_words(title: &str, count: usize) -> String {
    title
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|word| !word.is_empty())
        .take(count)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether a row's enum field holds `value`, in the model-facing word.
fn is(row: &Row, field: &str, value: &str) -> bool {
    matches!(row.field(field), Some(Val::Enum(held)) if *held == value)
}

/// The rows of a kind that are not in the trash and have a name to say.
fn live(world: &World, kind: Kind) -> impl Iterator<Item = &Row> {
    world
        .of_kind(kind)
        .filter(|row| !row.trashed && !lead_words(&row.name, 1).is_empty())
}

/// A task that still has work in it.
fn unfinished(row: &Row) -> bool {
    is(row, "status", "open") || is(row, "status", "in_progress")
}

/// The row that sorts first by `key`, ties broken by id.
fn first_by<'a, K: Ord>(
    rows: impl Iterator<Item = &'a Row>,
    key: impl Fn(&Row) -> K,
) -> Option<&'a Row> {
    rows.min_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.id.cmp(&b.id)))
}

/// A name to sort by, so "tahoe" and "Tahoe" share one place in the order.
fn by_name(row: &Row) -> String {
    row.name.to_lowercase()
}

/// The newest row first: last edited, then created.
fn newest(row: &Row) -> std::cmp::Reverse<(String, String)> {
    std::cmp::Reverse((row.updated.clone(), row.created.clone()))
}

/// Every candidate for one app: the ones the world's data backs first, then
/// the ones that need none. A world that holds nothing simply offers those.
fn candidates(app: App, world: &World, today: Date) -> Vec<Suggestion> {
    let mut out = Vec::new();
    match app {
        App::Tasks => {
            let tasks = || live(world, Kind::Task).filter(|row| unfinished(row));
            let due = |row: &Row| row.date.map(|stamp| stamp.date);
            if tasks().any(|row| due(row) == Some(today)) {
                out.push(say(app, "What is due today?"));
            }
            if tasks().any(|row| due(row).is_some_and(|day| day < today)) {
                out.push(say(app, "What is overdue?"));
            }
            // A project that still has something in it, else any project.
            let list = first_by(
                live(world, Kind::List)
                    .filter(|list| tasks().any(|task| world.linked(&task.key(), &list.key()))),
                by_name,
            )
            .or_else(|| first_by(live(world, Kind::List), by_name));
            if let Some(list) = list {
                out.push(say(app, format!("What is left in {}?", list.name)));
            }
            out.push(say(app, "What is due today?"));
            out.push(say(app, "What is coming up?"));
            out.push(say(app, "What is overdue?"));
        }
        App::Agenda => {
            let week_end = today.saturating_add(jiff::Span::new().days(6));
            let coming = || {
                live(world, Kind::Event).filter(move |row| {
                    !is(row, "status", "cancelled")
                        && row
                            .date
                            .is_some_and(|stamp| stamp.date >= today && stamp.date <= week_end)
                })
            };
            if coming().next().is_some() {
                out.push(say(app, "What is on my calendar this week?"));
            }
            if let Some(event) = first_by(coming(), |row| row.date) {
                out.push(say(app, format!("When is {}?", lead_words(&event.name, 3))));
            }
            out.push(say(app, "What is on my calendar this week?"));
            out.push(say(app, "What is on tomorrow?"));
            out.push(say(app, "What is on today?"));
        }
        App::People => {
            let me = world.me_key();
            let others = || live(world, Kind::Person).filter(|row| row.key() != me);
            if let Some(person) = first_by(others(), |row| (!row.starred(), by_name(row))) {
                out.push(say(
                    app,
                    format!("What do I know about {}?", lead_words(&person.name, 2)),
                ));
            }
            out.push(say(app, "Who is in my circle?"));
            out.push(say(app, "Who did I talk to lately?"));
            out.push(say(app, "Who have I starred?"));
        }
        App::Tally => {
            let open = |direction: &'static str| {
                live(world, Kind::Debt)
                    .filter(move |row| is(row, "status", "open") && is(row, "direction", direction))
            };
            if open("owes_me").next().is_some() {
                out.push(say(app, "Who owes me money?"));
            }
            if open("i_owe").next().is_some() {
                out.push(say(app, "What do I owe?"));
            }
            // Someone a debt is still open with: the balance with them is a number
            // the runtime computes.
            let person = first_by(
                live(world, Kind::Person).filter(|person| {
                    live(world, Kind::Debt).any(|debt| {
                        is(debt, "status", "open") && world.linked(&debt.key(), &person.key())
                    })
                }),
                by_name,
            );
            if let Some(person) = person {
                out.push(say(
                    app,
                    format!("What is my balance with {}?", lead_words(&person.name, 2)),
                ));
            }
            out.push(say(app, "Who owes me money?"));
            out.push(say(app, "What do I owe?"));
            out.push(say(app, "Which groups am I in?"));
        }
        App::Photos => {
            if let Some(photo) = first_by(live(world, Kind::Photo), newest) {
                out.push(say(
                    app,
                    format!("Find photos of {}", lead_words(&photo.name, 2)),
                ));
            }
            out.push(say(app, "Show my newest photos"));
            out.push(say(app, "What albums do I have?"));
            out.push(say(app, "Which photos are starred?"));
        }
        App::Notes => {
            if let Some(note) = first_by(live(world, Kind::Note), newest) {
                out.push(say(
                    app,
                    format!("Find my note on {}", lead_words(&note.name, 3)),
                ));
            }
            out.push(say(app, "What notes did I write lately?"));
            out.push(say(app, "What notebooks do I have?"));
            out.push(say(app, "Which notes are starred?"));
        }
        App::Docs => {
            if let Some(doc) = first_by(live(world, Kind::Document), newest) {
                out.push(say(app, format!("Find the {}", lead_words(&doc.name, 3))));
            }
            out.push(say(app, "What documents changed lately?"));
            out.push(say(app, "What folders do I have?"));
            out.push(say(app, "Which documents are starred?"));
        }
    }
    out
}

/// The apps an unscoped chat draws from, in the order it tries them.
const OPENING_ORDER: [App; 7] = [
    App::Tasks,
    App::Agenda,
    App::Tally,
    App::People,
    App::Photos,
    App::Notes,
    App::Docs,
];

fn push_new(out: &mut Vec<Suggestion>, suggestion: Suggestion) {
    if out.len() < SUGGESTIONS && out.iter().all(|held| held.text != suggestion.text) {
        out.push(suggestion);
    }
}

/// Three suggestions from `world`, whose today is `today`: from `scope` when
/// there is one, otherwise one each from the first apps in [`OPENING_ORDER`]
/// that hold something.
#[must_use]
pub fn suggest_in(world: &World, today: Date, scope: Option<App>) -> Vec<Suggestion> {
    let mut out = Vec::new();
    match scope {
        Some(app) => {
            for suggestion in candidates(app, world, today) {
                push_new(&mut out, suggestion);
            }
        }
        None => {
            // One from each app first, so the three differ; then whatever is
            // left of each app's list fills any gap.
            let per_app: Vec<Vec<Suggestion>> = OPENING_ORDER
                .iter()
                .map(|app| candidates(*app, world, today))
                .collect();
            for candidates in &per_app {
                if let Some(first) = candidates.first() {
                    push_new(&mut out, first.clone());
                }
            }
            for candidates in &per_app {
                for suggestion in candidates.iter().skip(1) {
                    push_new(&mut out, suggestion.clone());
                }
            }
        }
    }
    out
}

/// Three suggestions from the vault behind `door`, for a member whose zone is
/// `tz`. A vault the door cannot read offers the questions that need no data:
/// suggesting never fails the chat.
#[must_use]
pub fn suggest(door: &dyn Door, tz: &str, scope: Option<App>) -> Vec<Suggestion> {
    let today = civil_at(door.now_ms(), tz).date();
    let standing = Standing {
        today,
        tz: tz.to_owned(),
    };
    // The Locker is off on the phone (R-1088-3): its rows are never read, so no
    // suggestion can name one.
    let world = World::load_in(door, false, Some(&standing)).unwrap_or_default();
    suggest_in(&world, today, scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::dates::Stamp;
    use crate::native::meta::Via;
    use crate::native::world::Edge;
    use std::collections::BTreeMap;

    const TODAY: Date = jiff::civil::date(2026, 10, 8);

    fn row(kind: Kind, id: &str, name: &str) -> Row {
        Row {
            kind,
            id: id.to_owned(),
            name: name.to_owned(),
            date: None,
            fields: BTreeMap::new(),
            trashed: false,
            created: "2026-01-01".to_owned(),
            updated: "2026-01-01".to_owned(),
            extra: BTreeMap::new(),
        }
    }

    fn on(mut row: Row, day: &str) -> Row {
        row.date = Stamp::parse(day);
        row
    }

    fn with(mut row: Row, field: &'static str, value: &'static str) -> Row {
        row.fields.insert(field, Val::Enum(value));
        row
    }

    fn world(rows: impl IntoIterator<Item = Row>) -> World {
        let mut world = World {
            me: "me".to_owned(),
            ..World::default()
        };
        for row in rows {
            world.rows.insert(row.key(), row);
        }
        world
    }

    fn texts(suggestions: &[Suggestion]) -> Vec<&str> {
        suggestions.iter().map(|s| s.text.as_str()).collect()
    }

    fn open_task(id: &str, name: &str, day: &str) -> Row {
        with(on(row(Kind::Task, id, name), day), "status", "open")
    }

    fn open_debt(id: &str, direction: &'static str) -> Row {
        with(
            with(row(Kind::Debt, id, "Dinner"), "status", "open"),
            "direction",
            direction,
        )
    }

    #[test]
    fn a_scoped_chat_offers_three_questions_from_that_app_using_its_own_rows() {
        let w = world([
            open_task("t1", "Pick up the dry cleaning", "2026-10-08"),
            open_task("t2", "Rotate the tires", "2026-10-01"),
            row(Kind::List, "l1", "Tahoe trip"),
        ]);
        let got = suggest_in(&w, TODAY, Some(App::Tasks));
        assert_eq!(
            texts(&got),
            [
                "What is due today?",
                "What is overdue?",
                "What is left in Tahoe trip?"
            ]
        );
        assert!(got.iter().all(|s| s.app == App::Tasks));
    }

    #[test]
    fn a_task_that_is_done_or_gone_backs_no_question() {
        let done = with(
            on(row(Kind::Task, "t1", "Done"), "2026-10-08"),
            "status",
            "completed",
        );
        let mut trashed = open_task("t2", "Trashed", "2026-10-01");
        trashed.trashed = true;
        // Nothing backs "today" or "overdue", so the order is the dataless one.
        let got = suggest_in(&world([done, trashed]), TODAY, Some(App::Tasks));
        assert_eq!(
            texts(&got),
            [
                "What is due today?",
                "What is coming up?",
                "What is overdue?"
            ]
        );
    }

    #[test]
    fn an_empty_app_still_offers_three_questions_that_need_no_data() {
        let w = world([]);
        for app in App::ALL {
            let got = suggest_in(&w, TODAY, Some(app));
            assert_eq!(got.len(), SUGGESTIONS, "{app:?}");
            assert!(got.iter().all(|s| s.app == app), "{app:?}");
        }
        assert_eq!(
            texts(&suggest_in(&w, TODAY, Some(App::Tally))),
            [
                "Who owes me money?",
                "What do I owe?",
                "Which groups am I in?"
            ]
        );
    }

    #[test]
    fn a_debt_backs_the_questions_about_it_and_the_balance_with_its_person() {
        let mut w = world([
            row(Kind::Person, "p1", "Sam Rivera"),
            open_debt("d1", "owes_me"),
        ]);
        w.edges.push(Edge {
            from: (Kind::Debt, "d1".to_owned()),
            to: (Kind::Person, "p1".to_owned()),
            via: Via::Counterparty,
            link_id: None,
        });
        assert_eq!(
            texts(&suggest_in(&w, TODAY, Some(App::Tally))),
            [
                "Who owes me money?",
                "What is my balance with Sam Rivera?",
                "What do I owe?"
            ]
        );
    }

    #[test]
    fn an_unscoped_chat_takes_one_from_each_of_the_first_apps_that_have_data() {
        let w = world([
            open_task("t1", "Book dentist appointment", "2026-10-08"),
            on(
                row(Kind::Event, "e1", "Dinner with Maya"),
                "2026-10-10T19:00:00",
            ),
            open_debt("d1", "owes_me"),
        ]);
        let got = suggest_in(&w, TODAY, None);
        assert_eq!(
            texts(&got),
            [
                "What is due today?",
                "What is on my calendar this week?",
                "Who owes me money?"
            ]
        );
        let apps: Vec<App> = got.iter().map(|s| s.app).collect();
        assert_eq!(apps, [App::Tasks, App::Agenda, App::Tally]);
    }

    #[test]
    fn an_empty_vault_is_offered_the_dataless_questions_without_repeats() {
        let got = suggest_in(&world([]), TODAY, None);
        assert_eq!(got.len(), SUGGESTIONS);
        let mut seen: Vec<&str> = texts(&got);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), SUGGESTIONS);
    }

    #[test]
    fn titles_become_search_terms_by_their_first_words() {
        assert_eq!(
            lead_words("Tahoe long weekend — shortlist", 3),
            "Tahoe long weekend"
        );
        assert_eq!(lead_words("  “Quoted” title!  ", 2), "Quoted title");
        assert_eq!(lead_words("—", 3), "");
        let w = world([row(Kind::Note, "n1", "Tahoe long weekend — shortlist")]);
        let got = suggest_in(&w, TODAY, Some(App::Notes));
        assert_eq!(got[0].text, "Find my note on Tahoe long weekend");
    }

    #[test]
    fn the_newest_row_names_the_search_and_a_tie_goes_to_the_lower_id() {
        let mut old = row(Kind::Note, "n1", "Older note");
        old.updated = "2026-02-01".to_owned();
        let mut new_b = row(Kind::Note, "n3", "Newer b");
        new_b.updated = "2026-09-01".to_owned();
        let mut new_a = row(Kind::Note, "n2", "Newer a");
        new_a.updated = "2026-09-01".to_owned();
        let got = suggest_in(&world([old, new_b, new_a]), TODAY, Some(App::Notes));
        assert_eq!(got[0].text, "Find my note on Newer a");
    }

    #[test]
    fn the_same_world_gives_the_same_suggestions_whatever_order_it_was_built_in() {
        let rows = || {
            vec![
                open_task("t1", "A", "2026-10-08"),
                open_task("t2", "B", "2026-10-01"),
                row(Kind::List, "l2", "Zeta"),
                row(Kind::List, "l1", "alpha"),
                row(Kind::Person, "p1", "Sam"),
            ]
        };
        let forward = world(rows());
        let mut reversed = rows();
        reversed.reverse();
        let backward = world(reversed);
        for scope in std::iter::once(None).chain(App::ALL.into_iter().map(Some)) {
            assert_eq!(
                suggest_in(&forward, TODAY, scope),
                suggest_in(&backward, TODAY, scope),
                "{scope:?}"
            );
        }
        // "alpha" sorts before "Zeta" whatever the case, and neither list holds a task.
        let tasks = suggest_in(&forward, TODAY, Some(App::Tasks));
        assert!(texts(&tasks).contains(&"What is left in alpha?"));
    }

    #[test]
    fn the_member_is_not_offered_as_someone_they_know() {
        let me = row(Kind::Person, "me", "Me Myself");
        let sam = row(Kind::Person, "p1", "Sam");
        let got = suggest_in(&world([me, sam]), TODAY, Some(App::People));
        assert_eq!(got[0].text, "What do I know about Sam?");
    }

    #[test]
    fn only_this_weeks_live_events_back_the_calendar_questions() {
        let far = on(row(Kind::Event, "e1", "Far away"), "2026-12-01T09:00:00");
        let cancelled = with(
            on(row(Kind::Event, "e2", "Cancelled"), "2026-10-09T09:00:00"),
            "status",
            "cancelled",
        );
        let got = suggest_in(&world([far, cancelled]), TODAY, Some(App::Agenda));
        assert!(!texts(&got).iter().any(|text| text.starts_with("When is")));
        let near = on(
            row(Kind::Event, "e3", "Dentist, 2nd floor"),
            "2026-10-09T09:00:00",
        );
        let got = suggest_in(&world([near]), TODAY, Some(App::Agenda));
        assert_eq!(
            texts(&got),
            [
                "What is on my calendar this week?",
                "When is Dentist 2nd floor?",
                "What is on tomorrow?"
            ]
        );
    }

    #[test]
    fn every_date_word_a_suggestion_says_is_one_the_runtime_resolves() {
        use crate::native::phrases::dates_line;
        let now = TODAY.at(9, 0, 0, 0);
        let mut said = 0;
        for app in App::ALL {
            for suggestion in suggest_in(&world([]), TODAY, Some(app)) {
                let text = &suggestion.text;
                if ["today", "tomorrow", "this week"]
                    .iter()
                    .any(|word| text.contains(word))
                {
                    said += 1;
                    assert!(
                        dates_line(text, now).is_some(),
                        "the runtime does not resolve a date in {text:?}"
                    );
                }
            }
        }
        assert!(said >= 3, "the test reads the date words it means to");
    }
}
