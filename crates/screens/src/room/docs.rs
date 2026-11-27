use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{docs as reads, entity as entity_reads};
use centraid_domain::read::Args;
use rand::RngCore as _;
use serde_json::json;

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, docs as words, fill, shared};

pub const DOCS: &str = "docs";
pub const FOLDERS: &str = "docs/folders";
pub const FOLLOWED: &str = "docs/followed";
pub const ADD_SHEET: &str = "docs/add";
pub const NEW_FOLDER: &str = "docs/folders/new";
pub const NEW_TEXT: &str = "docs/new-text";
pub const TRASH: &str = "docs/trash";

const EN: Locale = Locale::En;
const MAX_NAME_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 60_000;
const FILTER_STARRED: &str = "filter/starred";
const SORT_UPDATED: &str = "sort/updated";
const SORT_TITLE: &str = "sort/title";

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(DOCS, || Box::new(DocsList::default()))
        .exact(FOLDERS, || Box::new(FoldersList))
        .exact(FOLLOWED, || Box::new(FollowedFoldersPage))
        .exact(ADD_SHEET, || Box::new(AddDocSheet { folder_id: None }))
        .exact(NEW_FOLDER, || Box::new(NewFolderForm::new(None)))
        .exact(NEW_TEXT, || Box::new(TextDocForm::new_doc(None)))
        .exact(TRASH, || Box::new(DocsTrash::default()))
        .exact("docs/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("docs/add/in/") {
                return Some(Box::new(AddDocSheet {
                    folder_id: Some(id.to_owned()),
                }));
            }
            if let Some(id) = key.strip_prefix("docs/folders/new/in/") {
                return Some(Box::new(NewFolderForm::new(Some(id.to_owned()))));
            }
            if let Some(id) = key.strip_prefix("docs/new-text/in/") {
                return Some(Box::new(TextDocForm::new_doc(Some(id.to_owned()))));
            }
            if let Some(id) = key.strip_prefix("docs/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("docs/folder/") {
                if let Some(id) = rest.strip_suffix("/trash-confirm") {
                    return Some(Box::new(TrashFolderConfirm { id: id.to_owned() }));
                }
                return Some(Box::new(FolderDetail {
                    id: rest.to_owned(),
                    loaded: 50,
                }));
            }
            if let Some(rest) = key.strip_prefix("docs/doc/") {
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(TextDocForm::edit_doc(id.to_owned())));
                }
                if let Some(id) = rest.strip_suffix("/versions") {
                    return Some(Box::new(DocVersions { id: id.to_owned() }));
                }
                return Some(Box::new(DocDetail {
                    id: rest.to_owned(),
                }));
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

fn draft_key(door: &dyn Door, kind: &str) -> Option<String> {
    let vault = door.vault_id();
    if vault.is_empty() {
        None
    } else {
        Some(format!("draft.{vault}.{kind}"))
    }
}

fn format_bytes(bytes: i64) -> String {
    crate::kit::quantity::Quantity::bytes(bytes.max(0))
        .words(EN, crate::kit::quantity::UnitsPref::Metric)
}

