//! An owner search for a link target. The picker excludes the source and existing links and
//! commits only when a target row is tapped; the normal core history supplies Undo.

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::entity as entity_reads;
use centraid_domain::page::{PageCursor, PageRequest};
use centraid_domain::read::Args;
use centraid_search::{Answer as SearchAnswer, SearchRequest};
use serde_json::json;

use super::blocks::{self, glyph};
use super::frame::room;
use super::screen::{Build, Event, Input, Outcome, RoomScreen};
use super::selector::{Act, Handler};
use crate::strings::{Locale, shared};

const EN: Locale = Locale::En;
const SEARCH_LIMIT: usize = 30;

pub fn unlink_menu(sel: &mut super::selector::Sel, target: &str) -> wire::RoomMenu {
    blocks::menu(
        &format!("linked/{target}/menu"),
        vec![blocks::menu_section(
            "",
            vec![blocks::menu_item(
                sel,
                &format!("linked/{target}/unlink"),
                &shared::link_remove(EN),
                Handler::Tag(format!("link:remove:{target}")),
            )],
        )],
        sel,
    )
}

pub fn handle_unlink(e: &mut Event<'_>, tag: &str, source: &str) -> Option<Outcome> {
    let target = tag.strip_prefix("link:remove:")?;
    Some(
        match e
            .door
            .act(&Act::new("link.remove", json!({"a": source, "b": target})))
        {
            Ok(done) => Outcome::done(&done.sentence, done.undo),
            Err(_) => Outcome::refuse(&shared::link_unavailable(EN)),
        },
    )
}

pub struct LinkPicker {
    source: String,
    parent: String,
    app_title: String,
    searched: String,
    after: Option<PageCursor>,
    next: Option<PageCursor>,
}

impl LinkPicker {
    pub fn new(source: String, parent: String, app_title: String) -> Self {
        Self {
            source,
            parent,
            app_title,
            searched: String::new(),
            after: None,
            next: None,
        }
    }
}

impl RoomScreen for LinkPicker {
    fn key(&self) -> String {
        format!("{}/link", self.parent)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let linked = b.run(&entity_reads::LINKED, &Args::new().text("id", &self.source));
        let mut excluded = match linked {
            Ok(answer) => answer.rows,
            Err(refused) => {
                return room(wire::RoomKind::Sheet, &self.key())
                    .title(&shared::link_picker_title(EN))
                    .back(&mut b.sel, &self.app_title)
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        excluded.push(self.source.clone());
        let query = b.ui.fields.get_or("query", "").value().to_owned();
        let mut field = super::form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "query",
            &shared::link_search_label(EN),
            wire::RoomTextKind::Line,
            &query,
            160,
        );
        field = field.focused();
        let form = super::form::form(
            vec![field.build()],
            Vec::new(),
            super::form::Save::Explicit(super::form::explicit(
                &mut b.sel,
                super::form::Explicit {
                    save_label: &shared::kit_done(EN),
                    save: Handler::Tag("cancel".to_owned()),
                    cancel_label: &shared::kit_done(EN),
                    cancel: Handler::Tag("cancel".to_owned()),
                    save_enabled: false,
                    dirty: false,
                    drafted: false,
                },
            )),
        );
        let mut sections = vec![form];
        if query != self.searched {
            self.searched.clone_from(&query);
            self.after = None;
        }
        self.next = None;
        if !query.trim().is_empty() {
            let mut request =
                SearchRequest::across(Vec::new(), query, SEARCH_LIMIT).excluding(excluded);
            if let Some(after) = self.after.clone() {
                request.page = PageRequest::after(SEARCH_LIMIT, after);
            }
            match b.door.search_page(&request) {
                Ok(SearchAnswer::Data { page, .. }) if page.rows.is_empty() => sections.push(
                    blocks::empty(glyph("Link", ""), &shared::link_no_results(EN), "", None),
                ),
                Ok(SearchAnswer::Data { page, .. }) => {
                    self.next = page.next.clone();
                    let rows: Vec<wire::RoomBlock> = page
                        .rows
                        .into_iter()
                        .map(|target| {
                            blocks::row(
                                &mut b.sel,
                                &format!("target/{}", target.id),
                                &target.title,
                                Handler::Tag(format!("add:{}", target.id)),
                            )
                            .meta(&target.subtitle)
                            .into_block()
                        })
                        .collect();
                    let mut section =
                        blocks::section(&mut b.sel, "section/results", &shared::link_results(EN))
                            .blocks(rows);
                    if self.next.is_some() {
                        section = section.block(
                            blocks::row(
                                &mut b.sel,
                                "results/next",
                                &shared::kit_show_more(EN),
                                Handler::Tag("next".to_owned()),
                            )
                            .into_block(),
                        );
                    }
                    sections.push(section.into_block());
                }
                Ok(SearchAnswer::Denied(denial)) => sections.push(blocks::prose(
                    denial
                        .message
                        .as_deref()
                        .unwrap_or(&shared::read_failed(EN)),
                )),
                Err(_) => sections.push(blocks::prose(&shared::read_failed(EN))),
            }
        }
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::link_picker_title(EN))
            .back(&mut b.sel, &self.app_title)
            .ready(sections)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "next" {
            self.after = self.next.clone();
            return Outcome::default();
        }
        if tag == "cancel" {
            return Outcome::pop();
        }
        if let Some(target) = tag.strip_prefix("add:") {
            if target == self.source {
                return Outcome::refuse(&shared::link_unavailable(EN));
            }
            return match e.door.act(&Act::new(
                "link.add",
                json!({"a": &self.source, "b": target}),
            )) {
                Ok(done) => {
                    let mut outcome = Outcome::done(&done.sentence, done.undo);
                    outcome.nav = super::screen::Nav::Pop;
                    outcome
                }
                Err(_) => Outcome::refuse(&shared::link_unavailable(EN)),
            };
        }
        Outcome::default()
    }
}
