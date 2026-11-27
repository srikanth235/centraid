use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity as entity_reads, notes as reads};
use centraid_domain::read::Args;
use rand::RngCore as _;
use serde_json::json;

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, fill, notes as words, shared};

pub const NOTES: &str = "notes";
pub const NOTEBOOKS: &str = "notes/notebooks";
pub const JOURNAL: &str = "notes/journal";
pub const TAGS: &str = "notes/tags";
pub const NEW_NOTE: &str = "notes/new";
pub const NEW_NOTEBOOK: &str = "notes/notebooks/new";
pub const TRASH: &str = "notes/trash";

const EN: Locale = Locale::En;
const MAX_NAME_CHARS: usize = 200;
const FILTER_PINNED: &str = "filter/pinned";
const FILTER_JOURNAL: &str = "filter/journal";
const SORT_UPDATED: &str = "sort/updated";
const SORT_TITLE: &str = "sort/title";

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(NOTES, || Box::new(NotesList::default()))
        .exact(NOTEBOOKS, || Box::new(NotebooksList))
        .exact(JOURNAL, || Box::new(JournalList::default()))
        .exact(TAGS, || Box::new(TagsList))
        .exact(NEW_NOTE, || Box::new(NoteEditor::new_note(None, None)))
        .exact(NEW_NOTEBOOK, || Box::new(NewNotebookForm::default()))
        .exact(TRASH, || Box::new(NotesTrash::default()))
        .exact("notes/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("notes/new/in/") {
                return Some(Box::new(NoteEditor::new_note(Some(id.to_owned()), None)));
            }
            if let Some(day) = key.strip_prefix("notes/new/journal/") {
                return Some(Box::new(NoteEditor::new_note(None, Some(day.to_owned()))));
            }
            if let Some(id) = key.strip_prefix("notes/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("notes/note/") {
                if let Some(id) = rest.strip_suffix("/versions") {
                    return Some(Box::new(NoteVersions { id: id.to_owned() }));
                }
                return Some(Box::new(NoteEditor::existing(rest.to_owned())));
            }
            if let Some(rest) = key.strip_prefix("notes/notebook/") {
                if let Some(id) = rest.strip_suffix("/trash-confirm") {
                    return Some(Box::new(TrashNotebookConfirm { id: id.to_owned() }));
                }
                return Some(Box::new(NotebookDetail {
                    id: rest.to_owned(),
                    loaded: 50,
                }));
            }
            if let Some(rest) = key.strip_prefix("notes/tag/") {
                if let Some(id) = rest.strip_suffix("/rename") {
                    return Some(Box::new(RenameTagForm::new(id.to_owned())));
                }
                if let Some((from, into)) = rest.split_once("/merge/") {
                    return Some(Box::new(MergeTagConfirm {
                        from: from.to_owned(),
                        into: into.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/merge") {
                    return Some(Box::new(MergeTagPick { id: id.to_owned() }));
                }
                return Some(Box::new(TagDetail {
                    id: rest.to_owned(),
                    loaded: 50,
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

fn today_iso(now_ms: i64) -> String {
    let days = now_ms.div_euclid(86_400_000);
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
    format!("{year:04}-{m:02}-{d:02}")
}

fn prefix_upper(prefix: &str) -> String {
    let mut upper = prefix.to_owned();
    upper.push('\u{10FFFF}');
    upper
}

fn draft_key(door: &dyn Door, kind: &str) -> Option<String> {
    let vault = door.vault_id();
    if vault.is_empty() {
        None
    } else {
        Some(format!("draft.{vault}.{kind}"))
    }
}

fn notes_band(sel: &mut Sel, active_tab: &str) -> wire::RoomBand {
    let tabs = vec![
        frame::tab(
            sel,
            "tab/notes",
            &words::tab_notes(EN),
            "Journal",
            active_tab == NOTES,
        ),
        frame::tab(
            sel,
            "tab/notebooks",
            &words::tab_notebooks(EN),
            "Book",
            active_tab == NOTEBOOKS,
        ),
        frame::tab(
            sel,
            "tab/journal",
            &words::tab_journal(EN),
            "Calendar",
            active_tab == JOURNAL,
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
            "more/tags",
            &words::more_tags(EN),
            Handler::Open(TAGS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/import",
            &words::more_import(EN),
            Handler::Tag("more:import".to_owned()),
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
        "tab:tab/notes" => Some(Outcome::replace(NOTES)),
        "tab:tab/notebooks" => Some(Outcome::replace(NOTEBOOKS)),
        "tab:tab/journal" => Some(Outcome::replace(JOURNAL)),
        "more:import" => Some(Outcome::say(&words::import_note(EN))),
        "more:export" => Some(Outcome::say(&words::export_note(EN))),
        _ => None,
    }
}

fn note_row_menu(sel: &mut Sel, prefix: &str, note: &reads::NoteRow) -> wire::RoomMenu {
    let id = &note.id;
    let pin_act = if note.pinned {
        Act::new(
            "flag.clear/pinned",
            json!({ "flag": "pinned", "ids": [id] }),
        )
    } else {
        Act::new("flag.set/pinned", json!({ "flag": "pinned", "ids": [id] }))
    };
    let mut trash = blocks::menu_item(
        sel,
        &format!("{prefix}/{id}/menu/trash"),
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
    );
    trash.destructive = true;
    let pin_label = if note.pinned {
        words::menu_unpin(EN)
    } else {
        words::menu_pin(EN)
    };
    let items = vec![
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/open"),
            &words::menu_open(EN),
            Handler::Open(format!("notes/note/{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("{prefix}/{id}/menu/pin"),
            &pin_label,
            Handler::Act(pin_act),
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

fn build_note_row(
    sel: &mut Sel,
    prefix: &str,
    note: &reads::NoteRow,
    selecting: bool,
    selected: bool,
) -> wire::RoomBlock {
    let id = &note.id;
    let tap = if selecting {
        Handler::Pick(id.clone())
    } else {
        Handler::Open(format!("notes/note/{id}"))
    };
    let title = if note.title.is_empty() {
        shared::trash_untitled(EN)
    } else {
        note.title.clone()
    };
    let meta = note
        .journal_on
        .as_deref()
        .unwrap_or_else(|| note.at.get(..10).unwrap_or(&note.at));
    let mut row = blocks::row(sel, &format!("{prefix}/{id}"), &title, tap)
        .meta(meta)
        .mark(blocks::glyph_mark("Journal", "notes"))
        .selected(selected);
    if note.pinned {
        row = row.chip(blocks::chip(
            &words::pinned_chip(EN),
            wire::RoomTone::Accent,
        ));
    }
    if note.journal_on.is_some() {
        row = row.chip(blocks::chip(
            &words::journal_chip(EN),
            wire::RoomTone::Neutral,
        ));
    }
    if !selecting {
        let menu = note_row_menu(sel, prefix, note);
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
            "selection/pin",
            &words::menu_pin(EN),
            Handler::Act(Act::new(
                "flag.set/pinned",
                json!({ "flag": "pinned", "ids": ids }),
            )),
        ),
        trash,
    ]
}

fn short_day(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

fn kind_noun(kind: &str) -> String {
    match kind {
        "note" => words::noun_note(EN),
        "person" => words::noun_person(EN),
        "document" => words::noun_document(EN),
        _ => words::noun_item(EN),
    }
}

struct NotesList {
    loaded: usize,
    sort: &'static str,
}

impl Default for NotesList {
    fn default() -> Self {
        Self {
            loaded: 50,
            sort: SORT_UPDATED,
        }
    }
}

impl RoomScreen for NotesList {
    fn key(&self) -> String {
        NOTES.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let only_pinned = b.ui.is_filtered(FILTER_PINNED);
        let only_journal = b.ui.is_filtered(FILTER_JOURNAL);
        let term = b.ui.search_term().trim().to_owned();

        let answer = if only_pinned {
            b.reload(&reads::PINNED, &Args::new(), self.loaded)
        } else if only_journal {
            b.reload(&reads::JOURNAL, &Args::new(), self.loaded)
        } else {
            b.reload(&reads::LIST, &Args::new(), self.loaded)
        };
        let answer = match answer {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, NOTES)
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
        let count_str = words::notes_count(EN, rows.len() as u64);

        let mut filter_pinned = blocks::menu_item(
            &mut b.sel,
            FILTER_PINNED,
            &words::filter_pinned(EN),
            Handler::Filter(FILTER_PINNED.to_owned()),
        );
        filter_pinned.checked = only_pinned;
        let mut filter_journal = blocks::menu_item(
            &mut b.sel,
            FILTER_JOURNAL,
            &words::filter_journal(EN),
            Handler::Filter(FILTER_JOURNAL.to_owned()),
        );
        filter_journal.checked = only_journal;

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
            "notes-filter-menu",
            vec![
                blocks::menu_section(
                    &words::filter_section_show(EN),
                    vec![filter_pinned, filter_journal],
                ),
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
                    &words::add_note(EN),
                    "Plus",
                    Handler::Open(NEW_NOTE.to_owned()),
                );
                content.push(blocks::empty(
                    glyph("Journal", "notes"),
                    &words::empty_notes_title(EN),
                    &words::empty_notes_body(EN),
                    Some(add),
                ));
            } else {
                let body = fill(&words::empty_search_body(EN), &[("term", &term)]);
                content.push(blocks::empty(
                    glyph("Search", "notes"),
                    &words::empty_search_title(EN),
                    &body,
                    None,
                ));
            }
        } else {
            let (pinned_rows, regular_rows): (Vec<_>, Vec<_>) =
                if !only_pinned && !only_journal && term.is_empty() {
                    rows.iter().partition(|r| r.pinned)
                } else {
                    (Vec::new(), rows.iter().collect())
                };

            if !pinned_rows.is_empty() {
                let blocks_pinned: Vec<_> = pinned_rows
                    .iter()
                    .map(|row| {
                        let sel_on = b.ui.is_picked(&row.id);
                        build_note_row(&mut b.sel, "pinned", row, selecting, sel_on)
                    })
                    .collect();
                content.push(
                    blocks::section(&mut b.sel, "section/pinned", &words::section_pinned(EN))
                        .blocks(blocks_pinned)
                        .into_block(),
                );
            }

            if !regular_rows.is_empty() {
                let blocks_regular: Vec<_> = regular_rows
                    .iter()
                    .map(|row| {
                        let sel_on = b.ui.is_picked(&row.id);
                        build_note_row(&mut b.sel, "note", row, selecting, sel_on)
                    })
                    .collect();
                let mut sec =
                    blocks::section(&mut b.sel, "section/notes", &words::section_notes(EN))
                        .blocks(blocks_regular);
                if answer.next.is_some() {
                    sec = sec.next_page(&mut b.sel, "section/notes/more");
                }
                content.push(sec.into_block());
            }
        }

        let sel_actions = selection_actions(&mut b.sel, &picked);
        let sel_label = words::selected_count(EN, picked.len() as u64);
        let band = notes_band(&mut b.sel, NOTES);

        room(wire::RoomKind::AppPlace, NOTES)
            .title(&words::title(EN))
            .subtitle(&count_str)
            .filter(&mut b.sel, filter_menu, b.ui)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_note(EN),
                Handler::Open(NEW_NOTE.to_owned()),
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

struct NotebooksList;

impl RoomScreen for NotebooksList {
    fn key(&self) -> String {
        NOTEBOOKS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let books = match b.run(&reads::NOTEBOOKS, &Args::new()) {
            Ok(answer) => answer.rows,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, NOTEBOOKS)
                    .title(&words::notebooks_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let count_str = words::notebooks_count(EN, books.len() as u64);
        let mut content = Vec::new();
        if books.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_notebook(EN),
                "Plus",
                Handler::Open(NEW_NOTEBOOK.to_owned()),
            );
            content.push(blocks::empty(
                glyph("Book", "notes"),
                &words::empty_notebooks_title(EN),
                &words::empty_notebooks_body(EN),
                Some(add),
            ));
        } else {
            let rows: Vec<_> = books
                .iter()
                .map(|book| {
                    let id = &book.id;
                    let mut trash = blocks::menu_item(
                        &mut b.sel,
                        &format!("book/{id}/menu/trash"),
                        &shared::trash_move(EN),
                        Handler::Open(format!("notes/notebook/{id}/trash-confirm")),
                    );
                    trash.destructive = true;
                    let menu = blocks::menu(
                        &format!("book/{id}/menu"),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("book/{id}/menu/open"),
                                    &words::menu_open(EN),
                                    Handler::Open(format!("notes/notebook/{id}")),
                                ),
                                trash,
                            ],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("book/{id}"),
                        &book.title,
                        Handler::Open(format!("notes/notebook/{id}")),
                    )
                    .mark(blocks::glyph_mark("Book", "notes"))
                    .menu(menu)
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(
                    &mut b.sel,
                    "section/notebooks",
                    &words::section_notebooks(EN),
                )
                .blocks(rows)
                .into_block(),
            );
        }

        let band = notes_band(&mut b.sel, NOTEBOOKS);
        room(wire::RoomKind::AppPlace, NOTEBOOKS)
            .title(&words::notebooks_title(EN))
            .subtitle(&count_str)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_notebook(EN),
                Handler::Open(NEW_NOTEBOOK.to_owned()),
            )
            .band(band)
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        handle_more_or_nav(tag).unwrap_or_default()
    }
}

struct NotebookDetail {
    id: String,
    loaded: usize,
}

impl RoomScreen for NotebookDetail {
    fn key(&self) -> String {
        format!("notes/notebook/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let meta = match b.run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::notebooks_title(EN))
                    .back(&mut b.sel, &words::notebooks_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(book) = meta else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::notebooks_title(EN))
                .back(&mut b.sel, &words::notebooks_title(EN))
                .ready(vec![blocks::empty(
                    glyph("Book", "notes"),
                    &words::notebook_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let answer = match b.reload(
            &reads::IN_NOTEBOOK,
            &Args::new().text("notebook", &self.id),
            self.loaded,
        ) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&book.title)
                    .back(&mut b.sel, &words::notebooks_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let new_in_book = format!("notes/new/in/{}", self.id);
        let count_str = words::notes_count(EN, answer.rows.len() as u64);
        let mut content = Vec::new();
        if answer.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_note(EN),
                "Plus",
                Handler::Open(new_in_book.clone()),
            );
            content.push(blocks::empty(
                glyph("Journal", "notes"),
                &words::empty_notebook_title(EN),
                &words::empty_notebook_body(EN),
                Some(add),
            ));
        } else {
            let rows: Vec<_> = answer
                .rows
                .iter()
                .map(|row| build_note_row(&mut b.sel, "note", row, false, false))
                .collect();
            let mut sec = blocks::section(&mut b.sel, "section/notes", &words::section_notes(EN))
                .blocks(rows);
            if answer.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/notes/more");
            }
            content.push(sec.into_block());
        }

        let mut trash = blocks::menu_item(
            &mut b.sel,
            "header/menu/trash",
            &shared::trash_move(EN),
            Handler::Open(format!("notes/notebook/{}/trash-confirm", self.id)),
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
                        &words::add_note(EN),
                        Handler::Open(new_in_book),
                    ),
                    trash,
                ],
            )],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&book.title)
            .subtitle(&count_str)
            .back(&mut b.sel, &words::notebooks_title(EN))
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

#[derive(Default)]
struct NewNotebookForm {
    loaded_draft: bool,
    error: Option<String>,
}

impl RoomScreen for NewNotebookForm {
    fn key(&self) -> String {
        NEW_NOTEBOOK.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded_draft {
            self.loaded_draft = true;
            if let Some(key) = draft_key(b.door, "notebook")
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
            &words::field_notebook_name(EN),
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
        room(wire::RoomKind::Sheet, NEW_NOTEBOOK)
            .title(&words::new_notebook_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "cancel" {
            if let Some(key) = draft_key(e.door, "notebook") {
                let _ = e.door.device_delete(&key);
            }
            return Outcome::pop();
        }
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_title_required(EN));
                return Outcome::default();
            }
            let id = mint_uuid_v7(e.door.now_ms());
            let act = Act::new(
                "container.create",
                json!({ "id": id, "kind": "notebook", "title": name }),
            );
            match e.door.act(&act) {
                Ok(_) => {
                    if let Some(key) = draft_key(e.door, "notebook") {
                        let _ = e.door.device_delete(&key);
                    }
                    let mut out = Outcome::done(&words::notebook_created(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    return out;
                }
                Err(refused) => return Outcome::refuse(&refused.0),
            }
        }
        Outcome::default()
    }
}

struct TrashNotebookConfirm {
    id: String,
}

impl RoomScreen for TrashNotebookConfirm {
    fn key(&self) -> String {
        format!("notes/notebook/{}/trash-confirm", self.id)
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
                &words::trash_notebook_body(EN, held_count),
                &[("title", &title)],
            )
        } else {
            fill(&words::trash_notebook_empty_body(EN), &[("title", &title)])
        };
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::trash_notebook_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::trash_notebook_confirm(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::trash_notebook_title(EN))
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

struct JournalList {
    loaded: usize,
}

impl Default for JournalList {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for JournalList {
    fn key(&self) -> String {
        JOURNAL.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let answer = match b.reload(&reads::JOURNAL, &Args::new(), self.loaded) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, JOURNAL)
                    .title(&words::journal_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let today = today_iso(b.door.now_ms());
        let new_today = format!("notes/new/journal/{today}");
        let count_str = words::entries_count(EN, answer.rows.len() as u64);
        let mut content = Vec::new();
        if answer.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_entry(EN),
                "Plus",
                Handler::Open(new_today.clone()),
            );
            content.push(blocks::empty(
                glyph("Calendar", "notes"),
                &words::empty_journal_title(EN),
                &words::empty_journal_body(EN),
                Some(add),
            ));
        } else {
            let rows: Vec<_> = answer
                .rows
                .iter()
                .map(|row| build_note_row(&mut b.sel, "journal", row, false, false))
                .collect();
            let mut sec =
                blocks::section(&mut b.sel, "section/entries", &words::section_entries(EN))
                    .blocks(rows);
            if answer.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/entries/more");
            }
            content.push(sec.into_block());
        }

        let band = notes_band(&mut b.sel, JOURNAL);
        room(wire::RoomKind::AppPlace, JOURNAL)
            .title(&words::journal_title(EN))
            .subtitle(&count_str)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_entry(EN),
                Handler::Open(new_today),
            )
            .band(band)
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(out) = handle_more_or_nav(tag) {
            return out;
        }
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        } else if tag.starts_with("share:") {
            return Outcome::say(&words::shared(EN));
        }
        Outcome::default()
    }
}

struct NoteEditor {
    id: Option<String>,
    notebook_id: Option<String>,
    journal_on: Option<String>,
    title: String,
    body: String,
    rev: u64,
    loaded: bool,
    autosave_phase: wire::RoomAutosavePhase,
    autosave_label: String,
    trigger: Option<(String, String)>,
}

impl NoteEditor {
    fn new_note(notebook_id: Option<String>, journal_on: Option<String>) -> Self {
        let default_title = journal_on.clone().unwrap_or_default();
        Self {
            id: None,
            notebook_id,
            journal_on,
            title: default_title,
            body: String::new(),
            rev: 0,
            loaded: true,
            autosave_phase: wire::RoomAutosavePhase::Clean,
            autosave_label: String::new(),
            trigger: None,
        }
    }

    fn existing(id: String) -> Self {
        Self {
            id: Some(id),
            notebook_id: None,
            journal_on: None,
            title: String::new(),
            body: String::new(),
            rev: 0,
            loaded: false,
            autosave_phase: wire::RoomAutosavePhase::Clean,
            autosave_label: String::new(),
            trigger: None,
        }
    }
}

impl RoomScreen for NoteEditor {
    fn key(&self) -> String {
        match &self.id {
            Some(id) => format!("notes/note/{id}"),
            None => NEW_NOTE.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let mut pinned = false;
        let mut assets_blocks = Vec::new();
        let mut footer_blocks = Vec::new();
        let mut base_rev = String::new();

        if let Some(id) = self.id.clone() {
            let detail = match b.run(&reads::BY_ID, &Args::new().text("id", &id)) {
                Ok(answer) => answer.rows.into_iter().next(),
                Err(err) => {
                    return room(wire::RoomKind::Editor, &self.key())
                        .title(&words::title(EN))
                        .back(&mut b.sel, &words::title(EN))
                        .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                        .build();
                }
            };
            let Some(note) = detail else {
                return room(wire::RoomKind::Editor, &self.key())
                    .title(&words::title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .ready(vec![blocks::empty(
                        glyph("Journal", "notes"),
                        &words::not_found(EN),
                        "",
                        None,
                    )])
                    .build();
            };
            if !self.loaded {
                self.title = note.title.clone();
                self.body = note.body.clone();
                self.journal_on = note.journal_on.clone();
                self.notebook_id = note.parent_id.clone();
                self.loaded = true;
            }
            pinned = note.pinned;
            let arrived_label = note.arrived_label;

            if let Ok(head) = b.run(&entity_reads::REVISION_HEAD, &Args::new().text("id", &id))
                && let Some(row) = head.rows.first()
            {
                base_rev = row.seq.to_string();
                if row.count > 0 {
                    let count = u32::try_from(row.count).unwrap_or(u32::MAX);
                    let summary = words::versions_summary(EN, row.count as u64);
                    footer_blocks.push(blocks::earlier_versions(
                        &mut b.sel,
                        &summary,
                        count,
                        Handler::Open(format!("notes/note/{id}/versions")),
                    ));
                }
            }

            if let Ok(assets) = b.run(&reads::ASSETS, &Args::new().text("id", &id)) {
                for asset in assets.rows {
                    let kind = if asset.media_type.starts_with("video/") {
                        wire::RoomMediaKind::Video
                    } else if asset.media_type.starts_with("image/") {
                        wire::RoomMediaKind::Image
                    } else {
                        wire::RoomMediaKind::File
                    };
                    let mut media = blocks::media(
                        &mut b.sel,
                        &format!("asset/{}", asset.id),
                        kind,
                        wire::RoomThumb {
                            r#ref: asset.blob,
                            alt: asset.name.clone(),
                            hue_key: "notes".to_owned(),
                        },
                        Handler::Tag(format!("asset:{}", asset.id)),
                    );
                    media.caption = asset.name;
                    assets_blocks.push(media);
                }
            }

            if let Ok(att) = b.run(&entity_reads::ATTACHMENTS, &Args::new().text("id", &id)) {
                let items: Vec<_> = att
                    .rows
                    .iter()
                    .map(|item| {
                        blocks::row(
                            &mut b.sel,
                            &format!("attach/{}", item.id),
                            &item.title,
                            Handler::Tag(format!("open:{}:{}", item.kind, item.id)),
                        )
                        .meta(&kind_noun(&item.kind))
                        .build()
                    })
                    .collect();
                let add_menu = blocks::menu(
                    "attach/add",
                    vec![blocks::menu_section(
                        "",
                        vec![
                            blocks::menu_item(
                                &mut b.sel,
                                "attach/add/scan",
                                &words::attach_scan(EN),
                                Handler::Tag("attach:scan".to_owned()),
                            ),
                            blocks::menu_item(
                                &mut b.sel,
                                "attach/add/file",
                                &words::attach_file(EN),
                                Handler::Tag("attach:file".to_owned()),
                            ),
                            blocks::menu_item(
                                &mut b.sel,
                                "attach/add/photo",
                                &words::attach_photo(EN),
                                Handler::Tag("attach:photo".to_owned()),
                            ),
                        ],
                    )],
                    &mut b.sel,
                );
                footer_blocks.push(blocks::attachments(
                    &words::footer_attachments(EN),
                    items,
                    Some(add_menu),
                ));
            }

            if let Ok(links) = b.run(&entity_reads::LINKED, &Args::new().text("id", &id)) {
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
                            .meta(&kind_noun(&target.kind))
                            .build(),
                        );
                    }
                }
                if !linked_rows.is_empty() {
                    footer_blocks.push(blocks::linked(
                        &words::footer_linked(EN),
                        linked_rows,
                        None,
                    ));
                }
            }

            if let Ok(backlinks) = b.run(&entity_reads::MENTIONED_IN, &Args::new().text("id", &id))
                && !backlinks.rows.is_empty()
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
                footer_blocks.push(blocks::mentioned_in(&words::footer_mentioned(EN), items));
            }

            if let Some(label) = arrived_label {
                let line = fill(&shared::origin_line(EN), &[("label", &label)]);
                footer_blocks.push(blocks::origin(&mut b.sel, &line, None));
            }
        }

        let suggest = self.trigger.as_ref().map(|(trig, query)| {
            let kind = if trig == "@" { "person" } else { "note" };
            let upper = prefix_upper(query);
            let candidates = b
                .run(
                    &reads::MENTION_SUGGEST,
                    &Args::new()
                        .text("kind", kind)
                        .text("prefix", query)
                        .text("upper", &upper),
                )
                .map(|a| {
                    a.rows
                        .into_iter()
                        .map(|c| wire::RoomNoteMentionCandidate {
                            selector_id: b.sel.on(
                                format!("suggest/{}", c.id),
                                Handler::Tag(format!("suggest:{}", c.title)),
                            ),
                            title: c.title,
                            noun: kind_noun(&c.kind),
                        })
                        .collect()
                })
                .unwrap_or_default();
            wire::RoomNoteMentionSuggest {
                trigger: trig.clone(),
                query: query.clone(),
                candidates,
            }
        });

        let editor_sel = blocks::canvas(&mut b.sel, "editor", "editor");
        let editor_block = blocks::note_editor(wire::RoomNoteEditor {
            selector_id: editor_sel,
            title: self.title.clone(),
            body: self.body.clone(),
            rev: self.rev,
            base_revision_id: base_rev,
            read_only: false,
            focused: true,
            autosave: Some(wire::RoomAutosave {
                phase: self.autosave_phase as i32,
                label: self.autosave_label.clone(),
                refused: self.autosave_phase == wire::RoomAutosavePhase::Refused,
                reload_label: String::new(),
                reload_selector_id: String::new(),
            }),
            suggest,
            assets: assets_blocks,
        });

        let mut blocks_out = vec![editor_block];
        blocks_out.extend(footer_blocks);

        let page_title = if self.title.is_empty() {
            words::new_note_title(EN)
        } else {
            self.title.clone()
        };

        let mut frame = room(wire::RoomKind::Editor, &self.key())
            .title(&page_title)
            .back(&mut b.sel, &words::title(EN));

        if let Some(day) = &self.journal_on {
            frame = frame.subtitle(day);
        }

        if let Some(id) = &self.id {
            let pin_act = if pinned {
                Act::new(
                    "flag.clear/pinned",
                    json!({ "flag": "pinned", "ids": [id] }),
                )
            } else {
                Act::new("flag.set/pinned", json!({ "flag": "pinned", "ids": [id] }))
            };
            let mut trash = blocks::menu_item(
                &mut b.sel,
                "header/menu/trash",
                &shared::trash_move(EN),
                Handler::Tag("trash".to_owned()),
            );
            trash.destructive = true;
            let pin_label = if pinned {
                words::menu_unpin(EN)
            } else {
                words::menu_pin(EN)
            };
            let menu = blocks::menu(
                "header/menu",
                vec![blocks::menu_section(
                    "",
                    vec![
                        blocks::menu_item(
                            &mut b.sel,
                            "header/menu/pin",
                            &pin_label,
                            Handler::Act(pin_act),
                        ),
                        blocks::menu_item(
                            &mut b.sel,
                            "header/menu/versions",
                            &words::menu_versions(EN),
                            Handler::Open(format!("notes/note/{id}/versions")),
                        ),
                        blocks::menu_item(
                            &mut b.sel,
                            "header/menu/share",
                            &words::menu_share(EN),
                            Handler::Tag("share".to_owned()),
                        ),
                        trash,
                    ],
                )],
                &mut b.sel,
            );
            frame = frame.menu_key(&mut b.sel, "header/more", &words::menu_more(EN), menu);
        }

        frame.ready(blocks_out).build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if tag == "editor" {
            match input {
                Input::Canvas(wire::room_canvas_event::Kind::NoteEdit(edit)) => {
                    self.title = edit.title.clone();
                    self.body = edit.body.clone();
                    self.rev = edit.seq;
                    self.trigger = None;
                    return self.autosave(e);
                }
                Input::Canvas(wire::room_canvas_event::Kind::NoteTrigger(trig)) => {
                    if trig.trigger.is_empty() {
                        self.trigger = None;
                    } else {
                        self.trigger = Some((trig.trigger.clone(), trig.query.clone()));
                    }
                    return Outcome::default();
                }
                _ => {}
            }
        }
        if let Some(title) = tag.strip_prefix("suggest:") {
            self.body.push_str(&format!("[[{title}]]"));
            self.rev += 1;
            self.trigger = None;
            return self.autosave(e);
        }
        if tag == "trash"
            && let Some(id) = &self.id
        {
            let act = Act::new("entity.trash", json!({ "ids": [id] }));
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, done.undo);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "share" {
            return Outcome::say(&words::shared(EN));
        }
        Outcome::default()
    }
}

impl NoteEditor {
    fn autosave(&mut self, e: &mut Event<'_>) -> Outcome {
        let trimmed = self.title.trim();
        if trimmed.is_empty() {
            self.autosave_phase = wire::RoomAutosavePhase::Dirty;
            self.autosave_label = shared::autosave_edited(EN);
            return Outcome::default();
        }
        if let Some(id) = &self.id {
            let mut input = json!({
                "id": id,
                "title": trimmed,
                "body": self.body,
            });
            if let Some(day) = &self.journal_on {
                input["journal_on"] = json!(day);
            }
            match e.door.act(&Act::new("note.edit", input)) {
                Ok(_) => {
                    self.autosave_phase = wire::RoomAutosavePhase::Saved;
                    self.autosave_label = shared::autosave_saved(EN);
                    Outcome::done(&words::note_saved(EN), true)
                }
                Err(refused) => {
                    self.autosave_phase = wire::RoomAutosavePhase::Refused;
                    self.autosave_label = shared::autosave_not_saved(EN);
                    Outcome::refuse(&refused.0)
                }
            }
        } else {
            let id = mint_uuid_v7(e.door.now_ms());
            let mut input = json!({
                "id": id,
                "title": trimmed,
                "body": self.body,
            });
            if let Some(book) = &self.notebook_id {
                input["notebook_id"] = json!(book);
            }
            if let Some(day) = &self.journal_on {
                input["journal_on"] = json!(day);
            }
            match e.door.act(&Act::new("note.create", input)) {
                Ok(_) => {
                    self.id = Some(id);
                    self.autosave_phase = wire::RoomAutosavePhase::Saved;
                    self.autosave_label = shared::autosave_saved(EN);
                    Outcome::done(&words::note_created(EN), true)
                }
                Err(refused) => {
                    self.autosave_phase = wire::RoomAutosavePhase::Refused;
                    self.autosave_label = shared::autosave_not_saved(EN);
                    Outcome::refuse(&refused.0)
                }
            }
        }
    }
}

struct NoteVersions {
    id: String,
}

impl RoomScreen for NoteVersions {
    fn key(&self) -> String {
        format!("notes/note/{}/versions", self.id)
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
                glyph("History", "notes"),
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
                            "note.restore_version",
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

struct TagsList;

impl RoomScreen for TagsList {
    fn key(&self) -> String {
        TAGS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let tags = match b.run(&reads::TAGS, &Args::new()) {
            Ok(answer) => answer.rows,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, TAGS)
                    .title(&words::tags_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count_str = words::tags_count(EN, tags.len() as u64);
        let mut content = Vec::new();
        if tags.is_empty() {
            content.push(blocks::empty(
                glyph("Tag", "notes"),
                &words::empty_tags_title(EN),
                &words::empty_tags_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = tags
                .iter()
                .map(|tag| {
                    let id = &tag.id;
                    let menu = blocks::menu(
                        &format!("tag/{id}/menu"),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("tag/{id}/menu/open"),
                                    &words::menu_open(EN),
                                    Handler::Open(format!("notes/tag/{id}")),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("tag/{id}/menu/rename"),
                                    &words::menu_rename(EN),
                                    Handler::Open(format!("notes/tag/{id}/rename")),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("tag/{id}/menu/merge"),
                                    &words::menu_merge(EN),
                                    Handler::Open(format!("notes/tag/{id}/merge")),
                                ),
                            ],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("tag/{id}"),
                        &tag.title,
                        Handler::Open(format!("notes/tag/{id}")),
                    )
                    .mark(blocks::glyph_mark("Tag", "notes"))
                    .menu(menu)
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/tags", &words::section_tags(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::PushedPage, TAGS)
            .title(&words::tags_title(EN))
            .subtitle(&count_str)
            .back(&mut b.sel, &words::title(EN))
            .ready(content)
            .build()
    }
}

struct TagDetail {
    id: String,
    loaded: usize,
}

impl RoomScreen for TagDetail {
    fn key(&self) -> String {
        format!("notes/tag/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let tag = match b.run(&reads::TAG_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::tags_title(EN))
                    .back(&mut b.sel, &words::tags_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(tag) = tag else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::tags_title(EN))
                .back(&mut b.sel, &words::tags_title(EN))
                .ready(vec![blocks::empty(
                    glyph("Tag", "notes"),
                    &words::tag_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };
        let notes = match b.reload(
            &reads::BY_TAG,
            &Args::new().text("tag", &self.id),
            self.loaded,
        ) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&tag.title)
                    .back(&mut b.sel, &words::tags_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count_str = words::notes_count(EN, notes.rows.len() as u64);
        let mut content = Vec::new();
        if notes.rows.is_empty() {
            content.push(blocks::empty(
                glyph("Tag", "notes"),
                &words::empty_tag_notes_title(EN),
                &words::empty_tag_notes_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = notes
                .rows
                .iter()
                .map(|row| build_note_row(&mut b.sel, "note", row, false, false))
                .collect();
            let mut sec = blocks::section(&mut b.sel, "section/notes", &words::section_notes(EN))
                .blocks(rows);
            if notes.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/notes/more");
            }
            content.push(sec.into_block());
        }
        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "header/menu/rename",
                        &words::menu_rename(EN),
                        Handler::Open(format!("notes/tag/{}/rename", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "header/menu/merge",
                        &words::menu_merge(EN),
                        Handler::Open(format!("notes/tag/{}/merge", self.id)),
                    ),
                ],
            )],
            &mut b.sel,
        );
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&tag.title)
            .subtitle(&count_str)
            .back(&mut b.sel, &words::tags_title(EN))
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

struct RenameTagForm {
    id: String,
    initialized: bool,
    error: Option<String>,
}

impl RenameTagForm {
    fn new(id: String) -> Self {
        Self {
            id,
            initialized: false,
            error: None,
        }
    }
}

impl RoomScreen for RenameTagForm {
    fn key(&self) -> String {
        format!("notes/tag/{}/rename", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.initialized {
            self.initialized = true;
            if let Ok(answer) = b.run(&reads::TAG_BY_ID, &Args::new().text("id", &self.id))
                && let Some(tag) = answer.rows.into_iter().next()
            {
                b.ui.fields.get_or("name", &tag.title);
            }
        }
        let mut field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_tag_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if let Some(err) = &self.error {
            field = field.error(err);
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
                dirty: true,
                drafted: false,
                save: Handler::Tag("save".to_owned()),
                cancel: Handler::Back,
            },
        );
        let block = form::form(vec![field.build()], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::rename_tag_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_title_required(EN));
                return Outcome::default();
            }
            let act = Act::new("entity.retitle", json!({ "id": self.id, "title": name }));
            return match e.door.act(&act) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::tag_renamed(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct MergeTagPick {
    id: String,
}

impl RoomScreen for MergeTagPick {
    fn key(&self) -> String {
        format!("notes/tag/{}/merge", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_title = b
            .run(&reads::TAG_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|t| t.title)
            .unwrap_or_default();
        let tags = b
            .run(&reads::TAGS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let others: Vec<_> = tags.into_iter().filter(|t| t.id != self.id).collect();
        let mut content = Vec::new();
        if others.is_empty() {
            content.push(blocks::empty(
                glyph("Tag", "notes"),
                &words::merge_empty_title(EN),
                &words::merge_empty_body(EN),
                None,
            ));
        } else {
            let heading = fill(&words::merge_pick_heading(EN), &[("title", &from_title)]);
            let rows: Vec<_> = others
                .iter()
                .map(|target| {
                    blocks::row(
                        &mut b.sel,
                        &format!("target/{}", target.id),
                        &target.title,
                        Handler::Open(format!("notes/tag/{}/merge/{}", self.id, target.id)),
                    )
                    .mark(blocks::glyph_mark("Tag", "notes"))
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/targets", &heading)
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::merge_tag_title(EN))
            .back(&mut b.sel, &words::tags_title(EN))
            .ready(content)
            .build()
    }
}

struct MergeTagConfirm {
    from: String,
    into: String,
}

impl RoomScreen for MergeTagConfirm {
    fn key(&self) -> String {
        format!("notes/tag/{}/merge/{}", self.from, self.into)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_title = b
            .run(&reads::TAG_BY_ID, &Args::new().text("id", &self.from))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|t| t.title)
            .unwrap_or_default();
        let into_title = b
            .run(&reads::TAG_BY_ID, &Args::new().text("id", &self.into))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|t| t.title)
            .unwrap_or_default();
        let body = fill(
            &words::merge_confirm_body(EN),
            &[("from", &from_title), ("into", &into_title)],
        );
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::merge_confirm_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::merge_confirm_action(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::merge_confirm_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new(
                "concept.merge",
                json!({ "from": self.from, "into": self.into }),
            );
            return match e.door.act(&act) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::tag_merged(EN), false);
                    out.nav = super::screen::Nav::Replace(TAGS.to_owned());
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct NotesTrash {
    loaded: usize,
}

impl Default for NotesTrash {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for NotesTrash {
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
                glyph("Trash", "notes"),
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
                        Handler::Open(format!("notes/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_btn = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("notes/trash/empty".to_owned()),
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
        format!("notes/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(
            &shared::trash_purge_title(EN),
            &[("noun", &shared::trash_noun_note(EN))],
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
        "notes/trash/empty".to_owned()
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
                json!({ "kinds": ["note", "notebook", "list"] }),
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
