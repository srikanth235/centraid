use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity as entity_reads, locker as reads};
use centraid_domain::read::Args;
use rand::RngCore as _;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

use super::blocks::{self, Confirm, glyph};
use super::first;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, fill, home as home_words, locker as words, shared};

pub const LOCKER: &str = "locker";
pub const STARRED: &str = "locker/starred";
pub const NEW_ITEM: &str = "locker/new";
pub const ALERTS: &str = "locker/alerts";
pub const TRASH: &str = "locker/trash";

const EN: Locale = Locale::En;
const MAX_TEXT: usize = 200;

const ITEM_TYPES: [&str; 15] = [
    "login",
    "card",
    "note",
    "identity",
    "wifi",
    "password",
    "ssh_key",
    "api_credential",
    "passport",
    "bank_account",
    "driving_licence",
    "software_licence",
    "crypto_wallet",
    "membership",
    "document",
];

const FIELD_KINDS: [&str; 5] = ["text", "url", "date", "sealed", "otp"];

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(LOCKER, || Box::new(LockerItemsRoom::locked()))
        .exact(STARRED, || Box::new(LockerStarredRoom::default()))
        .exact(NEW_ITEM, || Box::new(LockerItemForm::new_item()))
        .exact(ALERTS, || Box::new(ExpiryAlertsRoom))
        .exact(TRASH, || Box::new(LockerTrash::default()))
        .exact("locker/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("locker/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("locker/item/") {
                if let Some(id) = rest.strip_suffix("/link") {
                    return Some(Box::new(super::link_picker::LinkPicker::new(
                        id.to_owned(),
                        format!("locker/item/{id}"),
                        words::title(EN),
                    )));
                }
                if let Some(id) = rest.strip_suffix("/field/new") {
                    return Some(Box::new(AddFieldForm::new(id.to_owned())));
                }
                if let Some((item_id, field_id)) = rest.split_once("/field/")
                    && let Some(field_id) = field_id.strip_suffix("/edit")
                {
                    return Some(Box::new(AddFieldForm::edit(
                        item_id.to_owned(),
                        field_id.to_owned(),
                    )));
                }
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(LockerItemForm::edit_item(id.to_owned())));
                }
                if let Some(id) = rest.strip_suffix("/type") {
                    return Some(Box::new(ChangeTypeRoom::new(id.to_owned())));
                }
                if let Some(id) = rest.strip_suffix("/fields") {
                    return Some(Box::new(LockerFieldsRoom::new(id.to_owned())));
                }
                if let Some((item_id, passkey_id)) = rest.split_once("/passkey/")
                    && let Some(passkey_id) = passkey_id.strip_suffix("/rename")
                {
                    return Some(Box::new(PasskeyRenameForm::new(
                        item_id.to_owned(),
                        passkey_id.to_owned(),
                    )));
                }
                if let Some(id) = rest.strip_suffix("/versions") {
                    return Some(Box::new(EarlierVersionsRoom { id: id.to_owned() }));
                }
                return Some(Box::new(LockerDetailRoom::new(rest.to_owned())));
            }
            None
        }))
}

