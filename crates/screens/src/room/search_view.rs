//! Shared FTS-backed search state and result rows for app places.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::entity;
use centraid_domain::read::Args;
use centraid_search::{Answer, SearchRequest};

use super::blocks;
use super::door::Door;
use super::home;
use super::screen::Build;
use super::selector::{Handler, Sel};
use super::ui::Ui;
use crate::strings::{Locale, fill, shared};

const EN: Locale = Locale::En;

/// Load one FTS page for an app search. The UI retains the cursor and rows across builds.
pub fn load(ui: &mut Ui, door: &dyn Door, kinds: &[&str], term: &str) -> Result<(), String> {
    ui.begin_search(term);
    if ui.search_page_loaded() {
        return Ok(());
    }
    let kinds: Vec<String> = kinds.iter().map(|kind| (*kind).to_owned()).collect();
    let run = |query: &str, after| {
        let mut request = SearchRequest::across(kinds.clone(), query.to_owned(), 10);
        request.page.after = after;
        door.search_page(&request)
    };
    match run(ui.search_applied(), ui.search_after().cloned()) {
        Ok(Answer::Data { page, .. }) => {
            if page.rows.is_empty()
                && ui.search_after().is_none()
                && ui.search_corrected().is_empty()
            {
                if let Some(corrected) = door
                    .search_correction(&kinds, term, false)
                    .map_err(|error| error.0)?
                {
                    ui.set_search_correction(&corrected);
                    match run(&corrected, None).map_err(|error| error.0)? {
                        Answer::Data { page, .. } => ui.append_search_page(page.rows, page.next),
                        Answer::Denied(_) => return Err(unavailable()),
                    }
                } else {
                    ui.append_search_page(page.rows, page.next);
                }
            } else {
                ui.append_search_page(page.rows, page.next);
            }
            Ok(())
        }
        Ok(Answer::Denied(_)) => Err(unavailable()),
        Err(error) => Err(error.0),
    }
}

/// Build result sections with real item routes and a continuation selector.
pub fn rows(sel: &mut Sel, ui: &Ui, selecting: bool) -> Vec<wire::RoomBlock> {
    let mut by_kind = BTreeMap::new();
    for target in ui.search_hits().iter().cloned() {
        if is_container(&target.entity) {
            continue;
        }
        by_kind
            .entry(target.entity.clone())
            .or_insert_with(Vec::new)
            .push(target);
    }
    let kinds: Vec<String> = by_kind.keys().cloned().collect();
    by_kind
        .into_iter()
        .enumerate()
        .map(|(index, (kind, targets))| {
            let heading = home::kind_label(&kind);
            let rows = targets
                .into_iter()
                .map(|target| {
                    let action = if selecting {
                        Handler::Pick(target.id.clone())
                    } else if target.in_earlier_version {
                        Handler::Open(home::route_for_versions(&target.entity, &target.id))
                    } else {
                        Handler::Open(home::route_for_entity(&target.entity, &target.id))
                    };
                    let selected = selecting && ui.is_picked(&target.id);
                    blocks::row(
                        sel,
                        &format!("search/hit/{}", target.id),
                        &target.title,
                        action,
                    )
                    .selected(selected)
                    .meta(if target.in_earlier_version {
                        "In an earlier version"
                    } else if target.snippet.is_empty() {
                        heading.as_str()
                    } else {
                        &target.snippet
                    })
                    .into_block()
                })
                .collect::<Vec<_>>();
            let section =
                blocks::section(sel, &format!("search/section/{kind}"), &heading).blocks(rows);
            let section = if index + 1 == kinds.len() && ui.search_next().is_some() {
                section.next_page(sel, "search/more")
            } else {
                section
            };
            section.into_block()
        })
        .collect()
}

/// Add the Ask row and any correction to the shared search field.
pub fn decorate(sel: &mut Sel, search: &mut wire::RoomSearch, ui: &Ui) {
    search.containers = ui
        .search_hits()
        .iter()
        .filter(|target| is_container(&target.entity))
        .map(|target| {
            blocks::row(
                sel,
                &format!("search/container/{}", target.id),
                &target.title,
                Handler::Open(home::route_for_entity(&target.entity, &target.id)),
            )
            .meta(&home::kind_label(&target.entity))
            .build()
        })
        .collect();
    if !ui.search_corrected().is_empty() {
        search.corrected = fill(
            &shared::search_corrected(EN),
            &[("corrected", ui.search_corrected())],
        );
    }
    if !ui.search_term().trim().is_empty() {
        search.ask = Some(
            blocks::row(
                sel,
                "search/ask",
                &fill(
                    &shared::search_ask_about(EN),
                    &[("term", ui.search_term().trim())],
                ),
                Handler::Ask(ui.search_term().trim().to_owned()),
            )
            .build(),
        );
    }
}

/// Resolve title matches for kinds intentionally left out of the FTS index, such as person lists
/// and money accounts. These are registered, bounded reads, not a scan of the first item page.
pub fn unindexed_title_rows(
    build: &mut Build<'_>,
    kinds: &[&str],
    term: &str,
) -> Result<Vec<wire::RoomRow>, String> {
    let words: Vec<String> = centraid_domain::spelling::words(term)
        .into_iter()
        .map(|word| centraid_domain::spelling::fold_like_index(&word))
        .filter(|word| !word.is_empty())
        .collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    for &kind in kinds {
        if centraid_vault::model::Kind::CONTAINERS
            .into_iter()
            .any(|container| container.as_str() == kind)
        {
            let mut after = None;
            loop {
                let mut args = Args::new().text("kind", kind);
                if let Some(cursor) = after {
                    args = args.after(cursor);
                }
                let answer = build
                    .run(&entity::CONTAINERS_BY_KIND_PAGE, &args)
                    .map_err(|error| error.0)?;
                rows.extend(answer.rows.into_iter().filter_map(|row| {
                    title_matches(&row.title, &words).then(|| {
                        blocks::row(
                            &mut build.sel,
                            &format!("search/container/{}", row.id),
                            &row.title,
                            Handler::Open(home::route_for_entity(&row.kind, &row.id)),
                        )
                        .meta(&home::kind_label(&row.kind))
                        .build()
                    })
                }));
                if rows.len() >= 50 || answer.next.is_none() {
                    break;
                }
                after = answer.next;
            }
        } else {
            let mut after = None;
            loop {
                let mut args = Args::new().text("kind", kind);
                if let Some(cursor) = after {
                    args = args.after(cursor);
                }
                let answer = build
                    .run(&entity::TITLES_BY_KIND_PAGE, &args)
                    .map_err(|error| error.0)?;
                rows.extend(answer.rows.into_iter().filter_map(|row| {
                    title_matches(&row.title, &words).then(|| {
                        blocks::row(
                            &mut build.sel,
                            &format!("search/container/{}", row.id),
                            &row.title,
                            Handler::Open(home::route_for_entity(&row.kind, &row.id)),
                        )
                        .meta(&home::kind_label(&row.kind))
                        .build()
                    })
                }));
                if rows.len() >= 50 || answer.next.is_none() {
                    break;
                }
                after = answer.next;
            }
        }
    }
    Ok(rows)
}

fn title_matches(title: &str, words: &[String]) -> bool {
    let title = centraid_domain::spelling::fold_like_index(title);
    words.iter().all(|word| title.contains(word))
}

fn is_container(kind: &str) -> bool {
    matches!(
        kind,
        "notebook" | "folder" | "album" | "calendar" | "task_list" | "list"
    )
}

fn unavailable() -> String {
    "Search is unavailable right now. Try again.".to_owned()
}
