use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{
    calendar as cal_reads, entity as entity_reads, reminders as task_reads,
};
use centraid_domain::read::Args;

use super::blocks::{self, glyph};
use super::calendar;
use super::door::Door;
use super::first;
use super::frame::{self, room};
use super::money;
use super::people;
use super::reminders;
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::Handler;
use super::shell::{self, BACKUP, HOME, SETTINGS};
use crate::strings::{
    Locale, fill, home as home_words, room as words, settings as settings_words, shared,
};

pub const CHAT: &str = "chat";
pub const NOTES: &str = "notes";
pub const DOCS: &str = "docs";
pub const PHOTOS: &str = "photos";
pub const HEALTH: &str = "health";
pub const LOCKER: &str = "locker";

const EN: Locale = Locale::En;
const BACKUP_TABLES: [&str; 2] = ["backup", "blob"];

#[must_use]
pub fn registry() -> Registry {
    Registry::new().exact(HOME, || Box::new(Home))
}

pub(super) fn route_for_entity(kind: &str, id: &str) -> String {
    match kind {
        "person" => format!("person/{id}"),
        "event" => format!("calendar/event/{id}"),
        "task" => format!("reminders/task/{id}"),
        "txn" => format!("money/txn/{id}"),
        "account" => format!("money/account/{id}"),
        "note" => format!("notes/note/{id}"),
        "document" => format!("docs/doc/{id}"),
        "photo" => format!("photos/photo/{id}"),
        "workout" => format!("health/workout/{id}"),
        "thread" => format!("chat/{id}"),
        "place" => format!("photos/place/{id}"),
        "locker_item" => format!("locker/item/{id}"),
        "notebook" | "folder" | "album" | "calendar" | "task_list" | "list" => {
            route_for_container(kind, id)
        }
        _ => HOME.to_owned(),
    }
}

pub(super) fn route_for_versions(kind: &str, id: &str) -> String {
    match kind {
        "person" => format!("person/{id}/versions"),
        "event" => format!("calendar/event/{id}/versions"),
        "task" => format!("reminders/task/{id}/versions"),
        "txn" => format!("money/txn/{id}/versions"),
        "note" => format!("notes/note/{id}/versions"),
        "document" => format!("docs/doc/{id}/versions"),
        "photo" => format!("photos/photo/{id}/versions"),
        "workout" => format!("health/workout/{id}/versions"),
        "locker_item" => format!("locker/item/{id}/versions"),
        _ => route_for_entity(kind, id),
    }
}

fn route_for_container(kind: &str, id: &str) -> String {
    match kind {
        "calendar" => format!("calendar/calendar/{id}"),
        "task_list" => format!("reminders/list/{id}"),
        "list" => format!("people/list/{id}"),
        "notebook" => format!("notes/notebook/{id}"),
        "folder" => format!("docs/folder/{id}"),
        "album" => format!("photos/album/{id}"),
        _ => HOME.to_owned(),
    }
}

pub(super) fn kind_label(kind: &str) -> String {
    match kind {
        "person" => home_words::search_kind_person(EN),
        "event" => home_words::search_kind_event(EN),
        "task" => home_words::search_kind_task(EN),
        "txn" => home_words::search_kind_transaction(EN),
        "account" => words::home_money_tile(EN),
        "note" => home_words::search_kind_note(EN),
        "document" => home_words::search_kind_document(EN),
        "photo" => home_words::search_kind_photo(EN),
        "workout" => home_words::search_kind_workout(EN),
        "place" => home_words::app_photos(EN),
        "thread" => home_words::band_chat(EN),
        "locker_item" => words::home_locker_tile(EN),
        "calendar" => home_words::app_calendar(EN),
        "task_list" => home_words::app_reminders(EN),
        "notebook" => shared::search_kind_notebook(EN),
        "folder" => shared::search_kind_folder(EN),
        "album" => shared::search_kind_album(EN),
        _ => kind.to_owned(),
    }
}

struct Home;

