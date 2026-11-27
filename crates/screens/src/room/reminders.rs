use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity as entity_reads, reminders as reads};
use centraid_domain::read::Args;
use serde_json::{Map, Value, json};

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::first;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, fill, home as home_words, reminders as words, shared};

pub const REMINDERS: &str = "reminders";
pub const NEW_TASK: &str = "reminders/new";
pub const NEW_LIST: &str = "reminders/lists/new";
pub const TRASH: &str = "reminders/trash";

const EN: Locale = Locale::En;
const VIEW_PREF_KEY: &str = "view.reminders";
const MAX_TEXT: usize = 300;
const MAX_NOTES: usize = 4_000;

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(REMINDERS, || Box::new(RemindersRoot::default()))
        .exact(NEW_TASK, || Box::new(TaskForm::new_task(None, false)))
        .exact(NEW_LIST, || Box::new(NewListForm::default()))
        .exact(TRASH, || Box::new(RemindersTrash::default()))
        .exact("reminders/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("reminders/new/list/") {
                return Some(Box::new(TaskForm::new_task(Some(id.to_owned()), false)));
            }
            if let Some(id) = key.strip_prefix("reminders/new/subtask/") {
                return Some(Box::new(TaskForm::new_task(Some(id.to_owned()), true)));
            }
            if let Some(id) = key.strip_prefix("reminders/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("reminders/list/") {
                if let Some(id) = rest.strip_suffix("/trash-confirm") {
                    return Some(Box::new(TrashListConfirm { id: id.to_owned() }));
                }
                return Some(Box::new(TaskListDetail {
                    id: rest.to_owned(),
                    loaded: 50,
                }));
            }
            if let Some(rest) = key.strip_prefix("reminders/task/") {
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(TaskForm::edit_task(id.to_owned())));
                }
                return Some(Box::new(TaskDetailRoom {
                    id: rest.to_owned(),
                }));
            }
            None
        }))
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

fn tomorrow_iso(now_ms: i64) -> String {
    today_iso(now_ms + 86_400_000)
}

fn load_smart_list(door: &dyn Door) -> String {
    door.device_get(VIEW_PREF_KEY)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("list").and_then(Value::as_str).map(str::to_owned))
        .filter(|s| {
            matches!(
                s.as_str(),
                "today" | "scheduled" | "all" | "starred" | "completed"
            )
        })
        .unwrap_or_else(|| "today".to_owned())
}

fn save_smart_list(door: &dyn Door, list: &str) {
    let _ = door.device_put(VIEW_PREF_KEY, &json!({ "v": 1, "list": list }).to_string());
}

fn draft_key(door: &dyn Door) -> Option<String> {
    let vault = door.vault_id();
    (!vault.is_empty()).then(|| format!("draft.{vault}.task"))
}

fn reminders_band(sel: &mut Sel) -> wire::RoomBand {
    let tabs = vec![frame::tab(
        sel,
        "tab/reminders",
        &words::tab_reminders(EN),
        "Check",
        true,
    )];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let more_items = vec![
        blocks::menu_item(
            sel,
            "more/following",
            &words::more_following(EN),
            Handler::Tag("more:following".to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/export",
            &words::more_export(EN),
            Handler::Tag("more:export".to_owned()),
        ),
        more_trash,
    ];
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let mut band = frame::band(
        tabs,
        Some(Handler::Tag("nav:home".to_owned())),
        Some(Handler::SearchOpen),
        sel,
    );
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn task_row(
    sel: &mut Sel,
    task: &reads::TaskSummary,
    today: &str,
    snooze_until: &str,
    prefix: &str,
) -> wire::RoomBlock {
    let id = &task.id;
    let is_done = task.status == "done";
    let starred = task.starred_at.is_some();
    let check_act = if is_done {
        Act::new("task.reopen", json!({ "id": id }))
    } else {
        Act::new("task.complete", json!({ "id": id }))
    };
    let star_act = if starred {
        Act::new(
            "flag.clear/starred",
            json!({ "flag": "starred", "ids": [id] }),
        )
    } else {
        Act::new(
            "flag.set/starred",
            json!({ "flag": "starred", "ids": [id] }),
        )
    };
    let mut trash = blocks::menu_item(
        sel,
        &format!("{prefix}/{id}/menu/trash"),
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
    );
    trash.destructive = true;
    let done_label = if is_done {
        words::action_reopen(EN)
    } else {
        words::action_done(EN)
    };
    let star_label = if starred {
        words::action_unstar(EN)
    } else {
        words::action_star(EN)
    };
    let mut menu_items = vec![
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/open"),
            &shared::kit_open(EN),
            Handler::Open(format!("reminders/task/{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/done"),
            &done_label,
            Handler::Act(check_act.clone()),
        ),
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/star"),
            &star_label,
            Handler::Act(star_act),
        ),
    ];
    if !is_done && task.due.is_some() {
        menu_items.push(blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/snooze"),
            &words::action_snooze(EN),
            Handler::Act(Act::new(
                "alert.snooze",
                json!({ "entity_id": id, "until": snooze_until }),
            )),
        ));
    }
    menu_items.push(trash);
    let menu = blocks::menu(
        &format!("{prefix}/{id}/menu"),
        vec![blocks::menu_section("", menu_items)],
        sel,
    );

    let meta = task
        .due
        .as_deref()
        .or(task.scheduled_on.as_deref())
        .unwrap_or("");
    let overdue = !is_done
        && task
            .due
            .as_deref()
            .and_then(|d| d.get(..10))
            .is_some_and(|d| d < today);

    let mut row = blocks::row(
        sel,
        &format!("{prefix}/{id}"),
        &task.title,
        Handler::Open(format!("reminders/task/{id}")),
    )
    .meta(meta)
    .mark(blocks::check_mark(
        sel,
        &format!("{prefix}/{id}/check"),
        if is_done {
            wire::RoomCheckState::On
        } else {
            wire::RoomCheckState::Off
        },
        Handler::Act(check_act),
    ))
    .menu(menu)
    .swipe(
        sel,
        &format!("{prefix}/{id}/swipe"),
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
    );
    if overdue {
        row = row.chip(blocks::chip(
            &words::chip_overdue(EN),
            wire::RoomTone::Warning,
        ));
    }
    if starred {
        row = row.chip(blocks::chip(
            &words::chip_starred(EN),
            wire::RoomTone::Accent,
        ));
    }
    if is_done {
        row = row.dimmed();
    }
    row.into_block()
}

