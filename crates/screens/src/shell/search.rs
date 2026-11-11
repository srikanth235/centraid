//! HOME'S SEARCH (#1135): one term asked of the whole vault through the shell's
//! named query `search`, drawn as one group per app. It is the same search
//! Notes' link picker runs; there is no second engine behind it, and an app's own
//! search stays that app's.
//!
//! ## What the core answers, and what is decided here
//!
//! The core answers hits: an entity, an id, a title and the app each opens in.
//! This screen groups them by app in the springboard's order, words each row
//! (its kind, its spoken label), picks where a tap goes ([`row_routes`]) and
//! separates the containers that matched (a notebook, an album, a project, a
//! folder) from the plain rows. A hit with no page to open (a chat thread, until
//! the chat registers one) is not offered: a row that cannot be opened is a
//! control that lies.
//!
//! The Ask row under an answer hands the term to the assistant by a route, scoped
//! to every app (Home's search asks across all of them).
//!
//! ## Recent
//!
//! The last four terms the member acted on are the resting page's suggestions,
//! held for as long as the screen is open.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::home_search_event::Kind as S;
use wire::screen_event::Kind as E;

use super::policy;
use super::routes;
use super::row_routes::{self, RowRef};
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::kit::search as ask;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, home as words, shared};

/// How many recent terms are kept.
pub const RECENT_MAX: usize = 4;

enum Phase {
    /// No term: the resting page.
    Resting,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready(wire::VaultSearch),
}

struct Search {
    term: String,
    recent: Vec<String>,
    phase: Phase,
    /// The one app this search answers for (`health.search`), or none for Home's.
    scope: Option<&'static str>,
}

/// The registry factory for Home's search.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Search::over(None)))
}

/// The registry factory for Health's search page (#1173, item 11): the same search with the
/// Health group alone, and the metrics found by name.
#[must_use]
pub fn build_health(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Search::over(Some("health"))))
}

/// The month a word names (`nov`, `November`), 1 to 12.
fn month_of(word: &str) -> Option<u32> {
    const NAMES: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    let word = word.trim_end_matches(['.', ',']).to_lowercase();
    if word.len() < 3 {
        return None;
    }
    NAMES
        .iter()
        .position(|name| name.starts_with(word.as_str()))
        .and_then(|at| u32::try_from(at + 1).ok())
}

/// A date a term names, as `(month, day)` with either unknown: `2026-03-04`, `4 March`,
/// `March 4`, `march`. A workout is found by its date when its local day matches every part
/// that is known.
fn date_of(term: &str) -> Option<(Option<u32>, Option<u32>, Option<u32>)> {
    let words: Vec<&str> = term.split_whitespace().collect();
    if let [one] = words.as_slice()
        && let Some((year, rest)) = one.split_once('-')
        && let Some((month, day)) = rest.split_once('-')
    {
        return Some((year.parse().ok(), month.parse().ok(), day.parse().ok()));
    }
    let (mut month, mut day, mut year) = (None, None, None);
    for word in &words {
        if let Some(m) = month_of(word) {
            month = Some(m);
        } else if let Ok(n) = word
            .trim_end_matches(['.', ',', 's', 't', 'n', 'd', 'r', 'h'])
            .parse::<u32>()
        {
            if n > 31 {
                year = Some(n);
            } else {
                day = Some(n);
            }
        } else {
            return None;
        }
    }
    (month.is_some()).then_some((year, month, day))
}

/// The workouts whose local day is the date `term` names (Health's page only).
fn date_hits(ctx: &Ctx, term: &str) -> Vec<wire::VaultSearchHit> {
    let Some((year, month, day)) = date_of(term) else {
        return Vec::new();
    };
    let Reading::Data(workouts) = read::read(
        ctx,
        load::health::Workouts {
            limit: 200,
            after: None,
            kind_concept_id: None,
        },
        |answer| match answer {
            Answer::HealthWorkouts(workouts) => Some(workouts),
            _ => None,
        },
    ) else {
        return Vec::new();
    };
    workouts
        .workouts
        .into_iter()
        .filter(|workout| {
            let mut parts = workout.local_start.get(..10).unwrap_or_default().split('-');
            let (y, m, d): (Option<u32>, Option<u32>, Option<u32>) = (
                parts.next().and_then(|p| p.parse().ok()),
                parts.next().and_then(|p| p.parse().ok()),
                parts.next().and_then(|p| p.parse().ok()),
            );
            year.is_none_or(|want| Some(want) == y)
                && month.is_none_or(|want| Some(want) == m)
                && day.is_none_or(|want| Some(want) == d)
        })
        .map(|workout| wire::VaultSearchHit {
            app_id: "health".to_owned(),
            entity: "workout".to_owned(),
            id: workout.activity_id,
            title: workout.kind_label,
            ..wire::VaultSearchHit::default()
        })
        .collect()
}

