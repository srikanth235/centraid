//! Shared kind-aware Move and Tag destinations for lists that select records.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity, notes};
use centraid_domain::read::Args;
use serde_json::json;

use super::blocks;
use super::form::{self, Explicit, Save};
use super::frame::room;
use super::screen::{Build, Event, Input, Nav, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler};
use crate::strings::{Locale, shared};

const EN: Locale = Locale::En;
const MAX_IDS: usize = centraid_domain::action::MAX_TARGETS;

/// Whether this kind can be filed in at least one declared home.
#[must_use]
pub fn can_move(kind: &str) -> bool {
    centraid_domain::KINDS
        .iter()
        .find(|decl| decl.id == kind)
        .is_some_and(|decl| !decl.home.sits_in.is_empty())
}

/// Whether this kind can wear a tag under the current `tagged('*', 'tag')` edge shape.
#[must_use]
pub fn can_tag(kind: &str) -> bool {
    centraid_vault::model::Kind::parse(kind).is_some_and(centraid_vault::model::Kind::is_link_end)
}

/// Whether either shared organize verb applies to this kind.
#[must_use]
pub fn can_organize(kind: &str) -> bool {
    can_move(kind) || can_tag(kind)
}

/// The shared organizer route for a non-empty set of selected item ids.
#[must_use]
pub fn route(ids: &[impl AsRef<str>]) -> String {
    format!(
        "organize/{}",
        ids.iter()
            .map(|id| id.as_ref())
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn parse_ids(path: &str) -> Option<Vec<String>> {
    let mut ids = Vec::new();
    let mut seen = BTreeSet::new();
    for id in path.split(',') {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return None;
        }
        if seen.insert(id.to_owned()) {
            ids.push(id.to_owned());
        }
        if ids.len() > MAX_IDS {
            return None;
        }
    }
    (!ids.is_empty()).then_some(ids)
}

pub fn registry() -> Registry {
    Registry::new().with(Box::new(|key| {
        let route = key.strip_prefix("organize/")?;
        if let Some(ids) = route.strip_suffix("/tag/new") {
            return Some(Box::new(TagForm {
                ids: parse_ids(ids)?,
            }));
        }
        Some(Box::new(Organizer {
            ids: parse_ids(route)?,
            after: BTreeMap::new(),
            next: BTreeMap::new(),
        }))
    }))
}

struct Organizer {
    ids: Vec<String>,
    after: BTreeMap<String, String>,
    next: BTreeMap<String, String>,
}

impl RoomScreen for Organizer {
    fn key(&self) -> String {
        route(&self.ids)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        self.next.clear();
        let mut kinds = Vec::with_capacity(self.ids.len());
        for id in &self.ids {
            let meta = match b.run(&entity::META_BY_ID, &Args::new().text("id", id)) {
                Ok(answer) => answer.rows.into_iter().next(),
                Err(error) => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&shared::organize(EN))
                        .back(&mut b.sel, &shared::back(EN))
                        .failed(&mut b.sel, &error.0, &shared::kit_retry(EN))
                        .build();
                }
            };
            let Some(meta) = meta else {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&shared::organize(EN))
                    .back(&mut b.sel, &shared::back(EN))
                    .failed(&mut b.sel, &shared::read_failed(EN), &shared::kit_retry(EN))
                    .build();
            };
            kinds.push(meta.kind);
        }

        let declarations: Vec<_> = kinds
            .iter()
            .filter_map(|kind| centraid_domain::KINDS.iter().find(|decl| decl.id == kind))
            .collect();
        let mut content = Vec::new();

        if declarations.len() == self.ids.len() {
            let mut common_homes: BTreeSet<&str> =
                declarations[0].home.sits_in.iter().copied().collect();
            for declaration in declarations.iter().skip(1) {
                common_homes.retain(|home| declaration.home.sits_in.contains(home));
            }

            let mut move_rows = Vec::new();
            let mut seen_homes = BTreeSet::new();
            let mut seen_targets = BTreeSet::new();
            for home in common_homes {
                if !seen_homes.insert(home) {
                    continue;
                }
                if centraid_vault::model::Kind::parse(home)
                    .is_some_and(centraid_vault::model::Kind::is_container)
                {
                    let mut args = Args::new().text("kind", home);
                    let key = format!("move:{home}");
                    if let Some(cursor) = self.after.get(&key) {
                        args = args.after(cursor.clone());
                    }
                    let answer = match b.run(&entity::CONTAINERS_BY_KIND_PAGE, &args) {
                        Ok(answer) => answer,
                        Err(error) => {
                            return room(wire::RoomKind::PushedPage, &self.key())
                                .title(&shared::organize(EN))
                                .back(&mut b.sel, &shared::back(EN))
                                .failed(&mut b.sel, &error.0, &shared::kit_retry(EN))
                                .build();
                        }
                    };
                    if let Some(cursor) = answer.next.clone() {
                        self.next.insert(key.clone(), cursor);
                    }
                    for container in answer.rows {
                        if self.ids.contains(&container.id)
                            || !seen_targets.insert(container.id.clone())
                        {
                            continue;
                        }
                        move_rows.push(
                            blocks::row(
                                &mut b.sel,
                                &format!("organize/move/{}", container.id),
                                &container.title,
                                Handler::Act(Act::new(
                                    "entity.move",
                                    json!({ "ids": &self.ids, "parent": container.id }),
                                )),
                            )
                            .into_block(),
                        );
                    }
                    if self.next.contains_key(&key) {
                        move_rows.push(
                            blocks::row(
                                &mut b.sel,
                                &format!("organize/more/{key}"),
                                &shared::kit_show_more(EN),
                                Handler::Tag(format!("more:{key}")),
                            )
                            .into_block(),
                        );
                    }
                } else {
                    let mut args = Args::new().text("kind", home);
                    let key = format!("move:{home}");
                    if let Some(cursor) = self.after.get(&key) {
                        args = args.after(cursor.clone());
                    }
                    let answer = match b.run(&entity::BY_KIND_RECENT, &args) {
                        Ok(answer) => answer,
                        Err(error) => {
                            return room(wire::RoomKind::PushedPage, &self.key())
                                .title(&shared::organize(EN))
                                .back(&mut b.sel, &shared::back(EN))
                                .failed(&mut b.sel, &error.0, &shared::kit_retry(EN))
                                .build();
                        }
                    };
                    if let Some(cursor) = answer.next.clone() {
                        self.next.insert(key.clone(), cursor);
                    }
                    for item in answer.rows {
                        if self.ids.contains(&item.id) || !seen_targets.insert(item.id.clone()) {
                            continue;
                        }
                        move_rows.push(
                            blocks::row(
                                &mut b.sel,
                                &format!("organize/move/{}", item.id),
                                &item.title,
                                Handler::Act(Act::new(
                                    "entity.move",
                                    json!({ "ids": &self.ids, "parent": item.id }),
                                )),
                            )
                            .into_block(),
                        );
                    }
                    if self.next.contains_key(&key) {
                        move_rows.push(
                            blocks::row(
                                &mut b.sel,
                                &format!("organize/more/{key}"),
                                &shared::kit_show_more(EN),
                                Handler::Tag(format!("more:{key}")),
                            )
                            .into_block(),
                        );
                    }
                }
            }
            if declarations
                .iter()
                .all(|declaration| declaration.home.top && !declaration.home.sits_in.is_empty())
            {
                move_rows.push(
                    blocks::row(
                        &mut b.sel,
                        "organize/move/top",
                        &shared::move_to_top(EN),
                        Handler::Act(Act::new("entity.move", json!({ "ids": &self.ids }))),
                    )
                    .into_block(),
                );
            }
            if !move_rows.is_empty() {
                content.push(
                    blocks::section(&mut b.sel, "organize/move", &shared::move_to(EN))
                        .blocks(move_rows)
                        .into_block(),
                );
            }
        }

        if kinds.iter().all(|kind| can_tag(kind)) {
            let mut args = Args::new();
            if let Some(cursor) = self.after.get("tags") {
                args = args.after(cursor.clone());
            }
            let (tags, tag_next) = match b.run(&notes::TAGS_PAGE, &args) {
                Ok(answer) => (answer.rows, answer.next),
                Err(error) => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&shared::organize(EN))
                        .back(&mut b.sel, &shared::back(EN))
                        .failed(&mut b.sel, &error.0, &shared::kit_retry(EN))
                        .build();
                }
            };
            if let Some(cursor) = tag_next {
                self.next.insert("tags".to_owned(), cursor);
            }
            let mut tag_rows: Vec<wire::RoomBlock> = tags
                .into_iter()
                .map(|tag| {
                    blocks::row(
                        &mut b.sel,
                        &format!("organize/tag/{}", tag.id),
                        &tag.title,
                        Handler::Act(Act::new(
                            "tag.add",
                            json!({ "ids": &self.ids, "label": tag.title }),
                        )),
                    )
                    .into_block()
                })
                .collect();
            tag_rows.push(
                blocks::row(
                    &mut b.sel,
                    "organize/tag/new",
                    &shared::new_tag(EN),
                    Handler::Open(format!("organize/{}/tag/new", self.ids.join(","))),
                )
                .into_block(),
            );
            if self.next.contains_key("tags") {
                tag_rows.push(
                    blocks::row(
                        &mut b.sel,
                        "organize/more/tags",
                        &shared::kit_show_more(EN),
                        Handler::Tag("more:tags".to_owned()),
                    )
                    .into_block(),
                );
            }
            content.push(
                blocks::section(&mut b.sel, "organize/tags", &shared::add_tag(EN))
                    .blocks(tag_rows)
                    .into_block(),
            );
        }

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&shared::selected_count(
                EN,
                u64::try_from(self.ids.len()).unwrap_or(u64::MAX),
            ))
            .subtitle(&shared::organize(EN))
            .back(&mut b.sel, &shared::back(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(section) = tag.strip_prefix("more:")
            && let Some(cursor) = self.next.get(section)
        {
            self.after.insert(section.to_owned(), cursor.clone());
        }
        Outcome::default()
    }
}