fn short_day(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

fn docs_band(sel: &mut Sel, active_tab: &str) -> wire::RoomBand {
    let tabs = vec![
        frame::tab(
            sel,
            "tab/docs",
            &words::tab_docs(EN),
            "FileText",
            active_tab == DOCS,
        ),
        frame::tab(
            sel,
            "tab/folders",
            &words::tab_folders(EN),
            "Folder",
            active_tab == FOLDERS,
        ),
    ];
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
            "more/followed",
            &words::more_followed(EN),
            Handler::Open(FOLLOWED.to_owned()),
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

fn handle_more_or_nav(tag: &str) -> Option<Outcome> {
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/docs" => Some(Outcome::replace(DOCS)),
        "tab:tab/folders" => Some(Outcome::replace(FOLDERS)),
        "more:export" => Some(Outcome::say(&words::export_note(EN))),
        _ => None,
    }
}

fn doc_row_menu(sel: &mut Sel, prefix: &str, doc: &reads::DocRow) -> wire::RoomMenu {
    let id = &doc.id;
    let star_act = if doc.starred {
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
    let star_label = if doc.starred {
        words::menu_unstar(EN)
    } else {
        words::menu_star(EN)
    };
    let items = vec![
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/open"),
            &words::menu_open(EN),
            Handler::Open(format!("docs/doc/{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/star"),
            &star_label,
            Handler::Act(star_act),
        ),
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/share"),
            &words::menu_share(EN),
            Handler::Tag(format!("share:{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/select"),
            &words::menu_select(EN),
            Handler::SelectMode(true),
        ),
        trash,
    ];
    blocks::menu(
        &format!("{prefix}/{id}/menu"),
        vec![blocks::menu_section("", items)],
        sel,
    )
}

fn build_doc_row(
    sel: &mut Sel,
    prefix: &str,
    doc: &reads::DocRow,
    selecting: bool,
    selected: bool,
) -> wire::RoomBlock {
    let id = &doc.id;
    let tap = if selecting {
        Handler::Pick(id.clone())
    } else {
        Handler::Open(format!("docs/doc/{id}"))
    };
    let meta = format!("{} · {}", short_day(&doc.at), format_bytes(doc.size));
    let mut row = blocks::row(sel, &format!("{prefix}/{id}"), &doc.title, tap)
        .meta(&meta)
        .mark(blocks::glyph_mark("FileText", "docs"))
        .selected(selected);
    if doc.starred {
        row = row.chip(blocks::chip(
            &words::starred_chip(EN),
            wire::RoomTone::Accent,
        ));
    }
    if !selecting {
        let menu = doc_row_menu(sel, prefix, doc);
        row = row.menu(menu).swipe(
            sel,
            &format!("{prefix}/{id}/swipe"),
            &shared::trash_move(EN),
            Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
        );
    }
    row.into_block()
}

fn selection_actions(sel: &mut Sel, ids: &[String]) -> Vec<wire::RoomMenuItem> {
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
            "selection/star",
            &words::menu_star(EN),
            Handler::Act(Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": ids }),
            )),
        ),
        trash,
    ]
}

struct DocsList {
    loaded: usize,
    sort: &'static str,
}

impl Default for DocsList {
    fn default() -> Self {
        Self {
            loaded: 50,
            sort: SORT_UPDATED,
        }
    }
}

impl RoomScreen for DocsList {
    fn key(&self) -> String {
        DOCS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let only_starred = b.ui.is_filtered(FILTER_STARRED);
        let term = b.ui.search_term().trim().to_owned();

        let answer = if only_starred {
            b.reload(&reads::STARRED, &Args::new(), self.loaded)
        } else {
            b.reload(&reads::TOP_LEVEL, &Args::new(), self.loaded)
        };
        let answer = match answer {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, DOCS)
                    .title(&words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let mut rows = answer.rows;
        if !term.is_empty() {
            let needle = term.to_lowercase();
            rows.retain(|row| row.title.to_lowercase().contains(&needle));
        }
        if self.sort == SORT_TITLE {
            rows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        }

        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        b.ui.list(ids);

        let selecting = b.ui.selecting();
        let picked: Vec<String> = b.ui.picked().map(str::to_owned).collect();
        let count_str = words::docs_count(EN, rows.len() as u64);

        let mut filter_starred = blocks::menu_item(
            &mut b.sel,
            FILTER_STARRED,
            &words::filter_starred(EN),
            Handler::Filter(FILTER_STARRED.to_owned()),
        );
        filter_starred.checked = only_starred;
        let mut sort_updated = blocks::menu_item(
            &mut b.sel,
            SORT_UPDATED,
            &words::sort_updated(EN),
            Handler::Tag(SORT_UPDATED.to_owned()),
        );
        sort_updated.checked = self.sort == SORT_UPDATED;
        let mut sort_title = blocks::menu_item(
            &mut b.sel,
            SORT_TITLE,
            &words::sort_title(EN),
            Handler::Tag(SORT_TITLE.to_owned()),
        );
        sort_title.checked = self.sort == SORT_TITLE;

        let filter_menu = blocks::menu(
            "docs-filter-menu",
            vec![
                blocks::menu_section(&words::filter_section_show(EN), vec![filter_starred]),
                blocks::menu_section(
                    &words::filter_section_sort(EN),
                    vec![sort_updated, sort_title],
                ),
            ],
            &mut b.sel,
        );

        let mut content = Vec::new();
        if rows.is_empty() {
            if term.is_empty() {
                let add = blocks::action(
                    &mut b.sel,
                    "empty/add",
                    &words::add_menu(EN),
                    "Plus",
                    Handler::Open(ADD_SHEET.to_owned()),
                );
                content.push(blocks::empty(
                    glyph("FileText", "docs"),
                    &words::empty_docs_title(EN),
                    &words::empty_docs_body(EN),
                    Some(add),
                ));
            } else {
                let body = fill(&words::empty_search_body(EN), &[("term", &term)]);
                content.push(blocks::empty(
                    glyph("Search", "docs"),
                    &words::empty_search_title(EN),
                    &body,
                    None,
                ));
            }
        } else {
            let blocks_docs: Vec<_> = rows
                .iter()
                .map(|row| {
                    let sel_on = b.ui.is_picked(&row.id);
                    build_doc_row(&mut b.sel, "doc", row, selecting, sel_on)
                })
                .collect();
            let mut sec = blocks::section(
                &mut b.sel,
                "section/documents",
                &words::section_documents(EN),
            )
            .blocks(blocks_docs);
            if answer.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/documents/more");
            }
            content.push(sec.into_block());
        }

        let sel_actions = selection_actions(&mut b.sel, &picked);
        let sel_label = words::selected_count(EN, picked.len() as u64);
        let band = docs_band(&mut b.sel, DOCS);

        room(wire::RoomKind::AppPlace, DOCS)
            .title(&words::title(EN))
            .subtitle(&count_str)
            .filter(&mut b.sel, filter_menu, b.ui)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_menu(EN),
                Handler::Open(ADD_SHEET.to_owned()),
            )
            .band(band)
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN))
            .selection(&mut b.sel, b.ui, &sel_label, sel_actions)
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(out) = handle_more_or_nav(tag) {
            return out;
        }
        if tag == SORT_UPDATED {
            self.sort = SORT_UPDATED;
            return Outcome::default();
        }
        if tag == SORT_TITLE {
            self.sort = SORT_TITLE;
            return Outcome::default();
        }
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
            return Outcome::default();
        }
        if tag.starts_with("share:") {
            return Outcome::say(&words::shared(EN));
        }
        Outcome::default()
    }
}