fn mint_uuid_v7(now_ms: i64) -> String {
    let mut bytes = [0u8; 16];
    let ts = u64::try_from(now_ms.max(0)).unwrap_or(0);
    bytes[0] = ((ts >> 40) & 0xff) as u8;
    bytes[1] = ((ts >> 32) & 0xff) as u8;
    bytes[2] = ((ts >> 24) & 0xff) as u8;
    bytes[3] = ((ts >> 16) & 0xff) as u8;
    bytes[4] = ((ts >> 8) & 0xff) as u8;
    bytes[5] = (ts & 0xff) as u8;
    rand::rng().fill_bytes(&mut bytes[6..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn type_label(code: &str) -> String {
    match code {
        "login" => words::type_login(EN),
        "card" => words::type_card(EN),
        "note" => words::type_note(EN),
        "identity" => words::type_identity(EN),
        "wifi" => words::type_wifi(EN),
        "password" => words::type_password(EN),
        "ssh_key" => words::type_ssh_key(EN),
        "api_credential" => words::type_api_credential(EN),
        "passport" => words::type_passport(EN),
        "bank_account" => words::type_bank_account(EN),
        "driving_licence" => words::type_driving_licence(EN),
        "software_licence" => words::type_software_licence(EN),
        "crypto_wallet" => words::type_crypto_wallet(EN),
        "membership" => words::type_membership(EN),
        "document" => words::type_document(EN),
        other => other.to_owned(),
    }
}

fn field_kind_label(kind: &str) -> String {
    match kind {
        "url" => words::field_kind_url(EN),
        "date" => words::field_kind_date(EN),
        "sealed" => words::field_kind_sealed(EN),
        "otp" => words::field_kind_otp(EN),
        _ => words::field_kind_text(EN),
    }
}

fn clipboard_clear(door: &dyn super::door::Door) -> wire::shell_effect::Kind {
    wire::shell_effect::Kind::ClipboardCopy(wire::ShellClipboardCopy {
        sealed: true,
        owner_vault_id: door.vault_id(),
        clear_owned: true,
        ..wire::ShellClipboardCopy::default()
    })
}

fn clipboard_copy(door: &dyn super::door::Door, text: &str) -> wire::shell_effect::Kind {
    wire::shell_effect::Kind::ClipboardCopy(wire::ShellClipboardCopy {
        text: text.to_owned(),
        sealed: true,
        lease_s: 30,
        owner_vault_id: door.vault_id(),
        ..wire::ShellClipboardCopy::default()
    })
}

fn locker_band(sel: &mut Sel, active_tab: &str, allow_search: bool) -> wire::RoomBand {
    let tabs = vec![
        frame::tab(
            sel,
            "tab/items",
            &words::tab_items(EN),
            "Lock",
            active_tab == LOCKER,
        ),
        frame::tab(
            sel,
            "tab/starred",
            &words::tab_starred(EN),
            "Star",
            active_tab == STARRED,
        ),
    ];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let mut more_items = vec![
        blocks::menu_item(
            sel,
            "more/alerts",
            &words::more_alerts(EN),
            Handler::Open(ALERTS.to_owned()),
        ),
        more_trash,
    ];
    if allow_search {
        more_items.insert(
            0,
            blocks::menu_item(
                sel,
                "more/lock",
                &words::lock_action(EN),
                Handler::Tag("locker:lock".to_owned()),
            ),
        );
    }
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let search_handler = allow_search.then_some(Handler::SearchOpen);
    let mut band = frame::band(
        tabs,
        Some(Handler::Tag("nav:home".to_owned())),
        search_handler,
        sel,
    );
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn handle_band_nav(tag: &str) -> Option<Outcome> {
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/items" => Some(Outcome::replace(LOCKER)),
        "tab:tab/starred" => Some(Outcome::replace(STARRED)),
        _ => None,
    }
}

fn item_row(
    sel: &mut Sel,
    item: &reads::LockerItemSummary,
    selecting: bool,
    selected: bool,
) -> wire::RoomBlock {
    let id = &item.id;
    let starred = item.starred_at.is_some();
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
    let mut trash_item = blocks::menu_item(
        sel,
        &format!("row/{id}/menu/trash"),
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
    );
    trash_item.destructive = true;
    let organize_item = blocks::menu_item(
        sel,
        &format!("row/{id}/menu/organize"),
        &shared::organize(EN),
        Handler::Open(super::organize::route(std::slice::from_ref(id))),
    );
    let menu = blocks::menu(
        &format!("row/{id}/menu"),
        vec![blocks::menu_section(
            "",
            vec![
                blocks::menu_item(
                    sel,
                    &format!("row/{id}/menu/open"),
                    &shared::kit_open(EN),
                    Handler::Open(format!("locker/item/{id}")),
                ),
                blocks::menu_item(
                    sel,
                    &format!("row/{id}/menu/edit"),
                    &words::item_menu_edit(EN),
                    Handler::Open(format!("locker/item/{id}/edit")),
                ),
                blocks::menu_item(
                    sel,
                    &format!("row/{id}/menu/type"),
                    &words::item_change_type(EN),
                    Handler::Open(format!("locker/item/{id}/type")),
                ),
                blocks::menu_item(
                    sel,
                    &format!("row/{id}/menu/star"),
                    &if starred {
                        words::item_menu_unstar(EN)
                    } else {
                        words::item_menu_star(EN)
                    },
                    Handler::Act(star_act),
                ),
                blocks::menu_item(
                    sel,
                    &format!("row/{id}/menu/select"),
                    &words::menu_select(EN),
                    Handler::SelectMode(true),
                ),
                organize_item,
                trash_item,
            ],
        )],
        sel,
    );
    let tap = if selecting {
        Handler::Pick(id.clone())
    } else {
        Handler::Open(format!("locker/item/{id}"))
    };
    let mut row = blocks::row(sel, &format!("row/{id}"), &item.title, tap)
        .meta(&type_label(&item.item_type))
        .selected(selected);
    if !selecting {
        row = row.menu(menu).swipe(
            sel,
            &format!("row/{id}/swipe"),
            &shared::trash_move(EN),
            Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
        );
    }
    if item.compromised {
        row = row.chip(blocks::chip(
            &words::chip_compromised(EN),
            wire::RoomTone::Warning,
        ));
    }
    row.into_block()
}

fn selection_actions(sel: &mut Sel, ids: &[String], unstar: bool) -> Vec<wire::RoomMenuItem> {
    if ids.is_empty() {
        return Vec::new();
    }
    let mut trash = blocks::menu_item(
        sel,
        "selection/trash",
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": ids }))),
    );
    trash.destructive = true;
    vec![
        blocks::menu_item(
            sel,
            "selection/organize",
            &shared::organize(EN),
            Handler::Open(super::organize::route(ids)),
        ),
        blocks::menu_item(
            sel,
            "selection/star",
            &if unstar {
                words::item_menu_unstar(EN)
            } else {
                words::item_menu_star(EN)
            },
            Handler::Act(Act::new(
                if unstar {
                    "flag.clear/starred"
                } else {
                    "flag.set/starred"
                },
                json!({ "flag": "starred", "ids": ids }),
            )),
        ),
        trash,
    ]
}

struct LockerItemsRoom {
    filter_type: Option<String>,
    loaded: usize,
    unlock_failure: String,
}

impl LockerItemsRoom {
    fn locked() -> Self {
        Self {
            filter_type: None,
            loaded: 50,
            unlock_failure: String::new(),
        }
    }

    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for LockerItemsRoom {
    fn key(&self) -> String {
        LOCKER.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !b.door.locker_unlocked() {
            let persisted_failure = b
                .door
                .locker_failed_unlocks()
                .ok()
                .filter(|(count, _)| *count > 0)
                .map(|(count, at)| {
                    let at = at.unwrap_or_default();
                    fill(
                        &words::wall_failed(EN),
                        &[("count", &count.to_string()), ("at", &at)],
                    )
                });
            let failure = match (persisted_failure, self.unlock_failure.as_str()) {
                (Some(persisted), "") => persisted,
                (Some(persisted), latest) => format!("{persisted}\n{latest}"),
                (None, latest) => latest.to_owned(),
            };
            let unlock = blocks::action(
                &mut b.sel,
                "wall/unlock",
                &words::wall_unlock(EN),
                "Lock",
                Handler::Tag("locker:unlock".to_owned()),
            );
            let first_use = !first::holds(b, "locker_item");
            let wall = if first_use {
                let confirm = wire::RoomAction {
                    label: home_words::locker_step_one_action(EN),
                    ..unlock
                };
                blocks::wall(
                    &home_words::locker_step_one_title(EN),
                    &home_words::locker_step_one_body(EN),
                    confirm,
                    &failure,
                )
            } else {
                blocks::wall(
                    &words::wall_title(EN),
                    &words::wall_body(EN),
                    unlock,
                    &failure,
                )
            };
            return room(wire::RoomKind::AppPlace, LOCKER)
                .title(&words::title(EN))
                .subtitle(&if first_use {
                    home_words::locker_step_one(EN)
                } else {
                    words::locked_subtitle(EN)
                })
                .secure()
                .band(locker_band(&mut b.sel, LOCKER, false))
                .ready(vec![wall])
                .build();
        }

        let page = match &self.filter_type {
            Some(item_type) => b.reload(
                &reads::ITEMS_BY_TYPE,
                &Args::new().text("item_type", item_type),
                self.page_size(),
            ),
            None => b.reload(&reads::ITEMS, &Args::new(), self.page_size()),
        };
        let page = match page {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, LOCKER)
                    .title(&words::title(EN))
                    .secure()
                    .band(locker_band(&mut b.sel, LOCKER, true))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        // Locker search reads only plaintext metadata and fields.
        let term = b.ui.search_term().trim().to_lowercase();
        let filtered: Vec<&reads::LockerItemSummary> = page
            .rows
            .iter()
            .filter(|item| {
                if term.is_empty() {
                    true
                } else {
                    item.title.to_lowercase().contains(&term)
                        || type_label(&item.item_type).to_lowercase().contains(&term)
                }
            })
            .collect();

        let filtered_empty_first =
            filtered.is_empty() && term.is_empty() && self.filter_type.is_none();
        b.ui.list(filtered.iter().map(|item| item.id.clone()));
        let selecting = b.ui.selecting();
        let picked: Vec<String> = b.ui.picked().map(str::to_owned).collect();
        let blocks_out = if filtered.is_empty() {
            vec![blocks::empty(
                glyph("Lock", "app.locker"),
                &home_words::locker_step_two_title(EN),
                &home_words::locker_step_two_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "empty/add",
                    &words::item_add(EN),
                    "Add",
                    Handler::Open(NEW_ITEM.to_owned()),
                )),
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = filtered
                .iter()
                .map(|item| item_row(&mut b.sel, item, selecting, b.ui.is_picked(&item.id)))
                .collect();
            let mut section =
                blocks::section(&mut b.sel, "section/items", &words::tab_items(EN)).blocks(rows);
            if page.next.is_some() && term.is_empty() {
                section = section.next_page(&mut b.sel, "section/items/next");
            }
            vec![section.into_block()]
        };

        let mut type_items = vec![{
            let mut all = blocks::menu_item(
                &mut b.sel,
                "filter/type/all",
                &words::filter_all_types(EN),
                Handler::Tag("type:all".to_owned()),
            );
            all.checked = self.filter_type.is_none();
            all
        }];
        for code in ITEM_TYPES {
            let mut item = blocks::menu_item(
                &mut b.sel,
                &format!("filter/type/{code}"),
                &type_label(code),
                Handler::Tag(format!("type:{code}")),
            );
            item.checked = self.filter_type.as_deref() == Some(code);
            type_items.push(item);
        }
        let filter_menu = blocks::menu(
            "locker-filter-menu",
            vec![blocks::menu_section(
                &words::item_type_label(EN),
                type_items,
            )],
            &mut b.sel,
        );
        let selected_count = words::selected_count(EN, picked.len() as u64);
        let selection = selection_actions(&mut b.sel, &picked, false);

        room(wire::RoomKind::AppPlace, LOCKER)
            .title(&words::title(EN))
            .subtitle(&if filtered_empty_first {
                home_words::locker_step_two(EN)
            } else {
                words::unlocked_subtitle(EN)
            })
            .secure()
            .filter(&mut b.sel, filter_menu, b.ui)
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Add",
                &words::item_add(EN),
                Handler::Open(NEW_ITEM.to_owned()),
            )
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN))
            .selection(&mut b.sel, b.ui, &selected_count, selection)
            .band(locker_band(&mut b.sel, LOCKER, true))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(tag) {
            return outcome;
        }
        if tag == "locker:lock" {
            match e.door.locker_lock() {
                Ok(()) => {
                    let mut outcome = Outcome::replace(LOCKER);
                    outcome.effect =
                        Some(("locker:clipboard_clear".to_owned(), clipboard_clear(e.door)));
                    return outcome;
                }
                Err(_) => return Outcome::refuse(&words::wall_unlock_failed(EN)),
            }
        }
        if tag == "locker:unlock" {
            if let Input::Effect(result) = input {
                return match &result.outcome {
                    Some(wire::shell_effect_result::Outcome::Owner(owner)) if owner.cancelled => {
                        Outcome::default()
                    }
                    Some(wire::shell_effect_result::Outcome::Owner(owner)) if owner.no_passcode => {
                        self.unlock_failure = words::wall_no_passcode(EN);
                        Outcome::refuse(&self.unlock_failure)
                    }
                    Some(wire::shell_effect_result::Outcome::Owner(owner)) if owner.passed => {
                        match e.door.locker_unlock() {
                            Ok((cleared, _)) => {
                                self.unlock_failure.clear();
                                if cleared > 0 {
                                    Outcome::say(&fill(
                                        &words::wall_unlock_cleared(EN),
                                        &[("count", &cleared.to_string())],
                                    ))
                                } else {
                                    Outcome::default()
                                }
                            }
                            Err(_) => Outcome::refuse(&words::wall_unlock_failed(EN)),
                        }
                    }
                    Some(wire::shell_effect_result::Outcome::Failed(failed))
                        if failed.cancelled =>
                    {
                        Outcome::default()
                    }
                    Some(wire::shell_effect_result::Outcome::Owner(_)) => {
                        match e.door.locker_unlock_failed() {
                            Ok(_) => {
                                self.unlock_failure = words::wall_unlock_failed(EN);
                                Outcome::refuse(&self.unlock_failure)
                            }
                            Err(_) => Outcome::refuse(&words::wall_unlock_failed(EN)),
                        }
                    }
                    _ => Outcome::refuse(&words::wall_unlock_failed(EN)),
                };
            }
            if matches!(input, Input::Tap) {
                return Outcome::effect(
                    "locker:unlock",
                    wire::shell_effect::Kind::OwnerCheck(wire::ShellOwnerCheck {
                        reason: words::wall_body(EN),
                        ..wire::ShellOwnerCheck::default()
                    }),
                );
            }
            return Outcome::default();
        }
        if tag == "type:all" {
            self.filter_type = None;
            self.loaded = 50;
            return Outcome::default();
        }
        if let Some(code) = tag.strip_prefix("type:") {
            self.filter_type = Some(code.to_owned());
            self.loaded = 50;
            return Outcome::default();
        }
        if tag == "next_page" {
            self.loaded = self.page_size().saturating_add(50);
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct LockerStarredRoom {
    loaded: usize,
}

impl LockerStarredRoom {
    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for LockerStarredRoom {
    fn key(&self) -> String {
        STARRED.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let page = match b.reload(&reads::STARRED, &Args::new(), self.page_size()) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::AppPlace, STARRED)
                    .title(&words::tab_starred(EN))
                    .secure()
                    .band(locker_band(&mut b.sel, STARRED, false))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        b.ui.list(page.rows.iter().map(|item| item.id.clone()));
        let selecting = b.ui.selecting();
        let picked: Vec<String> = b.ui.picked().map(str::to_owned).collect();
        let blocks_out = if page.rows.is_empty() {
            vec![blocks::empty(
                glyph("Star", "app.locker"),
                &words::starred_empty_title(EN),
                &words::starred_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = page
                .rows
                .iter()
                .map(|item| item_row(&mut b.sel, item, selecting, b.ui.is_picked(&item.id)))
                .collect();
            let mut section =
                blocks::section(&mut b.sel, "section/starred", &words::tab_starred(EN))
                    .blocks(rows);
            if page.next.is_some() {
                section = section.next_page(&mut b.sel, "section/starred/next");
            }
            vec![section.into_block()]
        };
        let selected_count = words::selected_count(EN, picked.len() as u64);
        let selection = selection_actions(&mut b.sel, &picked, true);

        room(wire::RoomKind::AppPlace, STARRED)
            .title(&words::tab_starred(EN))
            .secure()
            .selection(&mut b.sel, b.ui, &selected_count, selection)
            .band(locker_band(&mut b.sel, STARRED, false))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(outcome) = handle_band_nav(tag) {
            return outcome;
        }
        if tag == "next_page" {
            self.loaded = self.page_size().saturating_add(50);
        }
        Outcome::default()
    }
}

struct LockerDetailRoom {
    id: String,
    revealed: BTreeMap<String, Zeroizing<String>>,
    plain_values: BTreeMap<String, String>,
    revision_seq: Option<i64>,
}

impl LockerDetailRoom {
    fn new(id: String) -> Self {
        Self {
            id,
            revealed: BTreeMap::new(),
            plain_values: BTreeMap::new(),
            revision_seq: None,
        }
    }
}

impl RoomScreen for LockerDetailRoom {
    fn key(&self) -> String {
        format!("locker/item/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let item = match b.run(&reads::ITEM_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => match ans.rows.into_iter().next() {
                Some(row) => row,
                None => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&words::title(EN))
                        .secure()
                        .back(&mut b.sel, &words::title(EN))
                        .failed(&mut b.sel, &shared::read_failed(EN), &shared::kit_retry(EN))
                        .build();
                }
            },
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::title(EN))
                    .secure()
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let revisions = b
            .run(
                &entity_reads::REVISION_HEAD,
                &Args::new().text("id", &self.id),
            )
            .map(|answer| answer.rows)
            .unwrap_or_default();
        let revision_seq = revisions.first().map(|head| head.seq);
        if self.revision_seq != revision_seq {
            self.revealed.clear();
            self.revision_seq = revision_seq;
        }

        let fields = b
            .run(
                &reads::FIELDS_OF_ITEM,
                &Args::new().text("item_id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        self.plain_values = fields
            .iter()
            .filter_map(|field| {
                field
                    .value_text
                    .as_ref()
                    .map(|value| (field.id.clone(), value.clone()))
            })
            .collect();
        let passkeys = b
            .run(
                &reads::PASSKEYS_OF_ITEM,
                &Args::new().text("item_id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let type_name = type_label(&item.item_type);
        let mut hero = blocks::hero(&item.title)
            .noun(&type_name)
            .mark(blocks::glyph_mark("Lock", "app.locker"));
        if item.compromised {
            hero = hero.chip(blocks::chip(
                &words::chip_compromised(EN),
                wire::RoomTone::Warning,
            ));
        }
        let used_line = item.last_used_at.as_deref().map_or_else(
            || words::item_never_used(EN),
            |at| format!("{}: {}", words::item_last_used(EN), &at[..10.min(at.len())]),
        );
        hero = hero.line(&used_line);

        let mut blocks_out = vec![hero.block()];

        let mut plain_and_sealed_facts = Vec::new();
        let mut file_facts = Vec::new();
        for f in &fields {
            match f.kind.as_str() {
                "sealed" | "otp" => {
                    if let Some(value) = self.revealed.get(&f.id) {
                        let mut fact =
                            blocks::fact(&f.label, value.as_str(), wire::RoomFactKind::Secret);
                        fact.sealed = false;
                        let mut fact = blocks::fact_actions(
                            &mut b.sel,
                            fact,
                            &format!("field/{}", f.id),
                            None,
                            Some(Handler::Tag(format!("copy:{}", f.id))),
                        );
                        fact.reveal_selector_id = b.sel.on(
                            format!("field/{}/hide", f.id),
                            Handler::Tag(format!("hide:{}", f.id)),
                        );
                        plain_and_sealed_facts.push(fact);
                    } else {
                        let mut fact = blocks::sealed_fact(
                            &mut b.sel,
                            &f.label,
                            &format!("field/{}", f.id),
                            Handler::Tag(format!("reveal:{}", f.id)),
                        );
                        fact.copy_selector_id = b.sel.on(
                            format!("field/{}/copy", f.id),
                            Handler::Tag(format!("copy:{}", f.id)),
                        );
                        plain_and_sealed_facts.push(fact);
                    }
                }
                "file" => {
                    // A sealed capture file has no plaintext name or bytes to show.
                    let mut fact =
                        blocks::fact(&words::item_file_hidden(EN), "", wire::RoomFactKind::Secret);
                    fact.sealed = true;
                    file_facts.push(fact);
                }
                "url" => {
                    let val = f.value_text.as_deref().unwrap_or_default();
                    plain_and_sealed_facts.push(blocks::fact_actions(
                        &mut b.sel,
                        blocks::fact(&f.label, val, wire::RoomFactKind::Link),
                        &format!("field/{}", f.id),
                        None,
                        Some(Handler::Tag(format!("copy:{}", f.id))),
                    ));
                }
                "date" => {
                    let val = f.value_text.as_deref().unwrap_or_default();
                    plain_and_sealed_facts.push(blocks::fact(
                        &f.label,
                        val,
                        wire::RoomFactKind::Date,
                    ));
                }
                _ => {
                    let val = f.value_text.as_deref().unwrap_or_default();
                    plain_and_sealed_facts.push(blocks::fact_actions(
                        &mut b.sel,
                        blocks::fact(&f.label, val, wire::RoomFactKind::Text),
                        &format!("field/{}", f.id),
                        None,
                        Some(Handler::Tag(format!("copy:{}", f.id))),
                    ));
                }
            }
        }
        if !plain_and_sealed_facts.is_empty() {
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/fields",
                    &words::item_fields_heading(EN),
                )
                .trailing(blocks::action(
                    &mut b.sel,
                    "fields/add",
                    &words::item_field_add(EN),
                    "Add",
                    Handler::Open(format!("locker/item/{}/field/new", self.id)),
                ))
                .block(blocks::facts(plain_and_sealed_facts))
                .into_block(),
            );
        } else {
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/fields",
                    &words::item_fields_heading(EN),
                )
                .trailing(blocks::action(
                    &mut b.sel,
                    "fields/add",
                    &words::item_field_add(EN),
                    "Add",
                    Handler::Open(format!("locker/item/{}/field/new", self.id)),
                ))
                .into_block(),
            );
        }

        if !file_facts.is_empty() {
            blocks_out.push(
                blocks::section(&mut b.sel, "section/files", &words::item_files_heading(EN))
                    .block(blocks::facts(file_facts))
                    .into_block(),
            );
        }

        if !passkeys.is_empty() {
            let pk_rows: Vec<wire::RoomBlock> = passkeys
                .iter()
                .map(|pk| {
                    let meta = pk.display_name.as_deref().unwrap_or_default();
                    let mut remove = blocks::menu_item(
                        &mut b.sel,
                        &format!("pk/{}/remove", pk.id),
                        &words::item_passkey_remove(EN),
                        Handler::Act(Act::new(
                            "locker.remove_passkey",
                            json!({ "item_id": self.id, "passkey_id": pk.id }),
                        )),
                    );
                    remove.destructive = true;
                    let rename = blocks::menu_item(
                        &mut b.sel,
                        &format!("pk/{}/rename", pk.id),
                        &words::item_passkey_rename(EN),
                        Handler::Open(format!("locker/item/{}/passkey/{}/rename", self.id, pk.id)),
                    );
                    let menu = blocks::menu(
                        &format!("pk/{}/menu", pk.id),
                        vec![blocks::menu_section("", vec![rename, remove])],
                        &mut b.sel,
                    );
                    blocks::still_row(&mut b.sel, &format!("pk/{}", pk.id), &pk.rp_id)
                        .meta(meta)
                        .menu(menu)
                        .into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/passkeys",
                    &words::item_passkeys_heading(EN),
                )
                .blocks(pk_rows)
                .into_block(),
            );
        }

        if let Ok(atts) = b.run(
            &entity_reads::ATTACHMENTS,
            &Args::new().text("id", &self.id),
        ) && !atts.rows.is_empty()
        {
            let rows = atts
                .rows
                .iter()
                .map(|a| {
                    blocks::still_row(&mut b.sel, &format!("att/{}", a.id), &a.title)
                        .meta(&a.kind)
                        .build()
                })
                .collect();
            blocks_out.push(blocks::attachments(
                &words::attachments_heading(EN),
                rows,
                None,
            ));
        }

        if let Ok(links) = b.run(&entity_reads::LINKED, &Args::new().text("id", &self.id)) {
            let mut rows = Vec::new();
            for other_id in &links.rows {
                if let Ok(meta) =
                    b.run(&entity_reads::META_BY_ID, &Args::new().text("id", other_id))
                    && let Some(meta) = meta.rows.into_iter().next()
                {
                    rows.push(
                        blocks::row(
                            &mut b.sel,
                            &format!("link/{}", meta.id),
                            &meta.title,
                            Handler::Tag(format!("open:{}:{}", meta.kind, meta.id)),
                        )
                        .menu(super::link_picker::unlink_menu(&mut b.sel, &meta.id))
                        .build(),
                    );
                }
            }
            let add = blocks::action(
                &mut b.sel,
                "footer/linked/add",
                &shared::link_add(EN),
                "",
                Handler::Tag("link:add".to_owned()),
            );
            blocks_out.push(blocks::linked(&words::linked_heading(EN), rows, Some(add)));
        }

        if let Ok(mentions) = b.run(
            &entity_reads::MENTIONED_IN,
            &Args::new().text("id", &self.id),
        ) && !mentions.rows.is_empty()
        {
            let rows = mentions
                .rows
                .iter()
                .map(|m| {
                    blocks::still_row(&mut b.sel, &format!("mention/{}", m.id), &m.title).build()
                })
                .collect();
            blocks_out.push(blocks::mentioned_in(&words::mentioned_heading(EN), rows));
        }

        if let Some(head) = revisions.first().filter(|head| head.count > 0) {
            blocks_out.push(blocks::earlier_versions(
                &mut b.sel,
                &words::earlier_versions_summary(EN),
                u32::try_from(head.count).unwrap_or(u32::MAX),
                Handler::Open(format!("locker/item/{}/versions", self.id)),
            ));
        }

        if let Some(label) = item.arrived_label.as_deref() {
            let line = fill(&shared::origin_line(EN), &[("label", label)]);
            blocks_out.push(blocks::origin(&mut b.sel, &line, None));
        }

        let starred = item.starred_at.is_some();
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
        let mut trash_item = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Act(Act::new("entity.trash", json!({ "ids": [self.id] }))),
        );
        trash_item.destructive = true;
        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/edit",
                        &words::item_menu_edit(EN),
                        Handler::Open(format!("locker/item/{}/edit", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/fields",
                        &words::item_field_manage(EN),
                        Handler::Open(format!("locker/item/{}/fields", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/type",
                        &words::item_change_type(EN),
                        Handler::Open(format!("locker/item/{}/type", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/star",
                        &if starred {
                            words::item_menu_unstar(EN)
                        } else {
                            words::item_menu_star(EN)
                        },
                        Handler::Act(star_act),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/organize",
                        &shared::organize(EN),
                        Handler::Open(super::organize::route(std::slice::from_ref(&self.id))),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/lock",
                        &words::lock_action(EN),
                        Handler::Tag("locker:lock".to_owned()),
                    ),
                    trash_item,
                ],
            )],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&item.title)
            .secure()
            .back(&mut b.sel, &words::title(EN))
            .menu_key(&mut b.sel, "key/menu", &shared::kit_details(EN), menu)
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = super::link_picker::handle_unlink(e, tag, &self.id) {
            return outcome;
        }
        if tag == "link:add" {
            return Outcome::push(&format!("locker/item/{}/link", self.id));
        }
        if let Some((kind, id)) = tag
            .strip_prefix("open:")
            .and_then(|value| value.split_once(':'))
        {
            let route = match kind {
                "person" => format!("person/{id}"),
                "event" => format!("calendar/event/{id}"),
                "task" => format!("reminders/task/{id}"),
                "workout" => format!("health/workout/{id}"),
                "note" => format!("notes/note/{id}"),
                "document" => format!("docs/doc/{id}"),
                "photo" => format!("photos/photo/{id}"),
                "account" => format!("money/account/{id}"),
                "transaction" => format!("money/txn/{id}"),
                "locker_item" => format!("locker/item/{id}"),
                _ => return Outcome::default(),
            };
            return Outcome::push(&route);
        }
        if tag == "locker:lock" {
            if e.door.locker_lock().is_err() {
                return Outcome::refuse(&words::wall_unlock_failed(EN));
            }
            let mut outcome = Outcome::replace(LOCKER);
            outcome.effect = Some(("locker:clipboard_clear".to_owned(), clipboard_clear(e.door)));
            return outcome;
        }
        if tag == "locker:copy" {
            return match input {
                Input::Effect(result) => match &result.outcome {
                    Some(wire::shell_effect_result::Outcome::Done(_)) => {
                        Outcome::say(&words::item_copied(EN))
                    }
                    _ => Outcome::refuse(&words::item_copy_failed(EN)),
                },
                _ => Outcome::default(),
            };
        }
        if let Some(id) = tag.strip_prefix("reveal:") {
            match e.door.locker_reveal_field(&self.id, id) {
                Ok(value) => {
                    self.revealed.insert(id.to_owned(), value);
                    return Outcome::default();
                }
                Err(_) => return Outcome::refuse(&words::wall_unlock_failed(EN)),
            }
        }
        if let Some(id) = tag.strip_prefix("hide:") {
            self.revealed.remove(id);
            return Outcome::default();
        }
        if let Some(id) = tag.strip_prefix("copy:") {
            if let Some(value) = self.plain_values.get(id) {
                if e.door
                    .command_result("locker.mark_used", &json!({ "item_id": self.id }))
                    .is_err()
                {
                    return Outcome::refuse(&words::item_copy_failed(EN));
                }
                return Outcome::effect("locker:copy", clipboard_copy(e.door, value));
            }
            return match e.door.locker_reveal_field(&self.id, id) {
                Ok(value) => Outcome::effect("locker:copy", clipboard_copy(e.door, value.as_str())),
                Err(_) => Outcome::refuse(&words::item_copy_failed(EN)),
            };
        }
        Outcome::default()
    }
}

struct LockerItemForm {
    id: Option<String>,
    item_type: String,
    loaded: bool,
    dirty: bool,
    expected_rev: Option<i64>,
}

struct PasskeyRenameForm {
    item_id: String,
    passkey_id: String,
    dirty: bool,
}

impl PasskeyRenameForm {
    fn new(item_id: String, passkey_id: String) -> Self {
        Self {
            item_id,
            passkey_id,
            dirty: false,
        }
    }
}

impl RoomScreen for PasskeyRenameForm {
    fn key(&self) -> String {
        format!(
            "locker/item/{}/passkey/{}/rename",
            self.item_id, self.passkey_id
        )
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let passkey = b
            .run(
                &reads::PASSKEYS_OF_ITEM,
                &Args::new().text("item_id", &self.item_id),
            )
            .ok()
            .and_then(|answer| {
                answer
                    .rows
                    .into_iter()
                    .find(|row| row.id == self.passkey_id)
            });
        let Some(passkey) = passkey else {
            return room(wire::RoomKind::Editor, &self.key())
                .title(&words::item_passkey_rename(EN))
                .secure()
                .back(&mut b.sel, &words::title(EN))
                .failed(&mut b.sel, &shared::read_failed(EN), &shared::kit_retry(EN))
                .build();
        };
        let field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "display_name",
            &words::item_passkey_name(EN),
            wire::RoomTextKind::Line,
            passkey.display_name.as_deref().unwrap_or_default(),
            MAX_TEXT,
        )
        .focused()
        .build();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("passkey:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: self.dirty,
                drafted: false,
            },
        );
        room(wire::RoomKind::Editor, &self.key())
            .title(&words::item_passkey_rename(EN))
            .secure()
            .back(&mut b.sel, &words::title(EN))
            .ready(vec![form::form(
                vec![field],
                Vec::new(),
                Save::Explicit(save),
            )])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if matches!(input, Input::Text(_)) {
            self.dirty = true;
            return Outcome::default();
        }
        if tag != "passkey:save" {
            return Outcome::default();
        }
        let display_name =
            e.ui.fields
                .value("display_name")
                .unwrap_or_default()
                .trim()
                .to_owned();
        let passkey = match e.door.reader().and_then(|reader| {
            reader
                .run(
                    &reads::PASSKEYS_OF_ITEM,
                    &Args::new().text("item_id", &self.item_id),
                )
                .map_err(|error| super::door::Refused(error.to_string()))
        }) {
            Ok(answer) => answer
                .rows
                .into_iter()
                .find(|row| row.id == self.passkey_id),
            Err(refused) => return Outcome::refuse(&refused.0),
        };
        let Some(passkey) = passkey else {
            return Outcome::refuse(&shared::read_failed(EN));
        };
        match e.door.act(&Act::new(
            "locker.set_passkey",
            json!({
                "item_id": self.item_id,
                "passkey_id": self.passkey_id,
                "rp_id": passkey.rp_id,
                "display_name": display_name,
            }),
        )) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

impl LockerItemForm {
    fn new_item() -> Self {
        Self {
            id: None,
            item_type: "login".to_owned(),
            loaded: false,
            dirty: false,
            expected_rev: None,
        }
    }

    fn edit_item(id: String) -> Self {
        Self {
            id: Some(id),
            item_type: "login".to_owned(),
            loaded: false,
            dirty: false,
            expected_rev: None,
        }
    }
}

impl RoomScreen for LockerItemForm {
    fn key(&self) -> String {
        match &self.id {
            Some(id) => format!("locker/item/{id}/edit"),
            None => NEW_ITEM.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            if let Some(id) = &self.id {
                if let Ok(ans) = b.run(&reads::ITEM_BY_ID, &Args::new().text("id", id))
                    && let Some(item) = ans.rows.into_iter().next()
                {
                    self.item_type = item.item_type;
                    b.ui.fields.get_or("title", &item.title);
                }
                if let Ok(rev) = b.run(&entity_reads::REVISION_HEAD, &Args::new().text("id", id))
                    && let Some(head) = rev.rows.first()
                {
                    self.expected_rev = Some(head.seq);
                }
            }
            self.loaded = true;
        }

        let type_options: Vec<wire::RoomOption> = ITEM_TYPES
            .iter()
            .map(|code| blocks::option(code, &type_label(code), *code == self.item_type))
            .collect();
        let type_choice = blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/type",
            &words::item_type_label(EN),
            wire::RoomChoiceStyle::Menu,
            false,
            type_options,
            "item:type",
        ));

        let title_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            &words::item_title_label(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .focused()
        .build();

        // Locker forms keep edits in memory until an explicit save.
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("item:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: self.dirty,
                drafted: false,
            },
        );
        let form_block = form::form(vec![title_field], Vec::new(), Save::Explicit(save));

        let title = if self.id.is_some() {
            words::item_edit(EN)
        } else {
            words::item_add(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .secure()
            .ready(vec![type_choice, form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if tag == "item:type" {
            if let Input::Option(code) = input {
                self.item_type = code.clone();
                self.dirty = true;
            }
            return Outcome::default();
        }
        if matches!(input, Input::Text(_)) {
            self.dirty = true;
            return Outcome::default();
        }
        if tag != "item:save" {
            return Outcome::default();
        }
        let title =
            e.ui.fields
                .value("title")
                .unwrap_or_default()
                .trim()
                .to_owned();
        if title.is_empty() {
            return Outcome::refuse(&words::item_title_required(EN));
        }
        let act = if let Some(id) = &self.id {
            let mut obj = Map::new();
            obj.insert("item_id".to_owned(), Value::String(id.clone()));
            obj.insert("title".to_owned(), Value::String(title));
            obj.insert("type".to_owned(), Value::String(self.item_type.clone()));
            if let Some(rev) = self.expected_rev {
                obj.insert("expected_rev".to_owned(), json!(rev));
            }
            Act::new("locker.edit_item", Value::Object(obj))
        } else {
            let new_id = mint_uuid_v7(e.door.now_ms());
            Act::new(
                "locker.add_item",
                json!({
                    "item_id": new_id,
                    "type": self.item_type,
                    "title": title,
                }),
            )
        };
        match e.door.act(&act) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct ChangeTypeRoom {
    id: String,
    current_type: String,
    loaded: bool,
}

impl ChangeTypeRoom {
    fn new(id: String) -> Self {
        Self {
            id,
            current_type: "login".to_owned(),
            loaded: false,
        }
    }
}

impl RoomScreen for ChangeTypeRoom {
    fn key(&self) -> String {
        format!("locker/item/{}/type", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            if let Ok(ans) = b.run(&reads::ITEM_BY_ID, &Args::new().text("id", &self.id))
                && let Some(item) = ans.rows.into_iter().next()
            {
                self.current_type = item.item_type;
            }
            self.loaded = true;
        }
        let rows: Vec<wire::RoomBlock> = ITEM_TYPES
            .iter()
            .map(|code| {
                blocks::row(
                    &mut b.sel,
                    &format!("type/{code}"),
                    &type_label(code),
                    Handler::Tag(format!("set_type:{code}")),
                )
                .selected(*code == self.current_type)
                .into_block()
            })
            .collect();
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::item_change_type(EN))
            .secure()
            .back(&mut b.sel, &words::title(EN))
            .ready(vec![
                blocks::section(&mut b.sel, "section/types", &words::item_type_label(EN))
                    .blocks(rows)
                    .into_block(),
            ])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        let Some(new_type) = tag.strip_prefix("set_type:") else {
            return Outcome::default();
        };
        match e.door.act(&Act::new(
            "locker.edit_item",
            json!({ "item_id": self.id, "type": new_type }),
        )) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct LockerFieldsRoom {
    item_id: String,
}

impl LockerFieldsRoom {
    fn new(item_id: String) -> Self {
        Self { item_id }
    }
}

impl RoomScreen for LockerFieldsRoom {
    fn key(&self) -> String {
        format!("locker/item/{}/fields", self.item_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let fields = match b.run(
            &reads::FIELDS_OF_ITEM,
            &Args::new().text("item_id", &self.item_id),
        ) {
            Ok(answer) => answer.rows,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::item_fields_heading(EN))
                    .secure()
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let rows: Vec<wire::RoomBlock> = fields
            .iter()
            .map(|field| {
                let label = if field.kind == "sealed" || field.kind == "otp" {
                    format!("{} · ••••••", field.label)
                } else {
                    field.label.clone()
                };
                let edit = blocks::menu_item(
                    &mut b.sel,
                    &format!("field/{}/edit", field.id),
                    &words::item_field_edit(EN),
                    Handler::Open(format!(
                        "locker/item/{}/field/{}/edit",
                        self.item_id, field.id
                    )),
                );
                let mut remove = blocks::menu_item(
                    &mut b.sel,
                    &format!("field/{}/remove", field.id),
                    &words::item_field_remove(EN),
                    Handler::Act(Act::new(
                        "locker.remove_field",
                        json!({ "item_id": self.item_id, "field_id": field.id }),
                    )),
                );
                remove.destructive = true;
                let menu = blocks::menu(
                    &format!("field/{}/menu", field.id),
                    vec![blocks::menu_section("", vec![edit, remove])],
                    &mut b.sel,
                );
                blocks::still_row(&mut b.sel, &format!("field/{}", field.id), &label)
                    .meta(&field_kind_label(&field.kind))
                    .menu(menu)
                    .into_block()
            })
            .collect();
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::item_fields_heading(EN))
            .secure()
            .back(&mut b.sel, &words::title(EN))
            .ready(vec![
                blocks::section(
                    &mut b.sel,
                    "section/fields",
                    &words::item_fields_heading(EN),
                )
                .blocks(rows)
                .into_block(),
            ])
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, _: &str, _: &Input) -> Outcome {
        Outcome::default()
    }
}

struct AddFieldForm {
    item_id: String,
    field_id: Option<String>,
    kind: String,
    original_kind: Option<String>,
    label: String,
    value: String,
    loaded: bool,
    dirty: bool,
}

impl AddFieldForm {
    fn new(item_id: String) -> Self {
        Self {
            item_id,
            field_id: None,
            kind: "text".to_owned(),
            original_kind: None,
            label: String::new(),
            value: String::new(),
            loaded: true,
            dirty: false,
        }
    }

    fn edit(item_id: String, field_id: String) -> Self {
        Self {
            item_id,
            field_id: Some(field_id),
            kind: "text".to_owned(),
            original_kind: None,
            label: String::new(),
            value: String::new(),
            loaded: false,
            dirty: false,
        }
    }
}

impl RoomScreen for AddFieldForm {
    fn key(&self) -> String {
        match &self.field_id {
            Some(field_id) => format!("locker/item/{}/field/{field_id}/edit", self.item_id),
            None => format!("locker/item/{}/field/new", self.item_id),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded {
            if let Ok(answer) = b.run(
                &reads::FIELDS_OF_ITEM,
                &Args::new().text("item_id", &self.item_id),
            ) && let Some(field) = answer
                .rows
                .into_iter()
                .find(|field| Some(field.id.as_str()) == self.field_id.as_deref())
            {
                self.kind = field.kind;
                self.original_kind = Some(self.kind.clone());
                self.label = field.label;
                if !matches!(self.kind.as_str(), "sealed" | "otp") {
                    self.value = field.value_text.unwrap_or_default();
                }
            }
            self.loaded = true;
        }
        let kind_options: Vec<wire::RoomOption> = FIELD_KINDS
            .iter()
            .map(|kind| blocks::option(kind, &field_kind_label(kind), *kind == self.kind))
            .collect();
        let kind_choice = blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/kind",
            &words::item_field_kind(EN),
            wire::RoomChoiceStyle::Segmented,
            false,
            kind_options,
            "field:kind",
        ));
        let label = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "label",
            &words::item_field_label(EN),
            wire::RoomTextKind::Line,
            &self.label,
            MAX_TEXT,
        )
        .focused()
        .build();
        let value_label =
            if self.field_id.is_some() && matches!(self.kind.as_str(), "sealed" | "otp") {
                words::item_field_secret_replacement(EN)
            } else {
                words::item_field_value(EN)
            };
        let value_selector = format!("field/value/{}", self.kind);
        let value = if matches!(self.kind.as_str(), "sealed" | "otp") {
            form::secret_entry(
                &mut b.sel,
                &mut b.ui.fields,
                "value",
                &value_selector,
                &value_label,
            )
        } else {
            form::text_with_selector(
                &mut b.sel,
                &mut b.ui.fields,
                form::TextEntry {
                    name: "value",
                    selector: &value_selector,
                    label: &value_label,
                    kind: wire::RoomTextKind::Line,
                    initial: &self.value,
                    max_chars: centraid_vault::commands::locker::PLAIN_VALUE_BUDGET_BYTES,
                },
            )
        }
        .build();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("field:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty: self.dirty,
                drafted: false,
            },
        );
        let form_block = form::form(vec![label, value], Vec::new(), Save::Explicit(save));
        let title = if self.field_id.is_some() {
            words::item_field_edit(EN)
        } else {
            words::item_field_add(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .secure()
            .ready(vec![kind_choice, form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if tag == "field:kind" {
            if let Input::Option(kind) = input {
                if kind != &self.kind {
                    e.ui.fields.reset("value", "");
                }
                self.kind = kind.clone();
                self.dirty = true;
            }
            return Outcome::default();
        }
        if matches!(input, Input::Text(_)) {
            self.dirty = true;
            return Outcome::default();
        }
        if tag != "field:save" {
            return Outcome::default();
        }
        let label =
            e.ui.fields
                .value("label")
                .unwrap_or_default()
                .trim()
                .to_owned();
        let raw_value = e.ui.fields.value("value").unwrap_or_default();
        let value = Zeroizing::new(if matches!(self.kind.as_str(), "sealed" | "otp") {
            raw_value.to_owned()
        } else {
            raw_value.trim().to_owned()
        });
        if label.is_empty() {
            return Outcome::refuse(&shared::write_refused(EN));
        }
        if !matches!(self.kind.as_str(), "sealed" | "otp")
            && value.len() > centraid_vault::commands::locker::PLAIN_VALUE_BUDGET_BYTES
        {
            return Outcome::refuse(&shared::write_refused(EN));
        }
        let field_id = self
            .field_id
            .clone()
            .unwrap_or_else(|| mint_uuid_v7(e.door.now_ms()));
        let mut input = json!({
            "item_id": self.item_id,
            "field_id": field_id,
            "label": label,
            "kind": self.kind,
        });
        if value.is_empty() && matches!(self.kind.as_str(), "sealed" | "otp") {
            if self.field_id.is_none()
                || self
                    .original_kind
                    .as_deref()
                    .is_none_or(|kind| kind != self.kind.as_str())
            {
                return Outcome::refuse(&shared::write_refused(EN));
            }
        } else if matches!(self.kind.as_str(), "sealed" | "otp") {
            let (sealed, key_id) = match e.door.locker_seal_field(&field_id, &value) {
                Ok(sealed) => sealed,
                Err(_) => return Outcome::refuse(&shared::write_refused(EN)),
            };
            input["value"] = Value::String(sealed);
            input["key_id"] = Value::String(key_id);
            input["changed"] = Value::Bool(true);
        } else {
            input["value"] = Value::String(value.to_string());
        }
        match e.door.act(&Act::new("locker.set_field", input)) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct ExpiryAlertsRoom;

impl RoomScreen for ExpiryAlertsRoom {
    fn key(&self) -> String {
        ALERTS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let alerts = match b.run(&reads::EXPIRY_ALERTS, &Args::new()) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, ALERTS)
                    .title(&words::alerts_title(EN))
                    .secure()
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let blocks_out = if alerts.is_empty() {
            vec![blocks::empty(
                glyph("Bell", "app.locker"),
                &words::alerts_empty_title(EN),
                &words::alerts_empty_body(EN),
                None,
            )]
        } else {
            let until = centraid_vault::clock::format_iso_ms(b.door.now_ms() + 3_600_000);
            let rows: Vec<wire::RoomBlock> = alerts
                .iter()
                .map(|a| {
                    // The alert stays masked and can only be snoozed.
                    let snooze_menu = blocks::menu(
                        &format!("alert/{}/menu", a.id),
                        vec![blocks::menu_section(
                            "",
                            vec![blocks::menu_item(
                                &mut b.sel,
                                &format!("alert/{}/snooze", a.id),
                                &words::alert_snooze(EN),
                                Handler::Act(Act::new(
                                    "alert.snooze",
                                    json!({
                                        "entity_id": a.item_id,
                                        "field_id": a.field_id,
                                        "until": until,
                                    }),
                                )),
                            )],
                        )],
                        &mut b.sel,
                    );
                    let mut row = blocks::row(
                        &mut b.sel,
                        &format!("alert/{}", a.id),
                        &words::alert_masked_title(EN),
                        Handler::Act(Act::new(
                            "alert.snooze",
                            json!({
                                "entity_id": a.item_id,
                                "field_id": a.field_id,
                                "until": until,
                            }),
                        )),
                    )
                    .menu(snooze_menu);
                    if a.snoozed_until.is_some() {
                        row = row.meta(&words::alert_snoozed_meta(EN));
                    }
                    row.into_block()
                })
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/alerts", &words::alerts_title(EN))
                    .blocks(rows)
                    .into_block(),
            ]
        };

        room(wire::RoomKind::PushedPage, ALERTS)
            .title(&words::alerts_title(EN))
            .secure()
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

struct EarlierVersionsRoom {
    id: String,
}

impl RoomScreen for EarlierVersionsRoom {
    fn key(&self) -> String {
        format!("locker/item/{}/versions", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let versions = match b.run(
            &entity_reads::EARLIER_VERSIONS,
            &Args::new().text("id", &self.id),
        ) {
            Ok(ans) => ans.rows,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::versions_title(EN))
                    .secure()
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let blocks_out = if versions.is_empty() {
            vec![blocks::empty(
                glyph("History", "app.locker"),
                &words::versions_empty_title(EN),
                &words::versions_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = versions
                .iter()
                .map(|v| {
                    let meta = format!("{} · {}", &v.at[..10.min(v.at.len())], v.actor);
                    blocks::row(
                        &mut b.sel,
                        &format!("rev/{}", v.seq),
                        &format!("v{}", v.seq),
                        Handler::Act(Act::new(
                            "history.restore_version",
                            json!({ "id": self.id, "seq": v.seq }),
                        )),
                    )
                    .meta(&meta)
                    .trailing(&words::version_restore(EN), wire::RoomTone::Neutral)
                    .into_block()
                })
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/versions", &words::versions_title(EN))
                    .blocks(rows)
                    .into_block(),
            ]
        };

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::versions_title(EN))
            .secure()
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }
}

#[derive(Default)]
struct LockerTrash {
    loaded: usize,
}

impl LockerTrash {
    fn page_size(&self) -> usize {
        if self.loaded == 0 { 50 } else { self.loaded }
    }
}

impl RoomScreen for LockerTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let page = match b.reload(&reads::TRASH, &Args::new(), self.page_size()) {
            Ok(ans) => ans,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&shared::trash_title(EN))
                    .secure()
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count = page.rows.len() as u64;
        let heading = if count == 0 {
            shared::trash_title(EN)
        } else {
            shared::trash_count(EN, count)
        };
        let blocks_out = if page.rows.is_empty() {
            vec![blocks::empty(
                glyph("Trash", ""),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomTrashRow> = page
                .rows
                .iter()
                .map(|item| {
                    let title = if item.title.is_empty() {
                        shared::trash_untitled(EN)
                    } else {
                        item.title.clone()
                    };
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        &item.deleted_at[..10.min(item.deleted_at.len())],
                        shared::trash_erased(EN),
                        &item.purge_at[..10.min(item.purge_at.len())],
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", item.id),
                        &title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [item.id] }))),
                        Handler::Open(format!("locker/trash/purge/{}", item.id)),
                    )
                })
                .collect();
            let empty_action = Some(blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("locker/trash/empty".to_owned()),
            ));
            let mut trash =
                blocks::trash(&heading, &shared::trash_entry_meta(EN), rows, empty_action);
            if page.next.is_some() {
                trash.next_page_selector_id = b
                    .sel
                    .on("trash/next", Handler::NextPage("trash".to_owned()));
            }
            vec![blocks::trash_block(trash)]
        };

        room(wire::RoomKind::PushedPage, TRASH)
            .title(&heading)
            .secure()
            .back(&mut b.sel, &words::title(EN))
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

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("locker/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(
            &shared::trash_purge_title(EN),
            &[("noun", &shared::trash_noun_item(EN))],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &words::trash_purge_body(EN),
                warning: "",
                confirm_label: &shared::trash_purge(EN),
                confirm: Handler::Tag("purge:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .secure()
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "purge:confirm" {
            return Outcome::default();
        }
        match e
            .door
            .act(&Act::new("entity.purge", json!({ "id": self.id })))
        {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "locker/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: "",
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("empty:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_title(EN))
            .secure()
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag != "empty:confirm" {
            return Outcome::default();
        }
        match e.door.act(&Act::new(
            "entity.empty_trash",
            json!({ "kinds": ["locker_item"] }),
        )) {
            Ok(_) => Outcome::pop(),
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}
