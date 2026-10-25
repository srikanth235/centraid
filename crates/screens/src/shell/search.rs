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
}

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Search {
        term: String::new(),
        recent: Vec::new(),
        phase: Phase::Resting,
    }))
}

impl Search {
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
            Reading::Data(found) => Phase::Ready(found),
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
                    chrome: Some(chrome(locale)),
                    term: self.term.clone(),
                    content: Some(content),
                    recent: self.recent.clone(),
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}

fn chrome(locale: Locale) -> wire::HomeSearchChrome {
    wire::HomeSearchChrome {
        placeholder: words::home_search_placeholder(locale),
        scope_label: words::home_search_scope_label(locale),
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
        _ => String::new(),
    }
}

/// A container the index names: what it is, its mark, and the app it opens in.
fn container_kind(locale: Locale, entity: &str, app: &str) -> Option<(String, &'static str)> {
    Some(match (entity, app) {
        ("notebook", "notes") => (shared::search_kind_notebook(locale), "Book"),
        ("album", "photos") => (shared::search_kind_album(locale), "Image"),
        ("project", "agenda") => (shared::search_kind_project(locale), "List"),
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
        "agenda" => words::app_agenda(locale),
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
                let route = row_routes::route(
                    &RowRef::new(app, &hit.entity, opens(hit), &hit.title),
                    "",
                    &photos_among,
                );
                // A row with no page to open is not offered.
                if route.is_none() {
                    continue;
                }
                rows.push(wire::HomeSearchRow {
                    entity: hit.entity.clone(),
                    id: hit.id.clone(),
                    app_id: app.to_owned(),
                    accessibility_label: spoken(&[&kind, &hit.title]),
                    kind_label: kind,
                    title: hit.title.clone(),
                    route,
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