struct AddDocSheet {
    folder_id: Option<String>,
}

impl RoomScreen for AddDocSheet {
    fn key(&self) -> String {
        match &self.folder_id {
            Some(id) => format!("docs/add/in/{id}"),
            None => ADD_SHEET.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let text_route = match &self.folder_id {
            Some(id) => format!("docs/new-text/in/{id}"),
            None => NEW_TEXT.to_owned(),
        };
        let folder_route = match &self.folder_id {
            Some(id) => format!("docs/folders/new/in/{id}"),
            None => NEW_FOLDER.to_owned(),
        };
        let menu = blocks::menu(
            "add/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "add/scan",
                        &words::add_scan(EN),
                        Handler::Tag("scan".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "add/file",
                        &words::add_choose_file(EN),
                        Handler::Tag("file".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "add/text",
                        &words::add_text_doc(EN),
                        Handler::Open(text_route),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "add/folder",
                        &words::add_folder(EN),
                        Handler::Open(folder_route),
                    ),
                ],
            )],
            &mut b.sel,
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::add_menu(EN))
            .ready(vec![blocks::menu_block(menu)])
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        match tag {
            "scan" => Outcome::say(&words::scan_note(EN)),
            "file" => Outcome::say(&words::choose_file_note(EN)),
            _ => Outcome::default(),
        }
    }
}

struct FoldersList;

