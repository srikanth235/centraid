use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{chat as reads, entity as entity_reads};
use centraid_domain::read::Args;
use serde_json::json;

use super::blocks::{self, Confirm, glyph};
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, chat as words, fill, home as home_words, shared};

pub const CHAT: &str = "chat";
pub const THREADS: &str = "chat/threads";
pub const CLEAR: &str = "chat/clear";
pub const CONCEPTS: &str = "chat/concepts";

const EN: Locale = Locale::En;
const MAX_COMPOSER: usize = 8_000;

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(CHAT, || Box::new(ChatRootRoom))
        .exact(THREADS, || Box::new(ThreadsListRoom::default()))
        .exact(CLEAR, || Box::new(ClearChatsConfirm))
        .exact(CONCEPTS, || Box::new(ConceptsRoom))
        .with(Box::new(|key| {
            if let Some(rest) = key.strip_prefix("chat/concept/") {
                if let Some(id) = rest.strip_suffix("/rename") {
                    return Some(Box::new(ConceptRenameForm::new(id.to_owned())));
                }
                if let Some((from, into)) = rest.split_once("/merge/") {
                    return Some(Box::new(ConceptMergeConfirm {
                        from: from.to_owned(),
                        into: into.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/merge") {
                    return Some(Box::new(ConceptMergePick { id: id.to_owned() }));
                }
            }
            if let Some(thread_id) = key.strip_prefix("chat/")
                && !thread_id.is_empty()
                && !matches!(thread_id, "threads" | "clear" | "concepts")
                && !thread_id.contains('/')
            {
                return Some(Box::new(ThreadDetailRoom {
                    id: thread_id.to_owned(),
                }));
            }
            None
        }))
}

fn chat_band(sel: &mut Sel) -> wire::RoomBand {
    let tabs = vec![
        frame::tab(sel, "tab/home", &home_words::band_home(EN), "Home", false),
        frame::tab(sel, "tab/chat", &words::title(EN), "Chat", true),
        frame::tab(
            sel,
            "tab/backup",
            &home_words::band_backup(EN),
            "Backup",
            false,
        ),
    ];
    frame::band(tabs, None, None, sel)
}

fn handle_shell_band(tag: &str) -> Option<Outcome> {
    match tag {
        "tab:tab/home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/chat" => Some(Outcome::replace(CHAT)),
        "tab:tab/backup" => Some(Outcome::replace(super::shell::BACKUP)),
        _ => None,
    }
}

fn entity_route(kind: &str, id: &str) -> Option<String> {
    match kind {
        "person" => Some(format!("person/{id}")),
        "workout" => Some(format!("health/workout/{id}")),
        "locker_item" => Some(format!("locker/item/{id}")),
        "txn" => Some(format!("money/txn/{id}")),
        "account" => Some(format!("money/account/{id}")),
        _ => None,
    }
}

struct ChatRootRoom;

impl RoomScreen for ChatRootRoom {
    fn key(&self) -> String {
        CHAT.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let threads = match b.run(&reads::THREADS, &Args::new()) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, CHAT)
                    .title(&words::title(EN))
                    .band(chat_band(&mut b.sel))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let mut blocks_out = Vec::new();
        if threads.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("Chat", ""),
                &words::empty_title(EN),
                &words::empty_body(EN),
                None,
            ));
        } else {
            let rows: Vec<wire::RoomBlock> = threads
                .iter()
                .take(5)
                .map(|t| {
                    let meta = t.scope.as_deref().unwrap_or(&t.at[..10.min(t.at.len())]);
                    blocks::row(
                        &mut b.sel,
                        &format!("thread/{}", t.id),
                        &t.title,
                        Handler::Open(format!("chat/{}", t.id)),
                    )
                    .meta(meta)
                    .swipe(
                        &mut b.sel,
                        &format!("thread/{}/swipe", t.id),
                        &shared::trash_move(EN),
                        Handler::Act(Act::new("entity.trash", json!({ "ids": [t.id] }))),
                    )
                    .into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(&mut b.sel, "section/threads", &words::threads_title(EN))
                    .trailing(blocks::action(
                        &mut b.sel,
                        "threads/all",
                        &shared::kit_show_more(EN),
                        "ChevronRight",
                        Handler::Open(THREADS.to_owned()),
                    ))
                    .blocks(rows)
                    .into_block(),
            );
        }

        let composer_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "composer",
            &words::composer_label(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_COMPOSER,
        )
        .build();
        let dirty = !b.ui.fields.value("composer").unwrap_or_default().is_empty();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &words::composer_send(EN),
                save: Handler::Tag("chat:send".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("chat:clear_input".to_owned()),
                save_enabled: true,
                dirty,
                drafted: false,
            },
        );
        blocks_out.push(form::form(
            vec![composer_field],
            Vec::new(),
            Save::Explicit(save),
        ));

        room(wire::RoomKind::AppPlace, CHAT)
            .title(&words::title(EN))
            .key(
                &mut b.sel,
                "key/threads",
                wire::RoomKeyRole::Tool,
                "Clock",
                &words::threads_title(EN),
                Handler::Open(THREADS.to_owned()),
            )
            .band(chat_band(&mut b.sel))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(outcome) = handle_shell_band(tag) {
            return outcome;
        }
        match tag {
            "chat:send" => {
                let text =
                    e.ui.fields
                        .value("composer")
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                if text.is_empty() {
                    return Outcome::refuse(&words::composer_empty(EN));
                }
                if let Some(f) = e.ui.fields.get_mut("composer") {
                    f.set("");
                }
                Outcome::say(&words::composer_queued(EN))
            }
            "chat:clear_input" => {
                if let Some(f) = e.ui.fields.get_mut("composer") {
                    f.set("");
                }
                Outcome::default()
            }
            _ => Outcome::default(),
        }
    }
}