impl Home {
    fn widgets(&mut self, b: &mut Build<'_>) -> Vec<wire::RoomBlock> {
        let day = b.door.today();
        let low = b.door.shift_day(&day, -7);
        let next = b.door.shift_day(&day, 1);
        let from = b.door.day_start(&day);
        let to = b.door.day_start(&next);
        let floating_from = format!("{day}T00:00");
        let floating_to = format!("{day}T23:59");
        let day_one = first::day_one(b);
        let has_events = first::holds(b, "event");
        let has_tasks = first::holds(b, "task");
        let has_photos = first::holds(b, "photo");
        let has_people = first::holds(b, "person");
        let has_money = first::holds(b, "txn");
        let has_health = first::holds(b, "workout");
        let has_notes = first::holds(b, "note");
        let has_docs = first::holds(b, "document");
        let has_locker = first::holds(b, "locker_item");

        let mut events: Vec<String> = Vec::new();
        if let Ok(short) = b.run(
            &cal_reads::TODAY_SHORT,
            &Args::new()
                .day("day", &day)
                .text("from", &from)
                .text("to", &to)
                .text("floating_from", &floating_from)
                .text("floating_to", &floating_to)
                .text("low", &low)
                .text("high", &to),
        ) {
            events.extend(short.rows.into_iter().take(2).map(|ev| ev.title));
        }
        let mut tasks: Vec<String> = Vec::new();
        if let Ok(due) = b.run(
            &task_reads::TODAY_DUE,
            &Args::new()
                .day("day", &day)
                .text("from", &from)
                .text("to", &to)
                .text("floating_from", &floating_from)
                .text("floating_to", &floating_to)
                .text("low", &day)
                .text("high", &to),
        ) {
            tasks.extend(due.rows.into_iter().take(2).map(|t| t.title));
        }

        let mut out = Vec::new();
        if day_one {
            out.push(blocks::prose(&home_words::home_welcome(EN)));
        }

        let calendar_lines = if events.is_empty() {
            vec![self.empty_line(
                b,
                "calendar",
                has_events,
                &home_words::tile_quiet_calendar(EN),
                &home_words::tile_empty_calendar(EN),
                &home_words::tile_calendar_refused(EN),
            )]
        } else {
            events
        };
        let calendar_refs: Vec<&str> = calendar_lines.iter().map(String::as_str).collect();
        let h_cal = self.widget_handler(b, "calendar", has_events, calendar::CALENDAR);
        out.push(blocks::glance(
            &mut b.sel,
            "tile/calendar",
            &home_words::app_calendar(EN),
            &calendar_refs,
            glyph("Calendar", ""),
            h_cal,
        ));

        let reminders_empty = if b.door.reminders_source() {
            home_words::tile_empty_reminders(EN)
        } else {
            home_words::tile_empty_reminders_by_hand(EN)
        };
        let reminder_lines = if tasks.is_empty() {
            vec![self.empty_line(
                b,
                "reminders",
                has_tasks,
                &words::widget_nothing(EN),
                &reminders_empty,
                &home_words::tile_reminders_refused(EN),
            )]
        } else {
            tasks
        };
        let reminder_refs: Vec<&str> = reminder_lines.iter().map(String::as_str).collect();
        let h_rem = self.widget_handler(b, "reminders", has_tasks, reminders::REMINDERS);
        out.push(blocks::glance(
            &mut b.sel,
            "tile/reminders",
            &home_words::app_reminders(EN),
            &reminder_refs,
            glyph("Check", ""),
            h_rem,
        ));

        let photos_line = self.empty_line(
            b,
            "photos",
            has_photos,
            &home_words::app_photos(EN),
            &home_words::tile_empty_photos(EN),
            &home_words::tile_photos_refused(EN),
        );
        let h_photo = self.widget_handler(b, "photos", has_photos, PHOTOS);
        out.push(blocks::glance(
            &mut b.sel,
            "tile/photos",
            &home_words::app_photos(EN),
            &[photos_line.as_str()],
            glyph("Image", ""),
            h_photo,
        ));

        let counted = |n: usize, one: String, many: String| {
            format!("{n} {}", if n == 1 { one } else { many })
        };
        let people_line = if has_people {
            counted(
                first::count(b, "person"),
                home_words::tile_people_count_one(EN),
                home_words::tile_people_count_many(EN),
            )
        } else if first::refused(b.door, "people") {
            home_words::tile_contacts_refused(EN)
        } else {
            home_words::tile_empty_people(EN)
        };
        let money_line = if has_money {
            money::month_spend(b, b.door.now_ms())
        } else {
            home_words::tile_empty_money(EN)
        };
        let health_line = if has_health {
            home_words::app_health(EN)
        } else if b.door.reminders_source() {
            home_words::tile_empty_health(EN)
        } else {
            home_words::tile_empty_health_connect(EN)
        };
        let locker_line = if has_locker {
            home_words::tile_locker_locked(EN)
        } else {
            home_words::tile_empty_locker(EN)
        };
        let notes_line = if has_notes {
            counted(
                first::count(b, "note"),
                home_words::tile_notes_count_one(EN),
                home_words::tile_notes_count_many(EN),
            )
        } else {
            home_words::tile_empty_notes(EN)
        };
        let docs_line = if has_docs {
            counted(
                first::count(b, "document"),
                home_words::tile_docs_count_one(EN),
                home_words::tile_docs_count_many(EN),
            )
        } else {
            home_words::tile_empty_docs(EN)
        };
        let health_handler = self.widget_handler(b, "health", has_health, HEALTH);
        let people_handler = self.widget_handler(b, "people", has_people, people::PEOPLE);
        out.push(blocks::tiles(vec![
            blocks::tile(
                &mut b.sel,
                "tile/money",
                &words::home_money_tile(EN),
                &money_line,
                glyph("Coin", ""),
                Handler::Open(money::MONEY.to_owned()),
            ),
            blocks::tile(
                &mut b.sel,
                "tile/health",
                &words::home_health_tile(EN),
                &health_line,
                glyph("Heart", ""),
                health_handler,
            ),
            blocks::tile(
                &mut b.sel,
                "tile/people",
                &words::home_people_tile(EN),
                &people_line,
                glyph("Users", ""),
                people_handler,
            ),
            blocks::tile(
                &mut b.sel,
                "tile/locker",
                &words::home_locker_tile(EN),
                &locker_line,
                glyph("Lock", ""),
                Handler::Open(LOCKER.to_owned()),
            ),
            blocks::tile(
                &mut b.sel,
                "tile/notes",
                &words::home_notes_tile(EN),
                &notes_line,
                glyph("Journal", ""),
                Handler::Open(NOTES.to_owned()),
            ),
            blocks::tile(
                &mut b.sel,
                "tile/docs",
                &words::home_docs_tile(EN),
                &docs_line,
                glyph("FileText", ""),
                Handler::Open(DOCS.to_owned()),
            ),
        ]));
        out
    }

