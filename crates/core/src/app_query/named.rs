//! THE NAMED AS SEARCH RESULTS (#1097, R-1097-19..24): the notebook, album,
//! project and Docs folder a member typed the name of, and the chat
//! thread whose title or words they typed.
//!
//! The door's one index holds the rows; this module asks it for two readers. **An app's own search** takes the
//! containers that open in that app ([`of_app`]) and lays them beside its rows in
//! one answer, so a correction treats the two as one: the term is corrected only
//! when the rows and the containers are both empty. A chat thread opens in no
//! app, so no app's search asks for it. **Home** asks for every named kind in the
//! same statement as its other kinds ([`all`]) and tells the containers from the rest
//! by [`is_named`]. A chat thread is a Home hit like the
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

/// The app id a Home hit for a thread is answered under: the Chat tab is no app (it is not on
/// `centraid_vault::roster`), but a conversation is a hit like the rest, and the shell draws it
/// only if it has a Chat tab (R-1097-24).
pub(super) const CHAT: &str = "chat";

/// The app a kind opens in, by id; `chat` for a thread, empty for a kind that opens in none. The
/// one place the app roster meets the model: every id it answers but `chat` is a
/// `centraid_vault::roster` id (the test below holds it).
pub(super) fn app_of(kind: &str) -> &'static str {
    match kind {
        "person" => "people",
        "note" | "notebook" => "notes",
        "event" | "calendar" => "agenda",
        "task" | "project" | "section" | "area" => "tasks",
        "photo" | "album" => "photos",
        "document" | "folder" => "docs",
        "thread" => CHAT,
        _ => "",
    }
}

/// The kinds a correction over an app's search reads: the app's own domain kind
/// and the containers that open in it.
pub(super) fn entities_of(domain_entity: &'static str, app: &str) -> Vec<&'static str> {
    let mut entities = vec![domain_entity];
    entities.extend(NAMED.iter().filter(|kind| app_of(kind) == app).copied());
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

/// Whether a kind is one of the named: a container or a chat thread.
pub(super) fn is_named(kind: &str) -> bool {
    NAMED.contains(&kind)
}

/// Every named kind, for a search that asks about them beside other kinds in
/// one statement (Home's).
pub(super) const fn all() -> &'static [&'static str] {
    NAMED
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_app_a_kind_opens_in_is_on_the_roster_but_the_chat_tab() {
        for kind in centraid_vault::model::Kind::ALL {
            let app = app_of(kind.as_str());
            assert!(
                app.is_empty() || app == CHAT || centraid_vault::roster::is_card_app(app),
                "{kind:?} opens in `{app}`, which the roster does not know"
            );
        }
        assert!(
            !centraid_vault::roster::is_card_app(CHAT),
            "the Chat tab is no app a card names"
        );
    }
}