#[derive(Default)]
struct RemindersRoot {
    lens_loaded: bool,
}

impl RoomScreen for RemindersRoot {
    fn key(&self) -> String {
        REMINDERS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.lens_loaded {
            self.lens_loaded = true;
            if b.ui.lens().is_none() {
                let saved = load_smart_list(b.door);
                b.ui.set_lens(&saved);
            }
        }
        let smart = b.ui.lens().unwrap_or("today").to_owned();
        let today = today_iso(b.door.now_ms());
        let snooze_until = centraid_vault::clock::format_iso_ms(b.door.now_ms() + 3_600_000);
        let search_term = b.ui.search_term().trim().to_ascii_lowercase();

        let smart_choice = blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/smart",
            &words::app_title(EN),
            wire::RoomChoiceStyle::Chips,
            false,
            vec![
                blocks::option("today", &words::list_today(EN), smart == "today"),
                blocks::option(
                    "scheduled",
                    &words::list_scheduled(EN),
                    smart == "scheduled",
                ),
                blocks::option("all", &words::list_all(EN), smart == "all"),
                blocks::option("starred", &words::list_starred(EN), smart == "starred"),
                blocks::option(
                    "completed",
                    &words::list_completed(EN),
                    smart == "completed",
                ),
            ],
            "smart-choice",
        ));

        let tasks_result: Result<Vec<reads::TaskSummary>, super::door::Refused> =
            match smart.as_str() {
                "completed" => b.run(&reads::COMPLETED, &Args::new()).map(|a| a.rows),
                "starred" => b.run(&reads::STARRED, &Args::new()).map(|a| a.rows),
                "scheduled" => b.run(&reads::OPEN_BY_DUE, &Args::new()).map(|a| a.rows),
                "all" => b.run(&reads::OPEN_BY_DUE, &Args::new()).map(|a| {
                    let mut rows = a.rows;
                    if let Ok(undated) = b.run(&reads::OPEN_UNDATED, &Args::new()) {
                        rows.extend(undated.rows);
                    }
                    rows
                }),
                _ => b.run(&reads::OPEN_BY_DUE, &Args::new()).map(|a| {
                    let mut rows: Vec<reads::TaskSummary> = a
                        .rows
                        .into_iter()
                        .filter(|t| {
                            t.due
                                .as_deref()
                                .and_then(|d| d.get(..10))
                                .is_some_and(|d| d <= today.as_str())
                                || t.scheduled_on.as_deref() == Some(today.as_str())
                        })
                        .collect();
                    if let Ok(undated) = b.run(&reads::OPEN_UNDATED, &Args::new()) {
                        for t in undated.rows {
                            if t.scheduled_on.as_deref() == Some(today.as_str())
                                && !rows.iter().any(|existing| existing.id == t.id)
                            {
                                rows.push(t);
                            }
                        }
                    }
                    rows
                }),
            };

        let tasks = match tasks_result {
            Ok(rows) => rows,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, REMINDERS)
                    .title(&words::app_title(EN))
                    .band(reminders_band(&mut b.sel))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let lists = b
            .run(&reads::LISTS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        let filtered: Vec<&reads::TaskSummary> = tasks
            .iter()
            .filter(|t| {
                search_term.is_empty() || t.title.to_ascii_lowercase().contains(&search_term)
            })
            .collect();

        let mut content = vec![smart_choice];
        if filtered.is_empty() && !first::holds(b, "task") {
            let by_hand = !b.door.reminders_source();
            let refused = (!by_hand && b.door.permission_refused("reminders")).then(|| {
                (
                    home_words::refused_reminders_title(EN),
                    home_words::refused_reminders_body(EN),
                )
            });
            let card = if by_hand {
                first::FirstOpen {
                    app: "reminders",
                    icon: "Check",
                    hue: "",
                    sentence: home_words::first_open_reminders_by_hand(EN),
                    action: None,
                    tail: first::Tail::Write,
                    refused: None,
                }
            } else {
                first::FirstOpen {
                    app: "reminders",
                    icon: "Check",
                    hue: "",
                    sentence: home_words::first_open_reminders(EN),
                    action: Some((
                        Handler::Tag(format!("{}reminders", first::IMPORT_TAG)),
                        home_words::first_open_import_reminders(EN),
                    )),
                    tail: first::Tail::OrWrite,
                    refused,
                }
            };
            let card = first::first_open(b, card);
            content.push(card);
        } else if filtered.is_empty() {
            let body = match smart.as_str() {
                "completed" => words::empty_completed_body(EN),
                "starred" => words::empty_starred_body(EN),
                _ => words::empty_body(EN),
            };
            content.push(blocks::empty(
                glyph("Check", ""),
                &words::empty_title(EN),
                &body,
                Some(blocks::action(
                    &mut b.sel,
                    "empty/add-task",
                    &words::add_task(EN),
                    "Plus",
                    Handler::Open(NEW_TASK.to_owned()),
                )),
            ));
        } else {
            let heading = match smart.as_str() {
                "scheduled" => words::list_scheduled(EN),
                "all" => words::list_all(EN),
                "starred" => words::list_starred(EN),
                "completed" => words::list_completed(EN),
                _ => words::list_today(EN),
            };
            let rows: Vec<wire::RoomBlock> = filtered
                .iter()
                .map(|t| task_row(&mut b.sel, t, &today, &snooze_until, "task"))
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/tasks", &heading)
                    .blocks(rows)
                    .into_block(),
            );
        }

        let list_rows: Vec<wire::RoomBlock> = lists
            .iter()
            .map(|l| {
                let mut trash = blocks::menu_item(
                    &mut b.sel,
                    &format!("list/{}/trash", l.id),
                    &shared::trash_move(EN),
                    Handler::Open(format!("reminders/list/{}/trash-confirm", l.id)),
                );
                trash.destructive = true;
                let menu = blocks::menu(
                    &format!("list/{}/menu", l.id),
                    vec![blocks::menu_section("", vec![trash])],
                    &mut b.sel,
                );
                blocks::row(
                    &mut b.sel,
                    &format!("list/{}", l.id),
                    &l.title,
                    Handler::Open(format!("reminders/list/{}", l.id)),
                )
                .mark(blocks::glyph_mark(
                    l.icon.as_deref().unwrap_or("List"),
                    l.color.as_deref().unwrap_or(""),
                ))
                .menu(menu)
                .swipe(
                    &mut b.sel,
                    &format!("list/{}/swipe", l.id),
                    &shared::trash_move(EN),
                    Handler::Open(format!("reminders/list/{}/trash-confirm", l.id)),
                )
                .into_block()
            })
            .collect();
        let add_list_btn = blocks::action(
            &mut b.sel,
            "lists/add",
            &words::add_list(EN),
            "Plus",
            Handler::Open(NEW_LIST.to_owned()),
        );
        content.push(
            blocks::section(&mut b.sel, "section/my-lists", &words::section_my_lists(EN))
                .trailing(add_list_btn)
                .blocks(list_rows)
                .into_block(),
        );

        room(wire::RoomKind::AppPlace, REMINDERS)
            .title(&words::app_title(EN))
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_task(EN),
                Handler::Open(NEW_TASK.to_owned()),
            )
            .band(reminders_band(&mut b.sel))
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "nav:home" => Outcome::replace(super::shell::HOME),
            "tab:tab/reminders" => Outcome::default(),
            "more:following" => Outcome::say(&words::follow_note(EN)),
            "more:export" => Outcome::say(&words::export_note(EN)),
            "smart-choice" => {
                if let Input::Option(choice) = input {
                    e.ui.set_lens(choice);
                    save_smart_list(e.door, choice);
                }
                Outcome::default()
            }
            _ => Outcome::default(),
        }
    }
}