    fn empty_line(
        &self,
        b: &Build<'_>,
        store: &str,
        has: bool,
        quiet: &str,
        teach: &str,
        refused: &str,
    ) -> String {
        if !has && first::refused(b.door, store) {
            refused.to_owned()
        } else if has {
            quiet.to_owned()
        } else {
            teach.to_owned()
        }
    }

    fn importable(&self, b: &Build<'_>, store: &str) -> bool {
        store != "reminders" || b.door.reminders_source()
    }

    fn widget_handler(&self, b: &Build<'_>, store: &str, has: bool, app: &str) -> Handler {
        if has {
            Handler::Open(app.to_owned())
        } else if first::refused(b.door, store) {
            first::settings(store)
        } else if self.importable(b, store) {
            first::import(store)
        } else {
            Handler::Open(app.to_owned())
        }
    }

    fn backup_status(&self, b: &mut Build<'_>) -> String {
        let Ok((line, reading, now)) = shell::the_line(b.door) else {
            return String::new();
        };
        if !reading.destinations.is_empty() {
            return line.status;
        }
        if crate::backup::line::pair_owed(&reading, now) {
            format!(
                "{} · {}",
                home_words::home_backup_unpaired_status(EN),
                home_words::home_backup_unpaired_action(EN)
            )
        } else {
            String::new()
        }
    }
}