impl RoomScreen for FoldersList {
    fn key(&self) -> String {
        FOLDERS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let folders = match b.run(&reads::FOLDERS, &Args::new()) {
            Ok(answer) => answer.rows,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, FOLDERS)
                    .title(&words::folders_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count_str = words::folders_count(EN, folders.len() as u64);
        let mut content = Vec::new();
        if folders.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_folder(EN),
                "FolderPlus",
                Handler::Open(NEW_FOLDER.to_owned()),
            );
            content.push(blocks::empty(
                glyph("Folder", "docs"),
                &words::empty_folders_title(EN),
                &words::empty_folders_body(EN),
                Some(add),
            ));
        } else {
            let rows: Vec<_> = folders
                .iter()
                .map(|folder| {
                    let id = &folder.id;
                    let mut trash = blocks::menu_item(
                        &mut b.sel,
                        &format!("folder/{id}/menu/trash"),
                        &shared::trash_move(EN),
                        Handler::Open(format!("docs/folder/{id}/trash-confirm")),
                    );
                    trash.destructive = true;
                    let menu = blocks::menu(
                        &format!("folder/{id}/menu"),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("folder/{id}/menu/open"),
                                    &words::menu_open(EN),
                                    Handler::Open(format!("docs/folder/{id}")),
                                ),
                                trash,
                            ],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("folder/{id}"),
                        &folder.title,
                        Handler::Open(format!("docs/folder/{id}")),
                    )
                    .mark(blocks::glyph_mark("Folder", "docs"))
                    .menu(menu)
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/folders", &words::section_folders(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }

        let band = docs_band(&mut b.sel, FOLDERS);
        room(wire::RoomKind::AppPlace, FOLDERS)
            .title(&words::folders_title(EN))
            .subtitle(&count_str)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_folder(EN),
                Handler::Open(NEW_FOLDER.to_owned()),
            )
            .band(band)
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        handle_more_or_nav(tag).unwrap_or_default()
    }
}

struct FolderDetail {
    id: String,
    loaded: usize,
}

impl RoomScreen for FolderDetail {
    fn key(&self) -> String {
        format!("docs/folder/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let meta = match b.run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::folders_title(EN))
                    .back(&mut b.sel, &words::folders_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(folder) = meta else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::folders_title(EN))
                .back(&mut b.sel, &words::folders_title(EN))
                .ready(vec![blocks::empty(
                    glyph("Folder", "docs"),
                    &words::folder_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let subfolders = b
            .run(&reads::SUBFOLDERS, &Args::new().text("folder", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let docs = match b.reload(
            &reads::IN_FOLDER,
            &Args::new().text("folder", &self.id),
            self.loaded,
        ) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&folder.title)
                    .back(&mut b.sel, &words::folders_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let add_in_folder = format!("docs/add/in/{}", self.id);
        let mut content = Vec::new();
        if subfolders.is_empty() && docs.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_menu(EN),
                "Plus",
                Handler::Open(add_in_folder.clone()),
            );
            content.push(blocks::empty(
                glyph("Folder", "docs"),
                &words::empty_folder_title(EN),
                &words::empty_folder_body(EN),
                Some(add),
            ));
        } else {
            if !subfolders.is_empty() {
                let rows: Vec<_> = subfolders
                    .iter()
                    .map(|sub| {
                        blocks::row(
                            &mut b.sel,
                            &format!("sub/{}", sub.id),
                            &sub.title,
                            Handler::Open(format!("docs/folder/{}", sub.id)),
                        )
                        .mark(blocks::glyph_mark("Folder", "docs"))
                        .into_block()
                    })
                    .collect();
                content.push(
                    blocks::section(&mut b.sel, "section/folders", &words::section_folders(EN))
                        .blocks(rows)
                        .into_block(),
                );
            }
            if !docs.rows.is_empty() {
                let rows: Vec<_> = docs
                    .rows
                    .iter()
                    .map(|row| build_doc_row(&mut b.sel, "doc", row, false, false))
                    .collect();
                let mut sec = blocks::section(
                    &mut b.sel,
                    "section/documents",
                    &words::section_documents(EN),
                )
                .blocks(rows);
                if docs.next.is_some() {
                    sec = sec.next_page(&mut b.sel, "section/documents/more");
                }
                content.push(sec.into_block());
            }
        }

        let mut trash = blocks::menu_item(
            &mut b.sel,
            "header/menu/trash",
            &shared::trash_move(EN),
            Handler::Open(format!("docs/folder/{}/trash-confirm", self.id)),
        );
        trash.destructive = true;
        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "header/menu/add",
                        &words::add_menu(EN),
                        Handler::Open(add_in_folder),
                    ),
                    trash,
                ],
            )],
            &mut b.sel,
        );

        let count_str = words::docs_count(EN, docs.rows.len() as u64);
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&folder.title)
            .subtitle(&count_str)
            .back(&mut b.sel, &words::folders_title(EN))
            .menu_key(&mut b.sel, "header/more", &words::menu_more(EN), menu)
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        } else if tag.starts_with("share:") {
            return Outcome::say(&words::shared(EN));
        }
        Outcome::default()
    }
}

struct NewFolderForm {
    parent_id: Option<String>,
    loaded_draft: bool,
    error: Option<String>,
}