struct TaskListDetail {
    id: String,
    loaded: usize,
}

impl RoomScreen for TaskListDetail {
    fn key(&self) -> String {
        format!("reminders/list/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let list = match b.run(&reads::LIST_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => match ans.rows.into_iter().next() {
                Some(l) => l,
                None => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&words::app_title(EN))
                        .back(&mut b.sel, &words::app_title(EN))
                        .failed(
                            &mut b.sel,
                            &words::error_not_found(EN),
                            &shared::kit_retry(EN),
                        )
                        .build();
                }
            },
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::app_title(EN))
                    .back(&mut b.sel, &words::app_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let limit = self.loaded.max(50);
        let tasks = b
            .reload(
                &reads::IN_LIST,
                &Args::new().text("list_id", &self.id),
                limit,
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let today = today_iso(b.door.now_ms());
        let snooze_until = centraid_vault::clock::format_iso_ms(b.door.now_ms() + 3_600_000);

        let mut trash = blocks::menu_item(
            &mut b.sel,
            "menu/trash-list",
            &shared::trash_move(EN),
            Handler::Open(format!("reminders/list/{}/trash-confirm", self.id)),
        );
        trash.destructive = true;
        let menu = blocks::menu(
            "list/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/add-task",
                        &words::add_task(EN),
                        Handler::Open(format!("reminders/new/list/{}", self.id)),
                    ),
                    trash,
                ],
            )],
            &mut b.sel,
        );

        let content = if tasks.is_empty() {
            vec![blocks::empty(
                glyph("List", ""),
                &words::empty_title(EN),
                &words::empty_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "empty/add-task",
                    &words::add_task(EN),
                    "Plus",
                    Handler::Open(format!("reminders/new/list/{}", self.id)),
                )),
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = tasks
                .iter()
                .map(|t| task_row(&mut b.sel, t, &today, &snooze_until, "list-task"))
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/list-tasks", &list.title)
                    .blocks(rows)
                    .into_block(),
            ]
        };

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&list.title)
            .back(&mut b.sel, &words::app_title(EN))
            .menu_key(&mut b.sel, "key/menu", &shared::kit_details(EN), menu)
            .ready(content)
            .build()
    }
}