#[derive(Default)]
struct ThreadsListRoom {
    loaded: usize,
}

impl ThreadsListRoom {
    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for ThreadsListRoom {
    fn key(&self) -> String {
        THREADS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let page = match b.reload(&reads::THREADS, &Args::new(), self.page_size()) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, THREADS)
                    .title(&words::threads_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let term = b.ui.search_term().trim().to_lowercase();
        let filtered: Vec<&reads::ThreadSummary> = page
            .rows
            .iter()
            .filter(|t| term.is_empty() || t.title.to_lowercase().contains(&term))
            .collect();

        let blocks_out = if filtered.is_empty() {
            vec![blocks::empty(
                glyph("Chat", ""),
                &words::threads_empty_title(EN),
                &words::threads_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = filtered
                .iter()
                .map(|t| {
                    let meta = t.scope.as_deref().unwrap_or(&t.at[..10.min(t.at.len())]);
                    blocks::row(
                        &mut b.sel,
                        &format!("thread/{}", t.id),
                        &t.title,
                        Handler::Open(format!("chat/{}", t.id)),
                    )
                    .meta(meta)
                    .swipe(
                        &mut b.sel,
                        &format!("thread/{}/swipe", t.id),
                        &shared::trash_move(EN),
                        Handler::Act(Act::new("entity.trash", json!({ "ids": [t.id] }))),
                    )
                    .into_block()
                })
                .collect();
            let mut section =
                blocks::section(&mut b.sel, "section/threads", &words::threads_title(EN))
                    .blocks(rows);
            if page.next.is_some() && term.is_empty() {
                section = section.next_page(&mut b.sel, "section/threads/next");
            }
            vec![section.into_block()]
        };

        let mut clear_item = blocks::menu_item(
            &mut b.sel,
            "menu/clear",
            &words::clear_action(EN),
            Handler::Open(CLEAR.to_owned()),
        );
        clear_item.destructive = true;
        let menu = blocks::menu(
            "threads/menu",
            vec![blocks::menu_section("", vec![clear_item])],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, THREADS)
            .title(&words::threads_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .menu_key(&mut b.sel, "key/menu", &words::threads_title(EN), menu)
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "next_page" {
            self.loaded = self.page_size().saturating_add(50);
        }
        Outcome::default()
    }
}

struct ThreadDetailRoom {
    id: String,
}

impl RoomScreen for ThreadDetailRoom {
    fn key(&self) -> String {
        format!("chat/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let thread = match b.run(&reads::THREAD_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => match ans.rows.into_iter().next() {
                Some(row) => row,
                None => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&words::title(EN))
                        .back(&mut b.sel, &words::threads_title(EN))
                        .failed(&mut b.sel, &shared::read_failed(EN), &shared::kit_retry(EN))
                        .build();
                }
            },
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::title(EN))
                    .back(&mut b.sel, &words::threads_title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let messages = b
            .run(&reads::MESSAGES, &Args::new().text("thread_id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let cards = b
            .run(
                &reads::MESSAGE_CARDS,
                &Args::new().text("thread_id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let attachments = b
            .run(
                &reads::MESSAGE_ATTACHMENTS,
                &Args::new().text("thread_id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut msg_blocks = Vec::new();
        for msg in &messages {
            let role_label = if msg.role == "user" {
                words::role_you(EN)
            } else {
                words::role_assistant(EN)
            };
            let outcome_chip = match msg.outcome.as_str() {
                "stopped" => Some((words::outcome_stopped(EN), wire::RoomTone::Neutral)),
                "refused" => Some((words::outcome_refused(EN), wire::RoomTone::Warning)),
                "proposed" => Some((words::outcome_proposed(EN), wire::RoomTone::Seam)),
                "applied" => Some((words::outcome_applied(EN), wire::RoomTone::Neutral)),
                "dismissed" => Some((words::outcome_dismissed(EN), wire::RoomTone::Neutral)),
                _ => None,
            };
            let mut row = blocks::still_row(&mut b.sel, &format!("msg/{}", msg.ordinal), &msg.text)
                .meta(&role_label);
            if let Some((chip_label, tone)) = outcome_chip {
                row = row.chip(blocks::chip(&chip_label, tone));
            }
            if msg.notice.as_deref() == Some("doc_truncated") {
                row = row.chip(blocks::chip(
                    &words::notice_truncated(EN),
                    wire::RoomTone::Seam,
                ));
            }
            msg_blocks.push(row.into_block());

            // S1b: live-resolved message attachments; NULL entity_id or deleted renders tombstone.
            for (idx, att) in attachments
                .iter()
                .filter(|a| a.ordinal == msg.ordinal)
                .enumerate()
            {
                let att_id = format!("msg/{}/att/{idx}", msg.ordinal);
                if att.form == "image" {
                    let label = att.label.as_deref().unwrap_or_default();
                    msg_blocks.push(
                        blocks::still_row(&mut b.sel, &att_id, label)
                            .meta(&att.form)
                            .into_block(),
                    );
                } else {
                    let live = att.entity_id.is_some() && att.entity_deleted_at.is_none();
                    if live {
                        let title = att
                            .entity_title
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .unwrap_or(&att.form);
                        let kind = att.entity_kind.as_deref().unwrap_or(&att.form);
                        let eid = att.entity_id.as_deref().unwrap_or_default();
                        if let Some(route) = entity_route(kind, eid) {
                            msg_blocks.push(
                                blocks::row(&mut b.sel, &att_id, title, Handler::Open(route))
                                    .meta(kind)
                                    .into_block(),
                            );
                        } else {
                            msg_blocks.push(
                                blocks::still_row(&mut b.sel, &att_id, title)
                                    .meta(kind)
                                    .into_block(),
                            );
                        }
                    } else {
                        let tombstone = if att.form == "photo" {
                            words::deleted_photo(EN)
                        } else {
                            words::deleted_item(EN)
                        };
                        msg_blocks.push(
                            blocks::still_row(&mut b.sel, &att_id, &tombstone)
                                .dimmed()
                                .into_block(),
                        );
                    }
                }
            }

            // S1, S2: live-resolved message cards; NULL entity_id or deleted renders tombstone.
            for (idx, card) in cards
                .iter()
                .filter(|c| c.ordinal == msg.ordinal)
                .enumerate()
            {
                let card_id = format!("msg/{}/card/{idx}", msg.ordinal);
                let live = card.entity_id.is_some() && card.entity_deleted_at.is_none();
                if live {
                    let title = card
                        .entity_title
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Untitled");
                    let kind = card.entity_kind.as_deref().unwrap_or_default();
                    let meta = match card.qualifier.as_deref() {
                        Some(q) if !kind.is_empty() => format!("{kind} · {q}"),
                        Some(q) => q.to_owned(),
                        None => kind.to_owned(),
                    };
                    let eid = card.entity_id.as_deref().unwrap_or_default();
                    if let Some(route) = entity_route(kind, eid) {
                        msg_blocks.push(
                            blocks::row(&mut b.sel, &card_id, title, Handler::Open(route))
                                .meta(&meta)
                                .into_block(),
                        );
                    } else {
                        msg_blocks.push(
                            blocks::still_row(&mut b.sel, &card_id, title)
                                .meta(&meta)
                                .into_block(),
                        );
                    }
                } else {
                    msg_blocks.push(
                        blocks::still_row(&mut b.sel, &card_id, &words::deleted_card(EN))
                            .dimmed()
                            .into_block(),
                    );
                }
            }
        }

        let mut blocks_out = Vec::new();
        if !msg_blocks.is_empty() {
            blocks_out.push(
                blocks::section(&mut b.sel, "section/messages", &words::messages_heading(EN))
                    .blocks(msg_blocks)
                    .into_block(),
            );
        }

        let composer_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "composer",
            &words::composer_label(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_COMPOSER,
        )
        .build();
        let dirty = !b.ui.fields.value("composer").unwrap_or_default().is_empty();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &words::composer_send(EN),
                save: Handler::Tag("chat:send".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("chat:clear_input".to_owned()),
                save_enabled: true,
                dirty,
                drafted: false,
            },
        );
        blocks_out.push(form::form(
            vec![composer_field],
            Vec::new(),
            Save::Explicit(save),
        ));

        let mut trash_item = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Act(Act::new("entity.trash", json!({ "ids": [self.id] }))),
        );
        trash_item.destructive = true;
        let menu = blocks::menu(
            "thread/menu",
            vec![blocks::menu_section("", vec![trash_item])],
            &mut b.sel,
        );

        let mut frame = room(wire::RoomKind::PushedPage, &self.key())
            .title(&thread.title)
            .back(&mut b.sel, &words::threads_title(EN))
            .menu_key(&mut b.sel, "key/menu", &words::title(EN), menu);
        if let Some(scope) = thread.scope.as_deref() {
            frame = frame.subtitle(scope);
        }
        frame.ready(blocks_out).build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        match tag {
            "chat:send" => {
                let text =
                    e.ui.fields
                        .value("composer")
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                if text.is_empty() {
                    return Outcome::refuse(&words::composer_empty(EN));
                }
                if let Some(f) = e.ui.fields.get_mut("composer") {
                    f.set("");
                }
                Outcome::say(&words::composer_queued(EN))
            }
            "chat:clear_input" => {
                if let Some(f) = e.ui.fields.get_mut("composer") {
                    f.set("");
                }
                Outcome::default()
            }
            _ => Outcome::default(),
        }
    }
}

struct ClearChatsConfirm;

impl RoomScreen for ClearChatsConfirm {
    fn key(&self) -> String {
        CLEAR.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::clear_title(EN),
                body: &words::clear_body(EN),
                warning: "",
                confirm_label: &words::clear_confirm(EN),
                confirm: Handler::Tag("chat:clear_all".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, CLEAR)
            .title(&words::clear_title(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "chat:clear_all" {
            return Outcome::default();
        }
        match e.door.act(&Act::new("thread.clear", json!({}))) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct ConceptsRoom;

impl RoomScreen for ConceptsRoom {
    fn key(&self) -> String {
        CONCEPTS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let touch_kinds = b
            .run(
                &reads::CONCEPTS_BY_KIND,
                &Args::new().text("kind", "touch_kind"),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let relations = b
            .run(
                &reads::CONCEPTS_BY_KIND,
                &Args::new().text("kind", "relation"),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let make_rows = |sel: &mut Sel, list: &[reads::ConceptRow]| -> Vec<wire::RoomBlock> {
            list.iter()
                .map(|c| {
                    let menu = blocks::menu(
                        &format!("concept/{}/menu", c.id),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    sel,
                                    &format!("concept/{}/rename", c.id),
                                    &words::concept_rename(EN),
                                    Handler::Open(format!("chat/concept/{}/rename", c.id)),
                                ),
                                blocks::menu_item(
                                    sel,
                                    &format!("concept/{}/merge", c.id),
                                    &words::concept_merge(EN),
                                    Handler::Open(format!("chat/concept/{}/merge", c.id)),
                                ),
                            ],
                        )],
                        sel,
                    );
                    blocks::row(
                        sel,
                        &format!("concept/{}", c.id),
                        &c.title,
                        Handler::Open(format!("chat/concept/{}/rename", c.id)),
                    )
                    .menu(menu)
                    .into_block()
                })
                .collect()
        };

        let touch_rows = make_rows(&mut b.sel, &touch_kinds);
        let rel_rows = make_rows(&mut b.sel, &relations);
        let mut blocks_out = Vec::new();
        if !touch_rows.is_empty() {
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/touch_kinds",
                    &words::touch_kinds_heading(EN),
                )
                .blocks(touch_rows)
                .into_block(),
            );
        }
        if !rel_rows.is_empty() {
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/relations",
                    &words::relations_heading(EN),
                )
                .blocks(rel_rows)
                .into_block(),
            );
        }

        room(wire::RoomKind::PushedPage, CONCEPTS)
            .title(&words::concepts_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

struct ConceptRenameForm {
    id: String,
    loaded: bool,
}

impl ConceptRenameForm {
    fn new(id: String) -> Self {
        Self { id, loaded: false }
    }
}

impl RoomScreen for ConceptRenameForm {
    fn key(&self) -> String {
        format!("chat/concept/{}/rename", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            if let Ok(ans) = b.run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id))
                && let Some(meta) = ans.rows.into_iter().next()
            {
                b.ui.fields.get_or("name", &meta.title);
            }
            self.loaded = true;
        }
        let field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::concept_name_label(EN),
            wire::RoomTextKind::Line,
            "",
            40,
        )
        .focused()
        .build();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("concept:rename".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: true,
                drafted: false,
            },
        );
        let form_block = form::form(vec![field], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::concept_rename_title(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "concept:rename" {
            return Outcome::default();
        }
        let name =
            e.ui.fields
                .value("name")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if name.is_empty() {
            return Outcome::refuse(&shared::write_refused(EN));
        }
        match e.door.act(&Act::new(
            "entity.retitle",
            json!({ "id": self.id, "title": name }),
        )) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct ConceptMergePick {
    id: String,
}

impl RoomScreen for ConceptMergePick {
    fn key(&self) -> String {
        format!("chat/concept/{}/merge", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let kind = b
            .run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.kind)
            .unwrap_or_else(|| "touch_kind".to_owned());
        let siblings = b
            .run(&reads::CONCEPTS_BY_KIND, &Args::new().text("kind", &kind))
            .map(|a| a.rows)
            .unwrap_or_default();
        let rows: Vec<wire::RoomBlock> = siblings
            .iter()
            .filter(|c| c.id != self.id)
            .map(|c| {
                blocks::row(
                    &mut b.sel,
                    &format!("target/{}", c.id),
                    &c.title,
                    Handler::Open(format!("chat/concept/{}/merge/{}", self.id, c.id)),
                )
                .into_block()
            })
            .collect();
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::concept_merge_pick_title(EN))
            .back(&mut b.sel, &words::concepts_title(EN))
            .ready(vec![
                blocks::section(
                    &mut b.sel,
                    "section/targets",
                    &words::concept_merge_pick_title(EN),
                )
                .blocks(rows)
                .into_block(),
            ])
            .build()
    }
}

struct ConceptMergeConfirm {
    from: String,
    into: String,
}

impl RoomScreen for ConceptMergeConfirm {
    fn key(&self) -> String {
        format!("chat/concept/{}/merge/{}", self.from, self.into)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_title = b
            .run(
                &entity_reads::META_BY_ID,
                &Args::new().text("id", &self.from),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| self.from.clone());
        let into_title = b
            .run(
                &entity_reads::META_BY_ID,
                &Args::new().text("id", &self.into),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| self.into.clone());
        let body = fill(
            &words::concept_merge_body(EN),
            &[("from", &from_title), ("into", &into_title)],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::concept_merge_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::concept_merge_confirm(EN),
                confirm: Handler::Tag("concept:merge".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::concept_merge_title(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "concept:merge" {
            return Outcome::default();
        }
        match e.door.act(&Act::new(
            "concept.merge",
            json!({ "from": self.from, "into": self.into }),
        )) {
            Ok(_) => Outcome::replace(CONCEPTS),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}
