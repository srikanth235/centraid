//! THE NAMED AS SEARCH RESULTS (#1097, R-1097-19..24): the notebook, album,
//! project, Tally group and Docs folder a member typed the name of, and the chat
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
//! A Tally group is a circle in the index and a `tally_group` in Tally, so a
//! circle hit is opened by its group's id ([`Opened::open_id`]) and a circle with
//! no live group is dropped here as the door drops it there (belt and braces; the
//! door's guard is the first).

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::Denial;
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageOrder, PageQuery};
use centraid_search::{Answer, NAMED, Principal, Search, SearchError, SearchRequest, Target};

/// The most containers one probe answers, as the domains' eight on Home.
pub(super) const CONTAINER_ROWS: usize = 8;

/// The entity of a Tally group in the index.
const CIRCLE_ENTITY: &str = "social.circle";

/// The groups one answer can open: eight circles, with room.
const OPENABLE: FanOutBound = FanOutBound::new(64, 1);

/// A container hit and what its app opens it by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Opened {
    pub(super) target: Target,
    /// The key the app opens it by when that is not `target.id`; empty otherwise.
    pub(super) open_id: String,
}

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
    door: &dyn PageDoor,
    search: &dyn Search,
    app: &str,
    term: &str,
    limit: usize,
) -> KitResult<(Vec<Opened>, Option<Denial>)> {
    let mut targets = Vec::new();
    for container in NAMED
        .iter()
        .filter(|container| container.apps().contains(&app))
    {
        let request = SearchRequest::new(container.entity, term, limit).in_app(app);
        match search.query(&Principal::Owner, &request) {
            Ok(Answer::Data { page, .. }) => targets.extend(page.rows),
            Ok(Answer::Denied(denial)) => {
                return Ok((
                    Vec::new(),
                    Some(Denial {
                        code: denial.code,
                        message: denial.message,
                        revoked_at: denial.revoked_at,
                    }),
                ));
            }
            // A term of punctuation is an answer with no rows, not a refusal.
            Err(SearchError::NoSearchableWords { .. }) => {}
            Err(_) => {}
        }
    }
    Ok((opened(door, targets)?, None))
}

/// Everything named that matches `term`, one probe per index, for Home: the
/// containers and the chat threads.
/// ISOLATED: a probe that refuses drops its own rows, never the answer.
pub(super) fn of_all(
    door: &dyn PageDoor,
    search: &dyn Search,
    term: &str,
) -> KitResult<Vec<Opened>> {
    let mut targets = Vec::new();
    for container in NAMED {
        let request = SearchRequest::new(container.entity, term, CONTAINER_ROWS);
        if let Ok(Answer::Data { page, .. }) = search.query(&Principal::Owner, &request) {
            targets.extend(page.rows);
        }
    }
    opened(door, targets)
}

/// The targets with the key each opens by, and a Tally group's circle dropped
/// when no live group stands on it.
fn opened(door: &dyn PageDoor, targets: Vec<Target>) -> KitResult<Vec<Opened>> {
    let circles: Vec<String> = targets
        .iter()
        .filter(|target| target.entity == CIRCLE_ENTITY)
        .map(|target| target.id.clone())
        .collect();
    let groups = if circles.is_empty() {
        BTreeMap::new()
    } else {
        let fragment = in_list("circle_id", &circles)?;
        let rows = read_pages(
            door,
            &PageQuery::new(
                "containers.groups",
                "group_id, circle_id",
                "tally_group",
                PageOrder::asc("group_id", "group_id"),
            )
            .filter(
                &format!("{} AND archived_at IS NULL", fragment.sql),
                fragment.bind,
            ),
            OPENABLE,
        )?;
        rows.iter()
            .filter_map(|row| Some((text_of(row, "circle_id")?, text_of(row, "group_id")?)))
            .collect::<BTreeMap<String, String>>()
    };
    Ok(targets
        .into_iter()
        .filter_map(|target| {
            if target.entity == CIRCLE_ENTITY {
                let open_id = groups.get(&target.id)?.clone();
                Some(Opened { target, open_id })
            } else {
                Some(Opened {
                    target,
                    open_id: String::new(),
                })
            }
        })
        .collect())
}

/// A container hit as the app answers carry it.
pub(super) fn to_wire(opened: Opened) -> wire::ContainerHit {
    wire::ContainerHit {
        entity: opened.target.entity,
        id: opened.target.id,
        title: opened.target.title,
        app_id: opened.target.app_id,
        snippet: opened.target.snippet,
        open_id: opened.open_id,
    }
}
