//! THE NAMED AS SEARCH RESULTS (#1097, R-1097-19..24): the notebook, album,
//! project and Docs folder a member typed the name of, and the chat
//! thread whose title or words they typed.
//!
//! The door's second registry ([`centraid_search::NAMED`]) holds the rows;
//! this module asks it for two readers. **An app's own search** takes the
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
use centraid_search::{Answer, NAMED, Principal, Search, SearchError, SearchRequest, Target};

/// The most containers one probe answers, as the domains' eight on Home.
pub(super) const CONTAINER_ROWS: usize = 8;

/// The entities a correction over an app's search reads: the app's own domain
/// entity and the containers that open in it.
pub(super) fn entities_of(domain_entity: &'static str, app: &str) -> Vec<&'static str> {
    let mut entities = vec![domain_entity];
    entities.extend(
        NAMED
            .iter()
            .filter(|container| container.apps().contains(&app))
            .map(|container| container.entity),
    );
    entities
}

/// The containers that open in `app` and match `term`, each probe narrowed to
/// the app (a shared index answers only that app's rows). A denial answers for
/// the whole search; a probe that fails is the recorder's to keep, and answers
/// no rows.
pub(super) fn of_app(
    search: &dyn Search,
    app: &str,
    term: &str,
    limit: usize,
) -> (Vec<Target>, Option<Denial>) {
    let mut targets = Vec::new();
    for container in NAMED
        .iter()
        .filter(|container| container.apps().contains(&app))
    {
        let request = SearchRequest::new(container.entity, term, limit).in_app(app);
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

/// Everything named that matches `term`, one probe per index, for Home: the
/// containers and the chat threads.
/// ISOLATED: a probe that refuses drops its own rows, never the answer.
pub(super) fn of_all(search: &dyn Search, term: &str) -> Vec<Target> {
    let mut targets = Vec::new();
    for container in NAMED {
        let request = SearchRequest::new(container.entity, term, CONTAINER_ROWS);
        if let Ok(Answer::Data { page, .. }) = search.query(&Principal::Owner, &request) {
            targets.extend(page.rows);
        }
    }
    targets
}

/// A container hit as the app answers carry it.
pub(super) fn to_wire(target: Target) -> wire::ContainerHit {
    wire::ContainerHit {
        entity: target.entity,
        id: target.id,
        title: target.title,
        app_id: target.app_id,
        snippet: target.snippet,
    }
}