impl RoomScreen for Home {
    fn key(&self) -> String {
        HOME.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        b.watch(&BACKUP_TABLES);
        b.watch(&["entity", centraid_core::vaults::SHELF_TABLE]);
        if !first::welcomed(b.door) && first::day_one(b) {
            return first::welcome(b);
        }
        let vault_title = b
            .run(&entity_reads::VAULT_INFO, &Args::new())
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|v| v.name)
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| words::home_title(EN));

        let backup_status = self.backup_status(b);

        let tabs = vec![
            frame::tab(
                &mut b.sel,
                "tab/home",
                &home_words::band_home(EN),
                "Home",
                true,
            ),
            frame::tab(
                &mut b.sel,
                "tab/chat",
                &home_words::band_chat(EN),
                "NewChat",
                false,
            ),
            frame::tab(
                &mut b.sel,
                "tab/backup",
                &home_words::band_backup(EN),
                "Backup",
                false,
            ),
        ];
        let band = frame::band(tabs, None, Some(Handler::SearchOpen), &mut b.sel);

        let mut search_slot = wire::RoomSearch {
            open: b.ui.search_open(),
            selector_id: b.sel.on(
                "search",
                if b.ui.search_open() {
                    Handler::SearchTerm
                } else {
                    Handler::SearchOpen
                },
            ),
            term: b.ui.search_term().to_owned(),
            placeholder: home_words::home_search_placeholder(EN),
            corrected: String::new(),
            close_selector_id: if b.ui.search_open() {
                b.sel.on("search/close", Handler::SearchClose)
            } else {
                String::new()
            },
            containers: Vec::new(),
            ask: None,
        };

        let term = b.ui.search_term().trim().to_owned();
        let mut search_failure = None;
        if b.ui.search_open() {
            // Home's FTS results derive from entity/item text; a write must invalidate every
            // cached page before the rebuilt room is shown.
            b.watch(&centraid_vault::model::HOST_TABLES);
        }
        if b.ui.search_open() && !term.is_empty() {
            let container_kinds: Vec<String> = centraid_vault::model::Kind::CONTAINERS
                .into_iter()
                .filter(|kind| centraid_vault::model::Kind::SEARCHABLE.contains(kind))
                .map(|kind| kind.as_str().to_owned())
                .collect();
            let request = centraid_search::SearchRequest::across(container_kinds, term.clone(), 50);
            match b.door.search_page(&request) {
                Ok(centraid_search::Answer::Data { page, .. }) => {
                    search_slot.containers = page
                        .rows
                        .into_iter()
                        .map(|target| {
                            blocks::row(
                                &mut b.sel,
                                &format!("search/container/{}", target.id),
                                &target.title,
                                Handler::Open(route_for_entity(&target.entity, &target.id)),
                            )
                            .meta(&kind_label(&target.entity))
                            .build()
                        })
                        .collect();
                }
                Ok(centraid_search::Answer::Denied(_)) => {
                    search_failure = Some("Search is unavailable right now. Try again.".to_owned());
                }
                Err(_) => {
                    search_failure = Some("Search is unavailable right now. Try again.".to_owned());
                }
            }
            if search_failure.is_none() {
                match super::search_view::unindexed_title_rows(b, &["list", "calendar"], &term) {
                    Ok(rows) => search_slot.containers.extend(rows),
                    Err(error) => search_failure = Some(error),
                }
            }
        }
        let blocks_out = if b.ui.search_open() && !term.is_empty() {
            b.ui.begin_search(&term);
            if !b.ui.search_page_loaded() && search_failure.is_none() {
                let run_page =
                    |door: &dyn Door,
                     query: &str,
                     after: Option<centraid_domain::page::PageCursor>| {
                        let mut request = centraid_search::SearchRequest::across(
                            Vec::<String>::new(),
                            query.to_owned(),
                            10,
                        );
                        request.page.after = after;
                        door.search_page(&request)
                    };
                let after = b.ui.search_after().cloned();
                let query = b.ui.search_applied().to_owned();
                match run_page(b.door, &query, after) {
                    Ok(centraid_search::Answer::Data { page, .. }) => {
                        if page.rows.is_empty()
                            && b.ui.search_after().is_none()
                            && b.ui.search_corrected().is_empty()
                        {
                            match b.door.search_correction(&[], &term, false) {
                                Ok(Some(corrected)) => {
                                    b.ui.set_search_correction(&corrected);
                                    search_slot.corrected = fill(
                                        &shared::search_corrected(EN),
                                        &[("corrected", &corrected)],
                                    );
                                    match run_page(b.door, &corrected, None) {
                                        Ok(centraid_search::Answer::Data { page, .. }) => {
                                            b.ui.append_search_page(page.rows, page.next);
                                        }
                                        Ok(centraid_search::Answer::Denied(_)) => {
                                            search_failure = Some(
                                                "Search is unavailable right now. Try again."
                                                    .to_owned(),
                                            );
                                        }
                                        Err(error) => search_failure = Some(error.0),
                                    }
                                }
                                Ok(None) => b.ui.append_search_page(page.rows, page.next),
                                Err(error) => search_failure = Some(error.0),
                            }
                        } else {
                            b.ui.append_search_page(page.rows, page.next);
                        }
                    }
                    Ok(centraid_search::Answer::Denied(_)) => {
                        search_failure =
                            Some("Search is unavailable right now. Try again.".to_owned());
                    }
                    Err(error) => search_failure = Some(error.0),
                }
            }
            if !b.ui.search_corrected().is_empty() {
                search_slot.corrected = fill(
                    &shared::search_corrected(EN),
                    &[("corrected", b.ui.search_corrected())],
                );
            }
            search_slot.ask = Some(
                blocks::row(
                    &mut b.sel,
                    "search/ask",
                    &fill(&shared::search_ask_about(EN), &[("term", &term)]),
                    Handler::Ask(term.clone()),
                )
                .mark(blocks::glyph_mark("NewChat", ""))
                .build(),
            );

            if b.ui.search_hits().is_empty() && search_slot.containers.is_empty() {
                vec![blocks::empty(
                    glyph("Search", ""),
                    &home_words::home_search_no_match_headline(EN),
                    &fill(
                        &home_words::home_search_no_match_body(EN),
                        &[("term", &term)],
                    ),
                    None,
                )]
            } else {
                let mut by_kind: BTreeMap<String, Vec<centraid_search::Target>> = BTreeMap::new();
                for row in b.ui.search_hits().iter().cloned() {
                    if matches!(
                        row.entity.as_str(),
                        "notebook" | "folder" | "album" | "calendar" | "task_list" | "list"
                    ) {
                        continue;
                    }
                    by_kind.entry(row.entity.clone()).or_default().push(row);
                }
                let mut sections = Vec::new();
                let kinds: Vec<String> = by_kind.keys().cloned().collect();
                for (section_index, (kind, rows)) in by_kind.into_iter().enumerate() {
                    let heading = kind_label(&kind);
                    let row_blocks: Vec<wire::RoomBlock> = rows
                        .into_iter()
                        .map(|r| {
                            blocks::row(
                                &mut b.sel,
                                &format!("search/hit/{}", r.id),
                                &r.title,
                                Handler::Open(if r.in_earlier_version {
                                    route_for_versions(&r.entity, &r.id)
                                } else {
                                    route_for_entity(&r.entity, &r.id)
                                }),
                            )
                            .meta(if r.in_earlier_version {
                                "In an earlier version"
                            } else if r.snippet.is_empty() {
                                heading.as_str()
                            } else {
                                &r.snippet
                            })
                            .into_block()
                        })
                        .collect();
                    let section =
                        blocks::section(&mut b.sel, &format!("search/section/{kind}"), &heading)
                            .blocks(row_blocks);
                    let section =
                        if section_index + 1 == kinds.len() && b.ui.search_next().is_some() {
                            section.next_page(&mut b.sel, "search/more")
                        } else {
                            section
                        };
                    sections.push(section.into_block());
                }
                sections
            }
        } else {
            self.widgets(b)
        };

        let builder = room(wire::RoomKind::Home, HOME)
            .title(&vault_title)
            .subtitle(&backup_status)
            .key(
                &mut b.sel,
                "tile/settings",
                wire::RoomKeyRole::Verb,
                "Settings",
                &settings_words::settings_title(EN),
                Handler::Open(SETTINGS.to_owned()),
            )
            .band(band);
        let mut built = if let Some(sentence) = search_failure.as_deref() {
            builder
                .failed(&mut b.sel, sentence, &shared::kit_retry(EN))
                .build()
        } else {
            builder.ready(blocks_out).build()
        };
        built.search = Some(search_slot);
        built
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        match tag {
            "tab:tab/backup" | "tab/backup" => Outcome::push(BACKUP),
            "tab:tab/chat" | "tab/chat" => Outcome::push(CHAT),
            first::START => {
                first::mark_welcomed(e.door);
                Outcome::replace(HOME)
            }
            tag if tag.starts_with("next:search/section/") => {
                e.ui.advance_search_page();
                Outcome::default()
            }
            tag if tag.starts_with("go:") => Outcome::push(&tag["go:".len()..]),
            _ => Outcome::default(),
        }
    }
}