struct TagForm {
    ids: Vec<String>,
}

impl RoomScreen for TagForm {
    fn key(&self) -> String {
        format!("organize/{}/tag/new", self.ids.join(","))
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let label = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "label",
            &shared::tag_name(EN),
            wire::RoomTextKind::Line,
            "",
            120,
        )
        .focused()
        .build();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("organize:tag-save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: false,
                drafted: false,
            },
        );
        room(wire::RoomKind::Editor, &self.key())
            .title(&shared::new_tag(EN))
            .back(&mut b.sel, &shared::organize(EN))
            .ready(vec![form::form(
                vec![label],
                Vec::new(),
                Save::Explicit(save),
            )])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag != "organize:tag-save" {
            return Outcome::default();
        }
        let label = e.ui.fields.value("label").unwrap_or_default().trim();
        if label.is_empty() {
            return Outcome::refuse(&shared::write_refused(EN));
        }
        match e.door.act(&Act::new(
            "tag.add",
            json!({ "ids": &self.ids, "label": label }),
        )) {
            Ok(done) => {
                let mut outcome = Outcome::done(&done.sentence, done.undo);
                outcome.nav = Nav::Pop;
                outcome
            }
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{can_move, can_organize, can_tag};

    #[test]
    fn move_and_tag_options_follow_kind_and_home_capabilities() {
        assert!(can_move("event"));
        assert!(!can_move("workout"));
        assert!(can_tag("event"));
        assert!(can_tag("workout"));
        assert!(can_tag("locker_item"));
        assert!(!can_tag("reading"));
        assert!(!can_organize("reading"));
    }
}