impl NewFolderForm {
    fn new(parent_id: Option<String>) -> Self {
        Self {
            parent_id,
            loaded_draft: false,
            error: None,
        }
    }
}

impl RoomScreen for NewFolderForm {
    fn key(&self) -> String {
        match &self.parent_id {
            Some(id) => format!("docs/folders/new/in/{id}"),
            None => NEW_FOLDER.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded_draft {
            self.loaded_draft = true;
            if let Some(key) = draft_key(b.door, "folder")
                && let Some(raw) = b.door.device_get(&key)
                && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
                && let Some(name) = val
                    .get("fields")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
            {
                b.ui.fields.get_or("name", name);
            }
        }
        let mut name_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_folder_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if let Some(err) = &self.error {
            name_field = name_field.error(err);
        }
        let save_label = shared::kit_save(EN);
        let cancel_label = shared::kit_cancel(EN);
        let name_val = b.ui.fields.value("name").unwrap_or("");
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &save_label,
                cancel_label: &cancel_label,
                save_enabled: !name_val.trim().is_empty(),
                dirty: !name_val.is_empty(),
                drafted: false,
                save: Handler::Tag("save".to_owned()),
                cancel: Handler::Tag("cancel".to_owned()),
            },
        );
        let block = form::form(vec![name_field.build()], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::new_folder_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "cancel" {
            if let Some(key) = draft_key(e.door, "folder") {
                let _ = e.door.device_delete(&key);
            }
            return Outcome::pop();
        }
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_name_required(EN));
                return Outcome::default();
            }
            let id = mint_uuid_v7(e.door.now_ms());
            let mut input = json!({ "id": id, "kind": "folder", "title": name });
            if let Some(parent) = &self.parent_id {
                input["parent"] = json!(parent);
            }
            match e.door.act(&Act::new("container.create", input)) {
                Ok(_) => {
                    if let Some(key) = draft_key(e.door, "folder") {
                        let _ = e.door.device_delete(&key);
                    }
                    let mut out = Outcome::done(&words::folder_created(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    return out;
                }
                Err(refused) => return Outcome::refuse(&refused.0),
            }
        }
        Outcome::default()
    }
}

struct TrashFolderConfirm {
    id: String,
}

