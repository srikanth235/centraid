use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{
    calendar as cal_reads, entity as entity_reads, reminders as task_reads,
};
use centraid_domain::read::Args;

use super::blocks::{self, glyph};
use super::calendar;
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

const SEARCH_ENTITY_KINDS: &[&str] = &[
    "person", "event", "task", "txn", "account", "note", "document", "photo", "workout",
];
const SEARCH_CONTAINER_KINDS: &[&str] = &[
    "calendar",
    "task_list",
    "notebook",
    "folder",
    "album",
    "list",
];

#[must_use]
pub fn registry() -> Registry {
    Registry::new().exact(HOME, || Box::new(Home))
}

fn epoch_ms_to_ymd(ms: i64) -> (i32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year as i32, m as u32, d as u32)
}

fn today_iso(now_ms: i64) -> String {
    let (y, m, d) = epoch_ms_to_ymd(now_ms);
    format!("{y:04}-{m:02}-{d:02}")
}

fn week_before(now_ms: i64) -> String {
    today_iso(now_ms - 7 * 86_400_000)
}

fn next_day(now_ms: i64) -> String {
    today_iso(now_ms + 86_400_000)
}

fn edit_distance_le_1(a: &str, b: &str) -> bool {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let (al, bl) = (ac.len(), bc.len());
    if al.abs_diff(bl) > 1 {
        return false;
    }
    if al == bl {
        let mut diffs = 0;
        let mut i = 0;
        while i < al {
            if ac[i] != bc[i] {
                if i + 1 < al && ac[i] == bc[i + 1] && ac[i + 1] == bc[i] {
                    diffs += 1;
                    i += 2;
                    continue;
                }
                diffs += 1;
            }
            i += 1;
        }
        return diffs == 1;
    }
    let (short, long) = if al < bl { (&ac, &bc) } else { (&bc, &ac) };
    let (mut i, mut j, mut skipped) = (0, 0, false);
    while i < short.len() && j < long.len() {
        if short[i] == long[j] {
            i += 1;
            j += 1;
        } else if !skipped {
            skipped = true;
            j += 1;
        } else {
            return false;
        }
    }
    true
}

fn suggest_correction(term: &str, titles: &[String]) -> Option<String> {
    let needle = term.trim().to_ascii_lowercase();
    if needle.chars().count() < 4 || needle.contains(char::is_whitespace) {
        return None;
    }
    let mut best: Option<String> = None;
    for title in titles {
        for raw_word in title.split(|c: char| !c.is_alphanumeric()) {
            let word = raw_word.to_ascii_lowercase();
            if word.chars().count() < 4 || word == needle {
                continue;
            }
            if edit_distance_le_1(&needle, &word) {
                match &best {
                    Some(cur) if cur <= &word => {}
                    _ => best = Some(word),
                }
            }
        }
    }
    best
}

fn route_for_entity(kind: &str, id: &str) -> String {
    match kind {
        "person" => format!("person/{id}"),
        "event" => format!("calendar/event/{id}"),
        "task" => format!("reminders/task/{id}"),
        "txn" => format!("money/txn/{id}"),
        "account" => format!("money/account/{id}"),
        "note" => NOTES.to_owned(),
        "document" => DOCS.to_owned(),
        "photo" => PHOTOS.to_owned(),
        "workout" => HEALTH.to_owned(),
        _ => HOME.to_owned(),
    }
}

fn route_for_container(kind: &str, id: &str) -> String {
    match kind {
        "calendar" => calendar::CALENDARS.to_owned(),
        "task_list" => format!("reminders/list/{id}"),
        "list" => format!("people/list/{id}"),
        "notebook" => NOTES.to_owned(),
        "folder" => DOCS.to_owned(),
        "album" => PHOTOS.to_owned(),
        _ => HOME.to_owned(),
    }
}

