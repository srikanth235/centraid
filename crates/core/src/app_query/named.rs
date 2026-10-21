//! THE NAMED AS SEARCH RESULTS (#1097, R-1097-19..24): the notebook, album,
//! project and Docs folder a member typed the name of, and the chat
//! thread whose title or words they typed.
//!
//! The door's one index holds the rows; this module asks it for two readers. **An app's own search** takes the
//! containers that open in that app ([`of_app`]) and lays them beside its rows in
//! one answer, so a correction treats the two as one: the term is corrected only
//! when the rows and the containers are both empty. A chat thread opens in no
//! app, so no app's search asks for it. **Home** takes every named index, one
//! probe each ([`of_all`]), isolated as its domains are: a probe that refuses
//! drops its own rows and never the answer. A chat thread is a Home hit like the
//! rest; whether it is drawn is the shell's, which knows whether it has a Chat
//! tab (R-1097-24).
//!
//! Every container opens by its own id: the circle index, whose hit was opened by
//! its Tally group's id, left with Tally (#1099, R-1099-35).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::Denial;
use centraid_search::{Answer, Principal, Search, SearchError, SearchRequest, Target};

/// The most containers one probe answers, as the domains' eight on Home.
pub(super) const CONTAINER_ROWS: usize = 8;

/// What a member names, which the index holds as an entity of its own: the
/// containers and the chat threads.
const NAMED: &[&str] = &["notebook", "album", "project", "folder", "thread"];

/// The app a kind opens in, by id; empty for a kind that opens in none (a
/// thread: Home draws it if the shell has a Chat tab, R-1097-24). The one place
/// the app roster meets the model.
pub(super) fn app_of(kind: &str) -> &'static str {
    match kind {
        "person" => "people",
        "note" | "notebook" => "notes",
        "event" | "calendar" => "agenda",
        "task" | "project" | "section" | "area" => "tasks",
        "photo" | "album" => "photos",
        "document" | "folder" => "docs",
        _ => "",
    }
}

/// The kinds a correction over an app's search reads: the app's own domain kind
/// and the containers that open in it.
pub(super) fn entities_of(domain_entity: &'static str, app: &str) -> Vec<&'static str> {
    let mut entities = vec![domain_entity];
    entities.extend(
        NAMED
            .iter()
            .filter(|kind| app_of(kind) == app)
            .copied(),
    );
    entities
}

/// The containers that open in `app` and match `term`. A denial answers for the
/// whole search; a probe that fails is the recorder's to keep, and answers no
/// rows.
pub(super) fn of_app(
    search: &dyn Search,
    app: &str,
    term: &str,
    limit: usize,
) -> (Vec<Target>, Option<Denial>) {
    let mut targets = Vec::new();
    for kind in NAMED.iter().filter(|kind| app_of(kind) == app) {
        let request = SearchRequest::new(*kind, term, limit);
        match search.query(&Principal::Owner, &request) {
            Ok(Answer::Data { page, .. }) => targets.extend(page.rows),
            Ok(Answer::Denied(denial)) => {
                return (
                    Vec::new(),
                    Some(Denial {
                        code: denial.code,
                        message: denial.message,
                        revoked_at: denial.revoked_at,
                    }),
                );
            }
            // A term of punctuation is an answer with no rows, not a refusal.
            Err(SearchError::NoSearchableWords { .. }) => {}
            Err(_) => {}
        }
    }
    (targets, None)
}

/// Everything named that matches `term`, one probe per kind, for Home: the
/// containers and the chat threads.
/// ISOLATED: a probe that refuses drops its own rows, never the answer.
pub(super) fn of_all(search: &dyn Search, term: &str) -> Vec<Target> {
    let mut targets = Vec::new();
    for kind in NAMED {
        let request = SearchRequest::new(*kind, term, CONTAINER_ROWS);
        if let Ok(Answer::Data { page, .. }) = search.query(&Principal::Owner, &request) {
            targets.extend(page.rows);
        }
    }
    targets
}

/// A container hit as the app answers carry it.
pub(super) fn to_wire(target: Target) -> wire::ContainerHit {
    wire::ContainerHit {
        app_id: app_of(&target.entity).to_owned(),
        entity: target.entity,
        id: target.id,
        title: target.title,
        snippet: target.snippet,
    }
}
