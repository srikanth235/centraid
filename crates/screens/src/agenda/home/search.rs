//! WHAT A TERM FINDS BESIDE EVENTS: the tasks, as one group above the days, and
//! the projects whose own name it matched, as containers above that (#1097
//! R-1097-19, #1128 Q-1128-1).

use centraid_api_proto::core_v1 as wire;

use super::held::Held;
use crate::agenda::routes;
use crate::agenda::todo::rows;
use crate::strings::{Locale, agenda as words, shared};

/// The index entity a project container carries.
const PROJECT_ENTITY: &str = "project";

/// The tasks a search term found, as one group; `None` when it found none.
#[must_use]
pub fn hits_group(locale: Locale, held: &Held, ctx: &rows::Context) -> Option<wire::TodoRowGroup> {
    let found = &held.search.as_ref()?.tasks.as_ref()?.tasks;
    if found.is_empty() {
        return None;
    }
    let mut ctx = ctx.clone();
    ctx.day_in_head = false;
    let rows: Vec<wire::TodoRow> = found
        .iter()
        .map(|task| rows::row(locale, task, &ctx, false))
        .collect();
    Some(wire::TodoRowGroup {
        key: "results".to_owned(),
        title: words::search_tasks(locale),
        meta: rows.len().to_string(),
        rows,
        ..wire::TodoRowGroup::default()
    })
}

/// THE PROJECTS A SEARCH NAMED, as the kit's containers. Projects only: a hit
/// of another kind is a plain row elsewhere and never a container here.
#[must_use]
pub fn containers(locale: Locale, held: &Held) -> Vec<wire::SearchContainer> {
    let Some(tasks) = held
        .search
        .as_ref()
        .and_then(|search| search.tasks.as_ref())
    else {
        return Vec::new();
    };
    tasks
        .containers
        .iter()
        .filter(|hit| hit.entity == PROJECT_ENTITY)
        .map(|hit| {
            let kind_label = shared::search_kind_project(locale);
            let accessibility_label = [kind_label.as_str(), hit.title.as_str()]
                .into_iter()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            wire::SearchContainer {
                entity: hit.entity.clone(),
                id: hit.id.clone(),
                app_id: hit.app_id.clone(),
                kind_label,
                title: hit.title.clone(),
                icon_key: "List".to_owned(),
                accessibility_label,
                route: Some(routes::project(&hit.id, &hit.title)),
            }
        })
        .collect()
}