impl RoomScreen for TrashFolderConfirm {
    fn key(&self) -> String {
        format!("docs/folder/{}/trash-confirm", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = b
            .run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| shared::trash_untitled(EN));
        let held_count: u64 = b
            .run(
                &entity_reads::HELD_COUNTS,
                &Args::new().text("home", &self.id),
            )
            .map(|a| a.rows.iter().map(|h| h.count.max(0) as u64).sum())
            .unwrap_or(0);
        let body = if held_count > 0 {
            fill(
                &words::trash_folder_body(EN, held_count),
                &[("title", &title)],
            )
        } else {
            fill(&words::trash_folder_empty_body(EN), &[("title", &title)])
        };
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::trash_folder_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::trash_folder_confirm(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::trash_folder_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, done.undo);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct TextDocForm {
    id: Option<String>,
    folder_id: Option<String>,
    initialized: bool,
    error: Option<String>,
}

impl TextDocForm {
    fn new_doc(folder_id: Option<String>) -> Self {
        Self {
            id: None,
            folder_id,
            initialized: false,
            error: None,
        }
    }

    fn edit_doc(id: String) -> Self {
        Self {
            id: Some(id),
            folder_id: None,
            initialized: false,
            error: None,
        }
    }
}

impl RoomScreen for TextDocForm {
    fn key(&self) -> String {
        match (&self.id, &self.folder_id) {
            (Some(id), _) => format!("docs/doc/{id}/edit"),
            (None, Some(folder)) => format!("docs/new-text/in/{folder}"),
            (None, None) => NEW_TEXT.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.initialized {
            self.initialized = true;
            if let Some(id) = &self.id {
                if let Ok(answer) = b.run(&reads::BY_ID, &Args::new().text("id", id))
                    && let Some(doc) = answer.rows.into_iter().next()
                {
                    b.ui.fields.get_or("name", &doc.title);
                    b.ui.fields
                        .get_or("body", doc.body_text.as_deref().unwrap_or(""));
                }
            } else if let Some(key) = draft_key(b.door, "document")
                && let Some(raw) = b.door.device_get(&key)
                && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
                && let Some(fields) = val.get("fields")
            {
                if let Some(name) = fields.get("name").and_then(|v| v.as_str()) {
                    b.ui.fields.get_or("name", name);
                }
                if let Some(body) = fields.get("body").and_then(|v| v.as_str()) {
                    b.ui.fields.get_or("body", body);
                }
            }
        }
        let mut name_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if let Some(err) = &self.error {
            name_field = name_field.error(err);
        }
        let body_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "body",
            &words::field_body(EN),
            wire::RoomTextKind::Paragraph,
            "",
            MAX_BODY_CHARS,
        );
        let save_label = shared::kit_save(EN);
        let cancel_label = shared::kit_cancel(EN);
        let name_val = b.ui.fields.value("name").unwrap_or("");
        let body_val = b.ui.fields.value("body").unwrap_or("");
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &save_label,
                cancel_label: &cancel_label,
                save_enabled: !name_val.trim().is_empty(),
                dirty: !name_val.is_empty() || !body_val.is_empty(),
                drafted: false,
                save: Handler::Tag("save".to_owned()),
                cancel: Handler::Tag("cancel".to_owned()),
            },
        );
        let block = form::form(
            vec![name_field.build(), body_field.build()],
            Vec::new(),
            Save::Explicit(save),
        );
        let title = if self.id.is_some() {
            words::edit_text_title(EN)
        } else {
            words::new_text_title(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .back(&mut b.sel, &words::title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "cancel" {
            if self.id.is_none()
                && let Some(key) = draft_key(e.door, "document")
            {
                let _ = e.door.device_delete(&key);
            }
            return Outcome::pop();
        }
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_name_required(EN));
                return Outcome::default();
            }
            let body = e.ui.fields.value("body").unwrap_or("").to_owned();
            if let Some(id) = &self.id {
                let act = Act::new(
                    "document.edit",
                    json!({ "id": id, "title": name, "body_text": body }),
                );
                return match e.door.act(&act) {
                    Ok(_) => {
                        let mut out = Outcome::done(&words::doc_saved(EN), true);
                        out.nav = super::screen::Nav::Pop;
                        out
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                };
            }
            let id = mint_uuid_v7(e.door.now_ms());
            let mut input = json!({
                "id": id,
                "title": name,
                "body_text": body,
                "media_type": "text/plain",
            });
            if let Some(folder) = &self.folder_id {
                input["folder_id"] = json!(folder);
            }
            return match e.door.act(&Act::new("document.create_text", input)) {
                Ok(_) => {
                    if let Some(key) = draft_key(e.door, "document") {
                        let _ = e.door.device_delete(&key);
                    }
                    let mut out = Outcome::done(&words::doc_created(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct DocDetail {
    id: String,
}

impl RoomScreen for DocDetail {
    fn key(&self) -> String {
        format!("docs/doc/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let detail = match b.run(&reads::BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(doc) = detail else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::title(EN))
                .back(&mut b.sel, &words::title(EN))
                .ready(vec![blocks::empty(
                    glyph("FileText", "docs"),
                    &words::not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let mut content = Vec::new();
        let facts = vec![
            blocks::fact(
                &words::fact_type(EN),
                &doc.media_type,
                wire::RoomFactKind::Text,
            ),
            blocks::fact(
                &words::fact_size(EN),
                &format_bytes(doc.size),
                wire::RoomFactKind::Text,
            ),
            blocks::fact(
                &words::fact_updated(EN),
                short_day(&doc.updated_at),
                wire::RoomFactKind::Date,
            ),
            blocks::fact(
                &words::fact_created(EN),
                short_day(&doc.created_at),
                wire::RoomFactKind::Date,
            ),
        ];
        content.push(
            blocks::section(&mut b.sel, "section/details", &words::section_details(EN))
                .block(blocks::facts(facts))
                .into_block(),
        );

        if let Some(body) = doc.body_text.as_deref().filter(|s| !s.is_empty()) {
            content.push(blocks::prose(body));
        }

        if let Ok(head) = b.run(
            &entity_reads::REVISION_HEAD,
            &Args::new().text("id", &self.id),
        ) && let Some(row) = head.rows.first()
            && row.count > 0
        {
            let count = u32::try_from(row.count).unwrap_or(u32::MAX);
            let summary = words::versions_summary(EN, row.count as u64);
            content.push(blocks::earlier_versions(
                &mut b.sel,
                &summary,
                count,
                Handler::Open(format!("docs/doc/{}/versions", self.id)),
            ));
        }

        if let Ok(links) = b.run(&entity_reads::LINKED, &Args::new().text("id", &self.id)) {
            let mut linked_rows = Vec::new();
            for target_id in links.rows {
                if let Ok(meta) = b.run(
                    &entity_reads::META_BY_ID,
                    &Args::new().text("id", &target_id),
                ) && let Some(target) = meta.rows.into_iter().next()
                {
                    linked_rows.push(
                        blocks::row(
                            &mut b.sel,
                            &format!("linked/{}", target.id),
                            &target.title,
                            Handler::Tag(format!("open:{}:{}", target.kind, target.id)),
                        )
                        .build(),
                    );
                }
            }
            if !linked_rows.is_empty() {
                content.push(blocks::linked(&words::footer_linked(EN), linked_rows, None));
            }
        }

        if let Ok(backlinks) = b.run(
            &entity_reads::MENTIONED_IN,
            &Args::new().text("id", &self.id),
        ) && !backlinks.rows.is_empty()
        {
            let items: Vec<_> = backlinks
                .rows
                .iter()
                .map(|row| {
                    blocks::row(
                        &mut b.sel,
                        &format!("backlink/{}", row.id),
                        &row.title,
                        Handler::Open(format!("notes/note/{}", row.id)),
                    )
                    .build()
                })
                .collect();
            content.push(blocks::mentioned_in(&words::footer_mentioned(EN), items));
        }

        if let Some(label) = doc.arrived_label.as_deref() {
            let line = fill(&shared::origin_line(EN), &[("label", label)]);
            content.push(blocks::origin(&mut b.sel, &line, None));
        }

        let star_act = if doc.starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [&self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [&self.id] }),
            )
        };
        let mut menu_items = Vec::new();
        if doc.media_type.starts_with("text/") {
            menu_items.push(blocks::menu_item(
                &mut b.sel,
                "header/menu/edit",
                &words::menu_edit(EN),
                Handler::Open(format!("docs/doc/{}/edit", self.id)),
            ));
        }
        let star_label = if doc.starred {
            words::menu_unstar(EN)
        } else {
            words::menu_star(EN)
        };
        menu_items.push(blocks::menu_item(
            &mut b.sel,
            "header/menu/star",
            &star_label,
            Handler::Act(star_act),
        ));
        menu_items.push(blocks::menu_item(
            &mut b.sel,
            "header/menu/download",
            &words::menu_download(EN),
            Handler::Tag("download".to_owned()),
        ));
        menu_items.push(blocks::menu_item(
            &mut b.sel,
            "header/menu/versions",
            &words::menu_versions(EN),
            Handler::Open(format!("docs/doc/{}/versions", self.id)),
        ));
        menu_items.push(blocks::menu_item(
            &mut b.sel,
            "header/menu/share",
            &words::menu_share(EN),
            Handler::Tag("share".to_owned()),
        ));
        let mut trash = blocks::menu_item(
            &mut b.sel,
            "header/menu/trash",
            &shared::trash_move(EN),
            Handler::Tag("trash".to_owned()),
        );
        trash.destructive = true;
        menu_items.push(trash);

        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section("", menu_items)],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&doc.title)
            .back(&mut b.sel, &words::title(EN))
            .menu_key(&mut b.sel, "header/more", &words::menu_more(EN), menu)
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        match tag {
            "download" => Outcome::say(&words::download_note(EN)),
            "share" => Outcome::say(&words::shared(EN)),
            "trash" => {
                let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
                match e.door.act(&act) {
                    Ok(done) => {
                        let mut out = Outcome::done(&done.sentence, done.undo);
                        out.nav = super::screen::Nav::Pop;
                        out
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct DocVersions {
    id: String,
}

impl RoomScreen for DocVersions {
    fn key(&self) -> String {
        format!("docs/doc/{}/versions", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let revisions = match b.run(&entity_reads::REVISIONS, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::versions_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let mut content = Vec::new();
        if revisions.is_empty() {
            content.push(blocks::empty(
                glyph("History", "docs"),
                &words::empty_versions_title(EN),
                &words::empty_versions_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = revisions
                .iter()
                .map(|rev| {
                    let seq = rev.seq;
                    blocks::row(
                        &mut b.sel,
                        &format!("rev/{seq}"),
                        short_day(&rev.at),
                        Handler::Act(Act::new(
                            "document.restore_version",
                            json!({ "id": self.id, "seq": seq }),
                        )),
                    )
                    .meta(&rev.actor)
                    .trailing(&words::menu_restore_version(EN), wire::RoomTone::Accent)
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/versions", &words::section_versions(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::versions_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(content)
            .build()
    }
}

struct FollowedFoldersPage;

impl RoomScreen for FollowedFoldersPage {
    fn key(&self) -> String {
        FOLLOWED.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let origins = match b.run(&reads::FOLLOWED_FOLDERS, &Args::new()) {
            Ok(answer) => answer.rows,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, FOLLOWED)
                    .title(&words::followed_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let mut content = Vec::new();
        if origins.is_empty() {
            content.push(blocks::empty(
                glyph("Folder", "docs"),
                &words::empty_followed_title(EN),
                &words::empty_followed_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = origins
                .iter()
                .map(|origin| {
                    let state = if origin.retired_at.is_some() {
                        words::followed_stopped(EN)
                    } else {
                        words::followed_active(EN)
                    };
                    let mut row = blocks::still_row(
                        &mut b.sel,
                        &format!("followed/{}", origin.id),
                        &origin.label,
                    )
                    .meta(&origin.external_ref)
                    .trailing(&state, wire::RoomTone::Neutral)
                    .mark(blocks::glyph_mark("Folder", "docs"));
                    if origin.retired_at.is_none() {
                        let menu = blocks::menu(
                            &format!("followed/{}/menu", origin.id),
                            vec![blocks::menu_section(
                                "",
                                vec![blocks::menu_item(
                                    &mut b.sel,
                                    &format!("followed/{}/stop", origin.id),
                                    &words::menu_stop_following(EN),
                                    Handler::Act(Act::new(
                                        "follow.stop",
                                        json!({ "origin_id": origin.id }),
                                    )),
                                )],
                            )],
                            &mut b.sel,
                        );
                        row = row.menu(menu);
                    }
                    row.into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/followed", &words::section_followed(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::PushedPage, FOLLOWED)
            .title(&words::followed_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .ready(content)
            .build()
    }
}

struct DocsTrash {
    loaded: usize,
}

impl Default for DocsTrash {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for DocsTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let answer = match b.reload(&reads::TRASH, &Args::new(), self.loaded) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&shared::trash_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count = answer.rows.len() as u64;
        let heading = if count == 0 {
            shared::trash_title(EN)
        } else {
            shared::trash_count(EN, count)
        };
        let mut content = Vec::new();
        if answer.rows.is_empty() {
            content.push(blocks::empty(
                glyph("Trash", "docs"),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = answer
                .rows
                .iter()
                .map(|row| {
                    let title = if row.title.is_empty() {
                        shared::trash_untitled(EN)
                    } else {
                        row.title.clone()
                    };
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        short_day(&row.deleted_at),
                        shared::trash_erased(EN),
                        short_day(&row.purge_at)
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", row.id),
                        &title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [&row.id] }))),
                        Handler::Open(format!("docs/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_btn = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("docs/trash/empty".to_owned()),
            );
            let mut trash = blocks::trash(
                &heading,
                &shared::trash_entry_meta(EN),
                rows,
                Some(empty_btn),
            );
            if answer.next.is_some() {
                trash.next_page_selector_id = b
                    .sel
                    .on("trash/more", Handler::NextPage("trash".to_owned()));
            }
            content.push(blocks::trash_block(trash));
        }
        room(wire::RoomKind::PushedPage, TRASH)
            .title(&heading)
            .back(&mut b.sel, &words::title(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        }
        Outcome::default()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("docs/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(
            &shared::trash_purge_title(EN),
            &[("noun", &shared::trash_noun_document(EN))],
        );
        let body = format!(
            "{} {}",
            shared::trash_purge_lead(EN),
            shared::trash_cannot_undo(EN)
        );
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: "",
                confirm_label: &shared::trash_purge(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new("entity.purge", json!({ "id": self.id }));
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, false);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "docs/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: "",
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new(
                "entity.empty_trash",
                json!({ "kinds": ["document", "folder"] }),
            );
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, false);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