#[derive(Default)]
struct NewListForm {
    error: Option<String>,
}

impl RoomScreen for NewListForm {
    fn key(&self) -> String {
        NEW_LIST.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let mut title = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            &words::field_list_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .hint(&words::field_list_name_hint(EN))
        .required()
        .focused();
        if let Some(err) = &self.error {
            title = title.error(err);
        }
        let dirty = !b.ui.fields.value("title").unwrap_or("").trim().is_empty();
        let save_spec = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("form:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("form:cancel".to_owned()),
                save_enabled: true,
                dirty,
                drafted: false,
            },
        );
        let form_block = form::form(vec![title.build()], Vec::new(), Save::Explicit(save_spec));
        room(wire::RoomKind::Editor, NEW_LIST)
            .title(&words::add_list(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        match tag {
            "form:cancel" => Outcome::pop(),
            "form:save" => {
                let title = e.ui.fields.value("title").unwrap_or("").trim().to_owned();
                if title.is_empty() {
                    self.error = Some(words::error_title_required(EN));
                    return Outcome::default();
                }
                self.error = None;
                let act = Act::new(
                    "container.create",
                    json!({
                        "kind": "task_list",
                        "title": title,
                    }),
                );
                match e.door.act(&act) {
                    Ok(done) => Outcome {
                        nav: super::screen::Nav::Pop,
                        status: Some(super::screen::Status {
                            sentence: words::status_list_created(EN),
                            undo: done.undo,
                            refused: false,
                        }),
                    },
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct TrashListConfirm {
    id: String,
}

impl RoomScreen for TrashListConfirm {
    fn key(&self) -> String {
        format!("reminders/list/{}/trash-confirm", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let held = b
            .run(
                &entity_reads::HELD_COUNTS,
                &Args::new().text("home", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let tasks: i64 = held
            .iter()
            .filter(|h| h.kind == "task")
            .map(|h| h.count)
            .sum();
        let body = if tasks > 0 {
            words::trash_list_body(EN, u64::try_from(tasks).unwrap_or(0))
        } else {
            words::trash_list_empty_body(EN)
        };
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::trash_list_title(EN),
                body: &body,
                warning: "",
                confirm_label: &shared::trash_move(EN),
                confirm: Handler::Tag("confirm:trash".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::trash_list_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "confirm:trash" {
            let act = Act::new("entity.trash", json!({ "ids": [self.id] }));
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: done.undo,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct TaskDetailRoom {
    id: String,
}

impl RoomScreen for TaskDetailRoom {
    fn key(&self) -> String {
        format!("reminders/task/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let task = match b.run(&reads::BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => match ans.rows.into_iter().next() {
                Some(t) => t,
                None => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&words::app_title(EN))
                        .back(&mut b.sel, &words::app_title(EN))
                        .failed(
                            &mut b.sel,
                            &words::error_not_found(EN),
                            &shared::kit_retry(EN),
                        )
                        .build();
                }
            },
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::app_title(EN))
                    .back(&mut b.sel, &words::app_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let parent_meta = task.parent_id.as_deref().and_then(|pid| {
            b.run(&entity_reads::META_BY_ID, &Args::new().text("id", pid))
                .ok()
                .and_then(|a| a.rows.into_iter().next())
        });
        let is_subtask = parent_meta.as_ref().is_some_and(|meta| meta.kind == "task");

        let subtasks = if is_subtask {
            Vec::new()
        } else {
            b.run(&reads::SUBTASKS, &Args::new().text("task_id", &self.id))
                .map(|a| a.rows)
                .unwrap_or_default()
        };
        let series_rows = task
            .series_id
            .as_deref()
            .and_then(|sid| {
                b.run(&reads::SERIES, &Args::new().text("series_id", sid))
                    .ok()
                    .map(|a| a.rows)
            })
            .unwrap_or_default();
        let alerts = b
            .run(&reads::REMINDERS, &Args::new().text("task_id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let snooze = b
            .run(&reads::SNOOZE, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next());
        let attachments = b
            .run(
                &entity_reads::ATTACHMENTS,
                &Args::new().text("id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let linked_ids = b
            .run(&entity_reads::LINKED, &Args::new().text("id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let mentioned = b
            .run(
                &entity_reads::MENTIONED_IN,
                &Args::new().text("id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let rev_head = b
            .run(
                &entity_reads::REVISION_HEAD,
                &Args::new().text("id", &self.id),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next());

        let today = today_iso(b.door.now_ms());
        let snooze_until = centraid_vault::clock::format_iso_ms(b.door.now_ms() + 3_600_000);
        let is_done = task.status == "done";
        let starred = task.starred_at.is_some();

        let done_act = if is_done {
            Act::new("task.reopen", json!({ "id": self.id }))
        } else {
            Act::new("task.complete", json!({ "id": self.id }))
        };
        let star_act = if starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        };

        let star_label = if starred {
            words::action_unstar(EN)
        } else {
            words::action_star(EN)
        };
        let mut menu_items = vec![
            blocks::menu_item(
                &mut b.sel,
                "menu/edit",
                &words::action_edit(EN),
                Handler::Open(format!("reminders/task/{}/edit", self.id)),
            ),
            blocks::menu_item(&mut b.sel, "menu/star", &star_label, Handler::Act(star_act)),
        ];
        if !is_done && task.due.is_some() {
            menu_items.push(blocks::menu_item(
                &mut b.sel,
                "menu/snooze",
                &words::action_snooze(EN),
                Handler::Act(Act::new(
                    "alert.snooze",
                    json!({ "entity_id": self.id, "until": snooze_until }),
                )),
            ));
        }
        let mut trash = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Tag("task:trash".to_owned()),
        );
        trash.destructive = true;
        menu_items.push(trash);
        let page_menu = blocks::menu(
            "task/menu",
            vec![blocks::menu_section("", menu_items)],
            &mut b.sel,
        );

        let done_label = if is_done {
            words::action_reopen(EN)
        } else {
            words::action_done(EN)
        };
        let primary = blocks::action(
            &mut b.sel,
            "hero/done",
            &done_label,
            "Check",
            Handler::Act(done_act),
        );
        let mut hero = blocks::hero(&task.title)
            .noun("Task")
            .mark(blocks::glyph_mark("Check", ""))
            .primary(primary);
        if let Some(due) = &task.due {
            hero = hero.line(due);
            if !is_done && due.get(..10).is_some_and(|d| d < today.as_str()) {
                hero = hero.chip(blocks::chip(
                    &words::chip_overdue(EN),
                    wire::RoomTone::Warning,
                ));
            }
        }
        if starred {
            hero = hero.chip(blocks::chip(
                &words::chip_starred(EN),
                wire::RoomTone::Accent,
            ));
        }

        let status_label = match task.status.as_str() {
            "done" => words::status_done(EN),
            "cancelled" => words::status_cancelled(EN),
            _ => words::status_open(EN),
        };
        let mut facts = vec![blocks::fact(
            &words::fact_status(EN),
            &status_label,
            wire::RoomFactKind::Text,
        )];
        if let Some(due) = &task.due {
            facts.push(blocks::fact(
                &words::fact_due(EN),
                due,
                wire::RoomFactKind::Date,
            ));
        }
        if let Some(sched) = &task.scheduled_on {
            facts.push(blocks::fact(
                &words::fact_scheduled(EN),
                sched,
                wire::RoomFactKind::Date,
            ));
        }
        if task.priority > 0 {
            facts.push(blocks::fact(
                &words::fact_priority(EN),
                &priority_label(task.priority),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(pm) = &parent_meta
            && pm.kind == "task_list"
        {
            facts.push(blocks::fact(
                &words::fact_list(EN),
                &pm.title,
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(rule) = &task.rule {
            facts.push(blocks::fact(
                &words::fact_repeat(EN),
                rule,
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(url) = task.url.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::fact_url(EN),
                url,
                wire::RoomFactKind::Link,
            ));
        }
        if let Some(sn) = &snooze {
            facts.push(blocks::fact(
                &words::fact_snoozed(EN),
                &sn.until,
                wire::RoomFactKind::Date,
            ));
        }

        let mut content = vec![hero.block(), blocks::facts(facts)];

        if !is_subtask {
            let sub_blocks: Vec<wire::RoomBlock> = subtasks
                .iter()
                .map(|sub| task_row(&mut b.sel, sub, &today, &snooze_until, "sub"))
                .collect();
            let add_sub = blocks::action(
                &mut b.sel,
                "subtasks/add",
                &words::add_subtask(EN),
                "Plus",
                Handler::Open(format!("reminders/new/subtask/{}", self.id)),
            );
            content.push(
                blocks::section(&mut b.sel, "section/subtasks", &words::section_subtasks(EN))
                    .trailing(add_sub)
                    .blocks(sub_blocks)
                    .into_block(),
            );
        }

        if let Some(desc) = task.description.as_deref().filter(|s| !s.is_empty()) {
            content.push(
                blocks::section(&mut b.sel, "section/notes", &words::section_notes(EN))
                    .block(blocks::prose(desc))
                    .into_block(),
            );
        }

        if !alerts.is_empty() {
            let alert_rows: Vec<wire::RoomBlock> = alerts
                .iter()
                .map(|a| {
                    let label = if a.offset_min == 0 {
                        "At due time".to_owned()
                    } else {
                        format!("{} min before", a.offset_min)
                    };
                    blocks::still_row(&mut b.sel, &format!("alert/{}", a.id), &label).into_block()
                })
                .collect();
            let snooze_btn = blocks::action(
                &mut b.sel,
                "alert/snooze",
                &words::action_snooze(EN),
                "Bell",
                Handler::Act(Act::new(
                    "alert.snooze",
                    json!({ "entity_id": self.id, "until": snooze_until }),
                )),
            );
            content.push(
                blocks::section(&mut b.sel, "section/alerts", &words::section_alerts(EN))
                    .trailing(snooze_btn)
                    .blocks(alert_rows)
                    .into_block(),
            );
        }

        if series_rows.len() > 1 {
            let rows: Vec<wire::RoomBlock> = series_rows
                .iter()
                .map(|s| {
                    blocks::row(
                        &mut b.sel,
                        &format!("series/{}", s.id),
                        &s.title,
                        Handler::Open(format!("reminders/task/{}", s.id)),
                    )
                    .meta(s.due.as_deref().unwrap_or(""))
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/series", &words::section_series(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }

        if !attachments.is_empty() {
            let rows: Vec<wire::RoomRow> = attachments
                .iter()
                .map(|att| {
                    blocks::still_row(&mut b.sel, &format!("att/{}", att.id), &att.title)
                        .meta(&att.kind)
                        .build()
                })
                .collect();
            content.push(blocks::attachments(
                &words::section_attachments(EN),
                rows,
                None,
            ));
        }

        if !linked_ids.is_empty() {
            let mut rows = Vec::new();
            for lid in &linked_ids {
                if let Ok(ans) = b.run(&entity_reads::META_BY_ID, &Args::new().text("id", lid))
                    && let Some(meta) = ans.rows.into_iter().next()
                {
                    rows.push(
                        blocks::still_row(&mut b.sel, &format!("link/{}", meta.id), &meta.title)
                            .meta(&meta.kind)
                            .build(),
                    );
                }
            }
            if !rows.is_empty() {
                content.push(blocks::linked(&words::section_linked(EN), rows, None));
            }
        }

        if !mentioned.is_empty() {
            let rows: Vec<wire::RoomRow> = mentioned
                .iter()
                .map(|m| {
                    blocks::still_row(&mut b.sel, &format!("mention/{}", m.id), &m.title).build()
                })
                .collect();
            content.push(blocks::mentioned_in(&words::section_mentioned(EN), rows));
        }

        if let Some(head) = rev_head
            && head.count > 0
        {
            content.push(blocks::earlier_versions(
                &mut b.sel,
                &words::earlier_versions_label(EN),
                u32::try_from(head.count).unwrap_or(u32::MAX),
                Handler::Tag("task:versions".to_owned()),
            ));
        }

        if let Some(via) = task.arrived_via.as_deref() {
            let line = fill(
                &words::origin_labeled(EN),
                &[("label", task.arrived_label.as_deref().unwrap_or(via))],
            );
            content.push(blocks::origin(&mut b.sel, &line, None));
        }

        let back_label = parent_meta
            .as_ref()
            .map_or_else(|| words::app_title(EN), |m| m.title.clone());
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&task.title)
            .back(&mut b.sel, &back_label)
            .menu_key(&mut b.sel, "key/menu", &shared::kit_details(EN), page_menu)
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "task:trash" {
            let act = Act::new("entity.trash", json!({ "ids": [self.id] }));
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: done.undo,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

fn priority_label(p: i64) -> String {
    match p {
        1..=3 => words::priority_high(EN),
        4..=6 => words::priority_medium(EN),
        7..=9 => words::priority_low(EN),
        _ => words::priority_none(EN),
    }
}

fn extract_typed_date(title: &str, now_ms: i64) -> Option<(String, String, String)> {
    let tokens: Vec<&str> = title.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }
    let last = *tokens.last()?;
    let lower = last.to_ascii_lowercase();
    let (chip_label, iso) = if lower == "today" {
        (shared::today(EN), today_iso(now_ms))
    } else if lower == "tomorrow" {
        (shared::tomorrow(EN), tomorrow_iso(now_ms))
    } else if last.len() == 10
        && last.as_bytes()[4] == b'-'
        && last.as_bytes()[7] == b'-'
        && last
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        (last.to_owned(), last.to_owned())
    } else {
        return None;
    };
    let clean = tokens[..tokens.len() - 1].join(" ");
    Some((clean, chip_label, iso))
}

struct TaskForm {
    editing_id: Option<String>,
    parent_id: Option<String>,
    is_subtask: bool,
    loaded: bool,
    priority: String,
    date_chip: Option<(String, String)>,
    drafted: bool,
    title_error: Option<String>,
}

impl TaskForm {
    fn new_task(parent_id: Option<String>, is_subtask: bool) -> Self {
        Self {
            editing_id: None,
            parent_id,
            is_subtask,
            loaded: false,
            priority: "0".to_owned(),
            date_chip: None,
            drafted: false,
            title_error: None,
        }
    }

    fn edit_task(id: String) -> Self {
        Self {
            editing_id: Some(id),
            parent_id: None,
            is_subtask: false,
            loaded: false,
            priority: "0".to_owned(),
            date_chip: None,
            drafted: false,
            title_error: None,
        }
    }

    fn save_draft(&self, e: &Event<'_>) {
        if self.editing_id.is_some() || self.is_subtask {
            return;
        }
        let Some(key) = draft_key(e.door) else {
            return;
        };
        let fields = json!({
            "title": e.ui.fields.value("title").unwrap_or(""),
            "due": e.ui.fields.value("due").unwrap_or(""),
            "scheduled_on": e.ui.fields.value("scheduled_on").unwrap_or(""),
            "url": e.ui.fields.value("url").unwrap_or(""),
            "notes": e.ui.fields.value("notes").unwrap_or(""),
            "priority": self.priority,
            "parent_id": self.parent_id,
        });
        let payload = json!({
            "v": 1,
            "kind": "task",
            "fields": fields,
            "saved_at": e.door.now_ms(),
        });
        let _ = e.door.device_put(&key, &payload.to_string());
    }

    fn clear_draft(&self, door: &dyn Door) {
        if self.editing_id.is_none()
            && !self.is_subtask
            && let Some(key) = draft_key(door)
        {
            let _ = door.device_delete(&key);
        }
    }
}

impl RoomScreen for TaskForm {
    fn key(&self) -> String {
        match &self.editing_id {
            Some(id) => format!("reminders/task/{id}/edit"),
            None => NEW_TASK.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let lists = b
            .run(&reads::LISTS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        if !self.loaded {
            self.loaded = true;
            if let Some(id) = &self.editing_id {
                if let Ok(ans) = b.run(&reads::BY_ID, &Args::new().text("id", id))
                    && let Some(task) = ans.rows.into_iter().next()
                {
                    b.ui.fields.get_or("title", &task.title);
                    b.ui.fields.get_or("due", task.due.as_deref().unwrap_or(""));
                    b.ui.fields
                        .get_or("scheduled_on", task.scheduled_on.as_deref().unwrap_or(""));
                    b.ui.fields.get_or("url", task.url.as_deref().unwrap_or(""));
                    b.ui.fields
                        .get_or("notes", task.description.as_deref().unwrap_or(""));
                    self.priority = task.priority.to_string();
                    self.parent_id = task.parent_id;
                }
            } else if !self.is_subtask
                && let Some(key) = draft_key(b.door)
                && let Some(raw) = b.door.device_get(&key)
                && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
                && let Some(fields) = parsed.get("fields").and_then(Value::as_object)
            {
                self.drafted = true;
                for name in ["title", "due", "scheduled_on", "url", "notes"] {
                    if let Some(v) = fields.get(name).and_then(Value::as_str) {
                        b.ui.fields.get_or(name, v);
                    }
                }
                if let Some(p) = fields.get("priority").and_then(Value::as_str) {
                    self.priority = p.to_owned();
                }
                if self.parent_id.is_none() {
                    self.parent_id = fields
                        .get("parent_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
            }
        }

        let mut title = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            &words::field_title(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .hint(&words::field_title_hint(EN))
        .required()
        .focused();
        if let Some((label, _)) = &self.date_chip {
            title = title.chip(blocks::removable_chip(
                &mut b.sel,
                "field/title/date-chip",
                label,
                Handler::Tag("chip:remove-date".to_owned()),
            ));
        }
        if let Some(err) = &self.title_error {
            title = title.error(err);
        }

        let mut fields = vec![
            title.build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "due",
                &words::field_due(EN),
                wire::RoomTextKind::Line,
                "",
                40,
            )
            .hint(&words::field_due_hint(EN))
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "scheduled_on",
                &words::field_scheduled(EN),
                wire::RoomTextKind::Line,
                "",
                20,
            )
            .build(),
        ];

        if !self.is_subtask && self.editing_id.is_none() && !lists.is_empty() {
            let mut opts = vec![blocks::option(
                "",
                &words::field_list_none(EN),
                self.parent_id.is_none(),
            )];
            for l in &lists {
                opts.push(blocks::option(
                    &l.id,
                    &l.title,
                    self.parent_id.as_deref() == Some(l.id.as_str()),
                ));
            }
            fields.push(
                form::choice(
                    &mut b.sel,
                    "parent_id",
                    &words::field_list(EN),
                    wire::RoomChoiceStyle::Menu,
                    opts,
                )
                .build(),
            );
        }

        fields.push(
            form::choice(
                &mut b.sel,
                "priority",
                &words::field_priority(EN),
                wire::RoomChoiceStyle::Segmented,
                vec![
                    blocks::option("0", &words::priority_none(EN), self.priority == "0"),
                    blocks::option("7", &words::priority_low(EN), self.priority == "7"),
                    blocks::option("5", &words::priority_medium(EN), self.priority == "5"),
                    blocks::option("1", &words::priority_high(EN), self.priority == "1"),
                ],
            )
            .build(),
        );
        fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "url",
                &words::field_url(EN),
                wire::RoomTextKind::Url,
                "",
                MAX_TEXT,
            )
            .build(),
        );
        fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "notes",
                &words::field_notes(EN),
                wire::RoomTextKind::Paragraph,
                "",
                MAX_NOTES,
            )
            .build(),
        );

        let dirty = !b.ui.fields.value("title").unwrap_or("").trim().is_empty();
        let save_spec = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("form:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("form:cancel".to_owned()),
                save_enabled: true,
                dirty,
                drafted: self.drafted,
            },
        );
        let form_block = form::form(fields, Vec::new(), Save::Explicit(save_spec));
        let page_title = if self.editing_id.is_some() {
            words::edit_task(EN)
        } else if self.is_subtask {
            words::add_subtask(EN)
        } else {
            words::add_task(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&page_title)
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "title" => {
                if let Input::Text(text) = input
                    && let Some((clean, label, iso)) = extract_typed_date(text, e.door.now_ms())
                {
                    if let Some(f) = e.ui.fields.get_mut("title") {
                        f.set(&clean);
                    }
                    e.ui.fields.get_or("due", "");
                    if let Some(f) = e.ui.fields.get_mut("due") {
                        f.set(&iso);
                    }
                    self.date_chip = Some((label, iso));
                }
                self.save_draft(e);
                Outcome::default()
            }
            "chip:remove-date" => {
                self.date_chip = None;
                if let Some(f) = e.ui.fields.get_mut("due") {
                    f.set("");
                }
                self.save_draft(e);
                Outcome::default()
            }
            "parent_id" => {
                if let Input::Option(opt) = input {
                    self.parent_id = (!opt.is_empty()).then(|| opt.clone());
                }
                self.save_draft(e);
                Outcome::default()
            }
            "priority" => {
                if let Input::Option(opt) = input {
                    opt.clone_into(&mut self.priority);
                }
                self.save_draft(e);
                Outcome::default()
            }
            "due" | "scheduled_on" | "url" | "notes" => {
                self.save_draft(e);
                Outcome::default()
            }
            "form:cancel" => {
                self.clear_draft(e.door);
                Outcome::pop()
            }
            "form:save" => {
                let title = e.ui.fields.value("title").unwrap_or("").trim().to_owned();
                if title.is_empty() {
                    self.title_error = Some(words::error_title_required(EN));
                    return Outcome::default();
                }
                self.title_error = None;

                let mut payload = Map::new();
                payload.insert("title".to_owned(), Value::String(title));
                let due = e.ui.fields.value("due").unwrap_or("").trim();
                if !due.is_empty() {
                    payload.insert("due".to_owned(), Value::String(due.to_owned()));
                    if due.ends_with('Z') {
                        payload.insert("zone".to_owned(), Value::String("UTC".to_owned()));
                    }
                } else if self.editing_id.is_some() {
                    payload.insert("due".to_owned(), Value::Null);
                }
                let sched = e.ui.fields.value("scheduled_on").unwrap_or("").trim();
                if !sched.is_empty() {
                    payload.insert("scheduled_on".to_owned(), Value::String(sched.to_owned()));
                } else if self.editing_id.is_some() {
                    payload.insert("scheduled_on".to_owned(), Value::Null);
                }
                let prio: i64 = self.priority.parse().unwrap_or(0);
                payload.insert("priority".to_owned(), json!(prio));
                let url = e.ui.fields.value("url").unwrap_or("").trim();
                if !url.is_empty() {
                    payload.insert("url".to_owned(), Value::String(url.to_owned()));
                }
                let notes = e.ui.fields.value("notes").unwrap_or("").trim();
                if !notes.is_empty() {
                    payload.insert("description".to_owned(), Value::String(notes.to_owned()));
                }

                let (action_name, success_sentence) = if let Some(id) = &self.editing_id {
                    payload.insert("id".to_owned(), Value::String(id.clone()));
                    ("task.edit", words::status_task_saved(EN))
                } else {
                    if let Some(pid) = &self.parent_id {
                        payload.insert("parent_id".to_owned(), Value::String(pid.clone()));
                    }
                    ("task.add", words::status_task_created(EN))
                };

                match e.door.act(&Act::new(action_name, Value::Object(payload))) {
                    Ok(done) => {
                        self.clear_draft(e.door);
                        Outcome {
                            nav: super::screen::Nav::Pop,
                            status: Some(super::screen::Status {
                                sentence: success_sentence,
                                undo: done.undo,
                                refused: false,
                            }),
                        }
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

#[derive(Default)]
struct RemindersTrash {
    loaded: usize,
}

impl RoomScreen for RemindersTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let limit = self.loaded.max(50);
        let ans = match b.reload(&reads::TRASH, &Args::new(), limit) {
            Ok(ans) => ans,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&words::trash_title(EN))
                    .back(&mut b.sel, &words::app_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let block = if ans.rows.is_empty() {
            blocks::empty(
                glyph("Trash", ""),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            )
        } else {
            let heading = shared::trash_count(EN, ans.rows.len() as u64);
            let rows: Vec<wire::RoomTrashRow> = ans
                .rows
                .iter()
                .map(|row| {
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        row.deleted_at.get(..10).unwrap_or(&row.deleted_at),
                        shared::trash_erased(EN),
                        row.purge_at.get(..10).unwrap_or(&row.purge_at),
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", row.id),
                        &row.title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [row.id] }))),
                        Handler::Open(format!("reminders/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_action = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("reminders/trash/empty".to_owned()),
            );
            blocks::trash_block(blocks::trash(
                &heading,
                &shared::trash_entry_meta(EN),
                rows,
                Some(empty_action),
            ))
        };
        room(wire::RoomKind::PushedPage, TRASH)
            .title(&words::trash_title(EN))
            .back(&mut b.sel, &words::app_title(EN))
            .ready(vec![block])
            .build()
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "reminders/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: &shared::trash_cannot_undo(EN),
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("confirm:empty".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "confirm:empty" {
            let act = Act::new(
                "entity.empty_trash",
                json!({ "kinds": ["task", "task_list"] }),
            );
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: false,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("reminders/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::purge_title(EN),
                body: &words::purge_body(EN),
                warning: &shared::trash_cannot_undo(EN),
                confirm_label: &shared::kit_delete(EN),
                confirm: Handler::Tag("confirm:purge".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::purge_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "confirm:purge" {
            let act = Act::new("entity.purge", json!({ "id": self.id }));
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: false,
                        refused: false,
                    }),
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