fn kind_label(kind: &str) -> String {
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
        let now = b.door.now_ms();
        let day = today_iso(now);
        let low = week_before(now);
        let from = format!("{day}T00:00:00.000Z");
        let to = format!("{}T00:00:00.000Z", next_day(now));
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
        } else if b.door.permission_refused("people") {
            home_words::tile_contacts_refused(EN)
        } else {
            home_words::tile_empty_people(EN)
        };
        let money_line = if has_money {
            home_words::tile_quiet_money(EN)
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
                Handler::Open(HEALTH.to_owned()),
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
        if !has && b.door.permission_refused(store) {
            refused.to_owned()
        } else if has {
            quiet.to_owned()
        } else {
            teach.to_owned()
        }
    }

    fn widget_handler(&self, b: &Build<'_>, store: &str, has: bool, app: &str) -> Handler {
        if !has && b.door.permission_refused(store) {
            Handler::Tag(format!("open_settings:{store}"))
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
        b.watch(&["entity"]);
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
        let blocks_out = if b.ui.search_open() && !term.is_empty() {
            let mut all_entities = Vec::new();
            for kind in SEARCH_ENTITY_KINDS {
                if let Ok(ans) = b.run(
                    &entity_reads::BY_KIND_RECENT,
                    &Args::new().text("kind", *kind),
                ) {
                    all_entities.extend(ans.rows);
                }
            }
            let mut all_containers = Vec::new();
            for kind in SEARCH_CONTAINER_KINDS {
                if let Ok(ans) = b.run(
                    &entity_reads::CONTAINERS_BY_KIND,
                    &Args::new().text("kind", *kind),
                ) {
                    all_containers.extend(ans.rows);
                }
            }

            let needle = term.to_ascii_lowercase();
            let mut matched_entities: Vec<&entity_reads::EntitySearchRow> = all_entities
                .iter()
                .filter(|e| e.title.to_ascii_lowercase().contains(&needle))
                .collect();
            let mut matched_containers: Vec<&entity_reads::ContainerRow> = all_containers
                .iter()
                .filter(|c| c.title.to_ascii_lowercase().contains(&needle))
                .collect();

            if matched_entities.is_empty() && matched_containers.is_empty() {
                let vocab: Vec<String> = all_entities
                    .iter()
                    .map(|e| e.title.clone())
                    .chain(all_containers.iter().map(|c| c.title.clone()))
                    .collect();
                if let Some(corrected) = suggest_correction(&term, &vocab) {
                    search_slot.corrected =
                        fill(&shared::search_corrected(EN), &[("corrected", &corrected)]);
                    matched_entities = all_entities
                        .iter()
                        .filter(|e| e.title.to_ascii_lowercase().contains(&corrected))
                        .collect();
                    matched_containers = all_containers
                        .iter()
                        .filter(|c| c.title.to_ascii_lowercase().contains(&corrected))
                        .collect();
                }
            }

            for c in &matched_containers {
                search_slot.containers.push(
                    blocks::row(
                        &mut b.sel,
                        &format!("search/container/{}", c.id),
                        &c.title,
                        Handler::Open(route_for_container(&c.kind, &c.id)),
                    )
                    .meta(&kind_label(&c.kind))
                    .build(),
                );
            }
            search_slot.ask = Some(
                blocks::row(
                    &mut b.sel,
                    "search/ask",
                    &fill(&shared::search_ask_about(EN), &[("term", &term)]),
                    Handler::Open(CHAT.to_owned()),
                )
                .mark(blocks::glyph_mark("NewChat", ""))
                .build(),
            );

            if matched_entities.is_empty() && matched_containers.is_empty() {
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
                let mut by_kind: BTreeMap<String, Vec<&entity_reads::EntitySearchRow>> =
                    BTreeMap::new();
                for row in matched_entities {
                    by_kind.entry(row.kind.clone()).or_default().push(row);
                }
                let mut sections = Vec::new();
                for (kind, rows) in by_kind {
                    let heading = kind_label(&kind);
                    let row_blocks: Vec<wire::RoomBlock> = rows
                        .into_iter()
                        .take(10)
                        .map(|r| {
                            blocks::row(
                                &mut b.sel,
                                &format!("search/hit/{}", r.id),
                                &r.title,
                                Handler::Open(route_for_entity(&r.kind, &r.id)),
                            )
                            .meta(&heading)
                            .into_block()
                        })
                        .collect();
                    sections.push(
                        blocks::section(&mut b.sel, &format!("search/section/{kind}"), &heading)
                            .blocks(row_blocks)
                            .into_block(),
                    );
                }
                sections
            }
        } else {
            self.widgets(b)
        };

        let mut built = room(wire::RoomKind::Home, HOME)
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
            .band(band)
            .ready(blocks_out)
            .build();
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
            tag if tag.starts_with("go:") => Outcome::push(&tag["go:".len()..]),
            _ => Outcome::default(),
        }
    }
}