/// The metrics whose name holds every word of `term`, as hits that open that metric.
fn metric_hits(locale: Locale, term: &str) -> Vec<wire::VaultSearchHit> {
    let words: Vec<String> = term.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    crate::health::Metric::ALL
        .iter()
        .filter_map(|metric| {
            let label = crate::health::figures::label(locale, *metric);
            let folded = label.to_lowercase();
            words
                .iter()
                .all(|word| folded.contains(word.as_str()))
                .then(|| wire::VaultSearchHit {
                    app_id: "health".to_owned(),
                    entity: "metric".to_owned(),
                    id: metric.key().to_owned(),
                    title: label,
                    ..wire::VaultSearchHit::default()
                })
        })
        .collect()
}

impl Search {
    fn over(scope: Option<&'static str>) -> Self {
        Self {
            term: String::new(),
            recent: Vec::new(),
            phase: Phase::Resting,
            scope,
        }
    }

    fn asked(&self) -> &str {
        self.term.trim()
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.asked().is_empty() {
            self.phase = Phase::Resting;
            return;
        }
        self.phase = match read::read(
            ctx,
            load::shell::Search {
                term: self.asked().to_owned(),
            },
            |answer| match answer {
                Answer::VaultSearch(found) => Some(found),
                _ => None,
            },
        ) {
            Reading::Data(mut found) => {
                // A metric is found by its name, which no index holds: Health's group lists it
                // first (it is what the name asks for), then the workouts the index found.
                let mut hits = metric_hits(ctx.locale(), self.asked());
                if self.scope.is_some() {
                    // A workout is also found by its date, which the index does not hold.
                    for dated in date_hits(ctx, self.asked()) {
                        if !found.hits.iter().any(|hit| hit.id == dated.id) {
                            hits.push(dated);
                        }
                    }
                }
                hits.append(&mut found.hits);
                found.hits = hits;
                if let Some(scope) = self.scope {
                    found.hits.retain(|hit| hit.app_id == scope);
                }
                Phase::Ready(found)
            }
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
    }

    fn set_term(&mut self, term: String, ctx: &Ctx) {
        if self.term == term && !matches!(self.phase, Phase::Resting) {
            return;
        }
        self.term = term;
        self.reload(ctx);
    }

    /// Remember the term the member acted on, newest first, once.
    fn commit(&mut self) {
        let asked = self.asked().to_owned();
        if asked.is_empty() {
            return;
        }
        self.recent.retain(|kept| {
            !kept.eq_ignore_ascii_case(&asked) && kept.to_lowercase() != asked.to_lowercase()
        });
        self.recent.insert(0, asked);
        self.recent.truncate(RECENT_MAX);
    }
}

impl Screen for Search {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => self.phase = Phase::Resting,
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::HomeSearch(search)) => match search.kind {
                Some(S::Term(typed)) => self.set_term(typed.term, ctx),
                Some(S::Suggestion(picked)) => self.set_term(picked.term, ctx),
                Some(S::Committed(_)) => self.commit(),
                Some(S::Cleared(_)) => {
                    self.term.clear();
                    self.phase = Phase::Resting;
                }
                Some(S::Refreshed(_)) => self.reload(ctx),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::home_search_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Resting => Content::Resting(wire::HomeSearchResting {
                note: words::home_search_note(locale),
                suggestions_label: if self.recent.is_empty() {
                    String::new()
                } else {
                    words::home_search_recent_label(locale)
                },
                suggestions: self.recent.clone(),
            }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(denied(locale, denial)),
            Phase::Ready(found) => Content::Data(Box::new(fold(locale, self.asked(), found))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::HomeSearch(Box::new(
                wire::HomeSearchState {
                    chrome: Some(chrome(locale, self.scope)),
                    term: self.term.clone(),
                    content: Some(content),
                    recent: self.recent.clone(),
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}

fn chrome(locale: Locale, scope: Option<&str>) -> wire::HomeSearchChrome {
    wire::HomeSearchChrome {
        placeholder: match scope {
            Some("health") => words::health_search_placeholder(locale),
            _ => words::home_search_placeholder(locale),
        },
        scope_label: match scope {
            Some(app) => app_label(locale, app),
            None => words::home_search_scope_label(locale),
        },
        cancel: shared::kit_cancel(locale),
        close_label: shared::kit_close_search(locale),
        loading: words::home_search_loading(locale),
        retry: shared::kit_retry(locale),
        title: shared::kit_search(locale),
    }
}

/// The vault would not let the search read: the kit's gate, with the refusal's
/// own code as the receipt.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::vault_denied_title(locale),
        body: String::new(),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// The kind a row is, in a word; empty for an entity this search has no word for.
fn kind_label(locale: Locale, entity: &str) -> String {
    match entity {
        "note" => words::search_kind_note(locale),
        "person" => words::search_kind_person(locale),
        "event" => words::search_kind_event(locale),
        "task" => words::search_kind_task(locale),
        "photo" => words::search_kind_photo(locale),
        "document" => words::search_kind_document(locale),
        "locker_item" => words::search_kind_locker_item(locale),
        "thread" => words::search_kind_chat(locale),
        "transaction" => words::search_kind_transaction(locale),
        "workout" => words::search_kind_workout(locale),
        "metric" => words::search_kind_metric(locale),
        _ => String::new(),
    }
}

/// A container the index names: what it is, its mark, and the app it opens in.
fn container_kind(locale: Locale, entity: &str, app: &str) -> Option<(String, &'static str)> {
    Some(match (entity, app) {
        ("notebook", "notes") => (shared::search_kind_notebook(locale), "Book"),
        ("album", "photos") => (shared::search_kind_album(locale), "Image"),
        ("project", "reminders") => (shared::search_kind_project(locale), "List"),
        ("folder", "docs") => (shared::search_kind_folder(locale), "Folder"),
        _ => return None,
    })
}

fn spoken(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.trim().is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(", ")
}

fn app_label(locale: Locale, app: &str) -> String {
    match app {
        "calendar" => words::app_calendar(locale),
        "reminders" => words::app_reminders(locale),
        "docs" => words::app_docs(locale),
        "health" => words::app_health(locale),
        "locker" => words::app_locker(locale),
        "money" => words::app_money(locale),
        "notes" => words::app_notes(locale),
        "people" => words::app_people(locale),
        "photos" => words::app_photos(locale),
        "chat" => words::home_search_chat_group(locale),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

/// The hits as groups: one per app in the springboard's order (an app the
/// springboard does not know goes last), each with its containers apart from its
/// plain rows.
fn fold(locale: Locale, term: &str, found: &wire::VaultSearch) -> wire::HomeSearchData {
    let mut apps: Vec<&str> = Vec::new();
    for hit in found
        .hits
        .iter()
        .filter(|hit| !hit.app_id.trim().is_empty())
    {
        if !apps.contains(&hit.app_id.as_str()) {
            apps.push(hit.app_id.as_str());
        }
    }
    apps.sort_by_key(|app| {
        policy::ORDER
            .iter()
            .position(|known| known == app)
            .unwrap_or(policy::ORDER.len())
    });
    let photos_among: Vec<RowRef> = found
        .hits
        .iter()
        .filter(|hit| hit.app_id == "photos" && hit.entity == "photo")
        .map(|hit| RowRef::new("photos", "photo", opens(hit), &hit.title))
        .collect();
    let groups: Vec<wire::HomeSearchGroup> = apps
        .into_iter()
        .filter_map(|app| {
            let mut containers = Vec::new();
            let mut rows = Vec::new();
            for hit in found.hits.iter().filter(|hit| hit.app_id == app) {
                if let Some((kind, icon)) = container_kind(locale, &hit.entity, app) {
                    let route = row_routes::route(
                        &RowRef::new(app, &hit.entity, &hit.id, &hit.title),
                        "",
                        &[],
                    );
                    containers.push(wire::SearchContainer {
                        entity: hit.entity.clone(),
                        id: hit.id.clone(),
                        app_id: app.to_owned(),
                        accessibility_label: spoken(&[&kind, &hit.title]),
                        kind_label: kind,
                        title: hit.title.clone(),
                        icon_key: icon.to_owned(),
                        route,
                    });
                    continue;
                }
                let kind = kind_label(locale, &hit.entity);
                // WORDS ONLY AN EARLIER VERSION HELD: the row says so and opens that item's
                // Earlier versions, which is where the words can be read (#1185).
                let earlier = hit
                    .in_earlier_version
                    .then(|| row_routes::earlier(locale, app, &hit.entity, opens(hit)))
                    .flatten();
                let earlier_label = if earlier.is_some() {
                    ask::in_earlier_version(locale)
                } else {
                    String::new()
                };
                let route = earlier.or_else(|| {
                    row_routes::route(
                        &RowRef::new(app, &hit.entity, opens(hit), &hit.title),
                        "",
                        &photos_among,
                    )
                });
                // A row with no page to open is not offered.
                if route.is_none() {
                    continue;
                }
                rows.push(wire::HomeSearchRow {
                    entity: hit.entity.clone(),
                    id: hit.id.clone(),
                    app_id: app.to_owned(),
                    accessibility_label: spoken(&[&kind, &hit.title, &earlier_label]),
                    kind_label: kind,
                    title: hit.title.clone(),
                    route,
                    earlier_label,
                });
            }
            let count = containers.len() + rows.len();
            if count == 0 {
                return None;
            }
            let label = app_label(locale, app);
            let template = if count == 1 {
                words::home_search_group_one(locale)
            } else {
                words::home_search_group(locale)
            };
            Some(wire::HomeSearchGroup {
                app_id: app.to_owned(),
                accessibility_label: fill(
                    &template,
                    &[("name", &label), ("n", &count.to_string())],
                ),
                label,
                count: u32::try_from(count).unwrap_or(u32::MAX),
                rows,
                containers,
            })
        })
        .collect();
    let empty = groups.is_empty().then(|| wire::EmptyState {
        headline: words::home_search_no_match_headline(locale),
        body: fill(&words::home_search_no_match_body(locale), &[("term", term)]),
        ..Default::default()
    });
    let offer = ask::offer(locale, term, "");
    wire::HomeSearchData {
        groups,
        empty,
        corrected: if found.corrected.is_empty() {
            String::new()
        } else {
            ask::corrected(locale, &found.corrected)
        },
        ask_route: Some(routes::ask(&offer.question, &offer.scope)),
        ask: Some(offer),
    }
}

/// What a hit opens by: the asset for a photograph, otherwise its own id.
fn opens(hit: &wire::VaultSearchHit) -> &str {
    if hit.open_id.trim().is_empty() {
        &hit.id
    } else {
        &hit.open_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(entity: &str, id: &str, title: &str, app: &str) -> wire::VaultSearchHit {
        wire::VaultSearchHit {
            entity: entity.to_owned(),
            id: id.to_owned(),
            title: title.to_owned(),
            app_id: app.to_owned(),
            ..Default::default()
        }
    }

    fn found(hits: Vec<wire::VaultSearchHit>) -> wire::VaultSearch {
        wire::VaultSearch {
            hits,
            corrected: String::new(),
        }
    }

    fn data(hits: Vec<wire::VaultSearchHit>) -> wire::HomeSearchData {
        fold(Locale::En, "cabin", &found(hits))
    }

    #[test]
    fn the_hits_are_grouped_by_app_in_homes_tile_order_each_counted_each_row_named_by_its_kind() {
        let answer = data(vec![
            hit("person", "p1", "Maya", "people"),
            hit("note", "n1", "Cabin list", "notes"),
            hit("task", "t1", "Book the cabin", "reminders"),
            hit("event", "e1", "Cabin weekend", "calendar"),
            hit("document", "d1", "Lease", "docs"),
        ]);
        let groups: Vec<(&str, u32)> = answer
            .groups
            .iter()
            .map(|group| (group.app_id.as_str(), group.count))
            .collect();
        assert_eq!(
            groups,
            [
                ("docs", 1),
                ("calendar", 1),
                ("reminders", 1),
                ("notes", 1),
                ("people", 1)
            ]
        );
        let calendar = &answer.groups[1];
        assert_eq!(calendar.label, "Calendar");
        assert_eq!(calendar.accessibility_label, "Calendar, 1 result");
        assert_eq!(answer.groups[0].accessibility_label, "Docs, 1 result");
        assert_eq!(calendar.rows[0].kind_label, "Event");
        let reminders = &answer.groups[2];
        assert_eq!(reminders.label, "Reminders");
        assert_eq!(reminders.rows[0].kind_label, "Task");
        assert_eq!(
            reminders.rows[0].accessibility_label,
            "Task, Book the cabin"
        );
    }

    /// A HIT ON WORDS ONLY AN EARLIER VERSION HELD says so in the row's own line and opens that
    /// item's Earlier versions, in every app that has such a page (#1185); a hit on what the
    /// item says now is the ordinary row.
    #[test]
    fn a_hit_found_only_in_an_earlier_version_says_so_and_opens_earlier_versions() {
        let earlier = |entity: &str, id: &str, app: &str| wire::VaultSearchHit {
            in_earlier_version: true,
            ..hit(entity, id, "Old", app)
        };
        let answer = data(vec![
            earlier("note", "n1", "notes"),
            earlier("task", "t1", "reminders"),
            earlier("event", "e1", "calendar"),
            earlier("person", "p1", "people"),
            earlier("document", "d1", "docs"),
            earlier("transaction", "x1", "money"),
            earlier("photo", "ph1", "photos"),
            hit("note", "n2", "Now", "notes"),
        ]);
        let screen_of = |app: &str, id: &str| {
            let group = answer
                .groups
                .iter()
                .find(|group| group.app_id == app)
                .expect("the group");
            let row = group.rows.iter().find(|row| row.id == id).expect("the row");
            (
                row.earlier_label.clone(),
                row.route.as_ref().map(|route| route.screen.clone()),
                row.route.as_ref().and_then(|route| match &route.args {
                    Some(wire::route::Args::Earlier(args)) => Some(args.entity_id.clone()),
                    _ => None,
                }),
                row.accessibility_label.clone(),
            )
        };
        for (app, id, screen) in [
            ("notes", "n1", crate::notes::EARLIER),
            ("reminders", "t1", crate::reminders::EARLIER),
            ("calendar", "e1", crate::calendar::EARLIER),
            ("people", "p1", crate::people::EARLIER),
            ("docs", "d1", crate::docs::EARLIER),
            ("money", "x1", crate::money::EARLIER),
            ("photos", "ph1", crate::photos::EARLIER),
        ] {
            let (label, route, entity, spoken) = screen_of(app, id);
            assert_eq!(label, "In an earlier version", "{app}");
            assert_eq!(route.as_deref(), Some(screen), "{app}");
            assert_eq!(entity.as_deref(), Some(id), "{app}");
            assert!(spoken.ends_with("In an earlier version"), "{spoken}");
        }
        let (label, route, _, _) = screen_of("notes", "n2");
        assert!(label.is_empty());
        assert_eq!(route.as_deref(), Some(crate::notes::EDITOR));
    }

    #[test]
    fn a_locker_item_is_a_hit_in_lockers_group_naming_its_kind_and_opening_the_item() {
        let answer = data(vec![hit("locker_item", "i1", "Bank login", "locker")]);
        let group = &answer.groups[0];
        assert_eq!(
            (group.app_id.as_str(), group.label.as_str()),
            ("locker", "Locker")
        );
        let row = &group.rows[0];
        assert_eq!(row.kind_label, "Locker item");
        let route = row.route.as_ref().expect("opens the item");
        assert_eq!(route.screen, crate::locker::ITEM);
    }

    #[test]
    fn a_container_that_matched_is_apart_from_the_plain_rows_and_opens_its_own_page() {
        let answer = data(vec![
            hit("notebook", "nb1", "Cabin", "notes"),
            hit("note", "n1", "Cabin list", "notes"),
        ]);
        let group = &answer.groups[0];
        assert_eq!(group.count, 2);
        assert_eq!(group.rows.len(), 1);
        let container = &group.containers[0];
        assert_eq!(
            (container.kind_label.as_str(), container.icon_key.as_str()),
            ("Notebook", "Book")
        );
        assert_eq!(container.accessibility_label, "Notebook, Cabin");
        assert_eq!(
            container.route.as_ref().map(|route| route.screen.as_str()),
            Some(crate::notes::HOME)
        );
    }

    #[test]
    fn a_hit_with_no_page_to_open_is_not_offered_and_does_not_count() {
        let answer = data(vec![
            hit("thing", "c1", "Cabin planning", "nowhere"),
            hit("note", "n1", "Cabin list", "notes"),
        ]);
        assert_eq!(answer.groups.len(), 1);
        assert_eq!(answer.groups[0].app_id, "notes");
        let only = data(vec![hit("thing", "c1", "Cabin planning", "nowhere")]);
        assert!(only.groups.is_empty());
        assert_eq!(only.empty.unwrap().headline, "No matches");
    }

    #[test]
    fn a_conversation_opens_as_a_chat_page() {
        let answer = data(vec![hit("thread", "c1", "Cabin planning", "chat")]);
        assert_eq!(answer.groups.len(), 1);
        assert_eq!(answer.groups[0].app_id, "chat");
        assert_eq!(
            answer.groups[0].rows[0]
                .route
                .as_ref()
                .map(|route| route.screen.as_str()),
            Some(crate::chat::THREAD)
        );
    }

    #[test]
    fn a_photograph_opens_by_the_asset_the_hit_names() {
        let mut photo = hit("photo", "content-item", "Bay", "photos");
        photo.open_id = "asset-1".to_owned();
        let answer = data(vec![photo]);
        let Some(wire::route::Args::PhotosLightbox(lightbox)) = answer.groups[0].rows[0]
            .route
            .as_ref()
            .and_then(|route| route.args.clone())
        else {
            panic!("not a lightbox");
        };
        assert_eq!(lightbox.photo_id, "asset-1");
    }

    #[test]
    fn the_words_the_core_corrected_are_said_once_and_an_exact_answer_says_nothing() {
        let mut answer = found(vec![hit("note", "n1", "Cabin list", "notes")]);
        assert!(fold(Locale::En, "cabn", &answer).corrected.is_empty());
        answer.corrected = "cabin".to_owned();
        assert_eq!(
            fold(Locale::En, "cabn", &answer).corrected,
            "Including results for “cabin”"
        );
    }

    #[test]
    fn every_answer_offers_one_unscoped_ask_that_hands_the_term_to_the_assistant() {
        let answer = data(vec![]);
        let ask = answer.ask.expect("an ask");
        assert_eq!(ask.scope, "");
        assert_eq!(ask.question, "Find cabin");
        assert_eq!(answer.ask_route, Some(super::routes::ask("Find cabin", "")));
        assert_eq!(
            answer.empty.expect("an empty state").body,
            "Nothing in this vault matches “cabin”."
        );
    }

    #[test]
    fn an_app_the_springboard_does_not_know_goes_last_under_a_capitalised_name() {
        let answer = data(vec![
            hit("thing", "x", "Odd", "weather"),
            hit("note", "n1", "Cabin list", "notes"),
        ]);
        // `weather` has no page, so it is not offered; with one it would sort last.
        assert_eq!(
            answer
                .groups
                .iter()
                .map(|g| g.app_id.as_str())
                .collect::<Vec<_>>(),
            ["notes"]
        );
        assert_eq!(app_label(Locale::En, "weather"), "Weather");
        assert_eq!(app_label(Locale::En, ""), "");
    }

    #[test]
    fn a_metric_is_found_by_its_name_and_money_and_health_are_groups_of_their_own() {
        let locale = Locale::En;
        let metrics = metric_hits(locale, "sleep");
        assert_eq!(
            metrics
                .iter()
                .map(|m| (m.app_id.as_str(), m.entity.as_str(), m.id.as_str()))
                .collect::<Vec<_>>(),
            [("health", "metric", "sleep_min")]
        );
        assert!(metric_hits(locale, "zeppelin").is_empty());
        let mut hits = metrics;
        hits.push(hit("workout", "w1", "Morning run", "health"));
        hits.push(hit("transaction", "t1", "Quokka Coffee", "money"));
        let answer = fold(locale, "run", &found(hits));
        let groups: Vec<(&str, Vec<(&str, &str)>)> = answer
            .groups
            .iter()
            .map(|group| {
                (
                    group.app_id.as_str(),
                    group
                        .rows
                        .iter()
                        .map(|row| {
                            (
                                row.kind_label.as_str(),
                                row.route.as_ref().map_or("", |r| r.screen.as_str()),
                            )
                        })
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            groups,
            [
                ("money", vec![("Payment", "money.transaction")]),
                (
                    "health",
                    vec![("Metric", "health.metric"), ("Workout", "health.workout")]
                ),
            ]
        );
    }
}
