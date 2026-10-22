//! NOTES' HOME (`notes.home`): Notes · Notebooks · Journal under ONE band, with
//! Search as a field over the Notes place and More as a sheet.
//!
//! The three places are one screen with the place a value, so a band tap swaps
//! what is drawn and no stack entry: back never walks through the places a
//! member happened to tap, and a notebook (or Unfiled) tapped in Notebooks opens
//! the Notes place filtered to it.
//!
//! - **Reads** go through `ctx.load` on the place that is showing, on `Appeared`
//!   and whenever a table it read changes.
//! - **Writes** are one at a time and synchronous (`kit::act`); the load after
//!   each shows what committed, and a refusal's sentence is the status line.
//! - **Views decide nothing**: the band, the chrome, the heading, the chips,
//!   More's rows and every empty sentence are made here on every view.

use centraid_api_proto::core_v1 as wire;
use wire::notes_home_event::Kind as H;
use wire::screen_event::Kind as E;

use super::{Phase, denied, routes};
use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, notes as words};

mod journal;
mod library;
mod notebooks;

use journal::{Compose, Journal};
use library::{Content, Library};
use notebooks::{Form, Notebooks, UNFILED};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::NotesHome(args)) = &route.args else {
        return None;
    };
    let place = match wire::NotesPlace::try_from(args.place) {
        Ok(wire::NotesPlace::Unspecified) | Err(_) => wire::NotesPlace::Notes,
        Ok(place) => place,
    };
    Some(Box::new(Home {
        place,
        library: Library::new(&args.notebook_id, &args.notebook_name, args.unfiled_only),
        notebooks: Notebooks::new(),
        journal: Journal::new(),
        sheet: wire::NotesSheet::None,
        menu_id: String::new(),
        asking: Asking::Nothing,
        status: None,
        form: None,
        compose: None,
    }))
}

/// What a confirm on screen will do once the member says so.
enum Asking {
    Nothing,
    TrashNote(String),
    DeleteNotebook(String),
}

struct Home {
    place: wire::NotesPlace,
    library: Library,
    notebooks: Notebooks,
    journal: Journal,
    sheet: wire::NotesSheet,
    /// The note (or notebook) the open row menu is about.
    menu_id: String,
    asking: Asking,
    /// A refusal's sentence over the page; the page stays.
    status: Option<wire::StatusLine>,
    form: Option<Form>,
    compose: Option<Compose>,
}

impl Home {
    fn reload(&mut self, ctx: &Ctx) {
        match self.place {
            wire::NotesPlace::Notebooks => self.notebooks.reload(ctx),
            wire::NotesPlace::Journal => self.journal.reload(ctx),
            _ => self.library.reload(ctx),
        }
    }

    fn denied(&self) -> bool {
        match self.place {
            wire::NotesPlace::Notebooks => matches!(self.notebooks.phase, Phase::Denied(_)),
            wire::NotesPlace::Journal => matches!(self.journal.phase, Phase::Denied(_)),
            _ => matches!(self.library.phase, Phase::Denied(_)),
        }
    }

    fn close_sheet(&mut self) {
        self.sheet = wire::NotesSheet::None;
        self.menu_id.clear();
    }

    /// Show `place`, from nothing: another place is a fresh page.
    fn go(&mut self, ctx: &Ctx, place: wire::NotesPlace) {
        self.place = place;
        self.close_sheet();
        self.asking = Asking::Nothing;
        self.status = None;
        self.form = None;
        self.compose = None;
        if place == wire::NotesPlace::Notes {
            self.library = Library::new("", "", false);
        }
        self.reload(ctx);
    }

    /// One write under a key of its own; a refusal is the status line, and
    /// either way the place is read again. Returns whether it committed.
    fn write(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, subject: &str) -> bool {
        let request = request.into();
        let key = kit_act::key(&[&request.action.clone(), subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.status = (!settled.committed).then(|| wire::StatusLine {
            sentence: settled.refusal.clone(),
            action_label: String::new(),
            refused: true,
        });
        self.reload(ctx);
        settled.committed
    }

    fn pin(&mut self, ctx: &Ctx, note_id: &str) {
        let Some(found) = self.library.find(ctx.locale(), note_id) else {
            self.close_sheet();
            return;
        };
        self.close_sheet();
        // A PIN IS A DECISION, and it saves at once: the shared verb that sets
        // or clears the `pinned` flag.
        if found.pinned {
            self.write(
                ctx,
                act::notes::UnflagNote {
                    note_id: note_id.to_owned(),
                    flag: act::notes::UnflagNoteFlag::Pinned,
                },
                note_id,
            );
        } else {
            self.write(
                ctx,
                act::notes::FlagNote {
                    note_id: note_id.to_owned(),
                    flag: act::notes::FlagNoteFlag::Pinned,
                },
                note_id,
            );
        }
    }

    fn open_row_menu(&mut self, ctx: &Ctx, note_id: &str) {
        if self.library.find(ctx.locale(), note_id).is_some() {
            self.sheet = wire::NotesSheet::RowMenu;
            self.menu_id = note_id.to_owned();
        }
    }

    fn open_file_into(&mut self, ctx: &Ctx, note_id: &str) {
        if self.library.find(ctx.locale(), note_id).is_some() {
            self.sheet = wire::NotesSheet::FileInto;
            self.menu_id = note_id.to_owned();
        }
    }

    fn file_into(&mut self, ctx: &Ctx, notebook_id: &str) {
        let note_id = std::mem::take(&mut self.menu_id);
        self.close_sheet();
        let Some(found) = self.library.find(ctx.locale(), &note_id) else {
            return;
        };
        if found.notebook_id == notebook_id {
            return;
        }
        let notebook_id_field = if notebook_id.is_empty() {
            crate::field::Field::Clear
        } else {
            crate::field::Field::Is(notebook_id.to_owned())
        };
        let to = format!("{note_id}:to={notebook_id}");
        self.write(
            ctx,
            act::notes::MoveNote {
                note_id,
                notebook_id: notebook_id_field,
            },
            &to,
        );
    }

    fn ask_trash(&mut self, ctx: &Ctx, note_id: &str) {
        if self.library.find(ctx.locale(), note_id).is_none() {
            return;
        }
        self.close_sheet();
        self.asking = Asking::TrashNote(note_id.to_owned());
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        match std::mem::replace(&mut self.asking, Asking::Nothing) {
            Asking::TrashNote(id) => {
                self.write(ctx, act::notes::DeleteNote { note_id: id.clone() }, &id);
            }
            Asking::DeleteNotebook(id) => {
                self.write(
                    ctx,
                    act::notes::DeleteNotebook {
                        notebook_id: id.clone(),
                    },
                    &id,
                );
            }
            Asking::Nothing => {}
        }
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match self.asking {
            Asking::Nothing => None,
            Asking::TrashNote(_) => Some(wire::Confirm {
                title: words::delete_note_title(locale),
                body: words::delete_note_body(locale),
                confirm_label: words::delete_note_verb(locale),
                destructive: true,
            }),
            Asking::DeleteNotebook(_) => Some(wire::Confirm {
                title: words::delete_notebook_title(locale),
                body: words::delete_notebook_body(locale),
                confirm_label: words::delete_notebook_verb(locale),
                destructive: true,
            }),
        }
    }

    fn pick_notebook(&mut self, ctx: &Ctx, id: &str) {
        let locale = ctx.locale();
        self.close_sheet();
        // THE NOTES PLACE, FILTERED: Unfiled is the unfiled filter, not a notebook id.
        let library = if id == UNFILED {
            Library::new("", "", true)
        } else {
            let name = self.notebooks.name_of(locale, id).unwrap_or_default();
            Library::new(id, &name, false)
        };
        self.place = wire::NotesPlace::Notes;
        self.library = library;
        self.status = None;
        self.library.reload(ctx);
    }

    fn open_form(&mut self, ctx: &Ctx, notebook_id: &str) {
        self.close_sheet();
        let name = if notebook_id.is_empty() {
            String::new()
        } else {
            self.notebooks
                .name_of(ctx.locale(), notebook_id)
                .unwrap_or_default()
        };
        self.form = Some(Form {
            notebook_id: notebook_id.to_owned(),
            name,
            status: String::new(),
        });
    }

    fn confirm_form(&mut self, ctx: &Ctx) {
        let Some(form) = &self.form else {
            return;
        };
        let name = form.name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        let key = form.notebook_id.clone();
        let request: wire::ActRequest = if key.is_empty() {
            act::notes::CreateNotebook {
                title: name.clone(),
                ..Default::default()
            }
            .into()
        } else {
            act::notes::RenameNotebook {
                notebook_id: key.clone(),
                title: name.clone(),
            }
            .into()
        };
        let subject = if key.is_empty() { name } else { key };
        let request_key = kit_act::key(&[&request.action.clone(), &subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &request_key);
        // A COMMITTED SAVE closes the sheet; a refused one keeps the name typed,
        // with the sentence over it.
        if settled.committed {
            self.form = None;
            self.status = None;
        } else if let Some(form) = &mut self.form {
            form.status = settled.refusal;
        }
        self.reload(ctx);
    }

    fn new_entry(&mut self) {
        if self.compose.is_some() {
            return;
        }
        let Some(journal) = self.journal.phase.data() else {
            return;
        };
        // No day to date it by: the answer has not landed, so nothing opens.
        if journal.today.is_empty() {
            return;
        }
        self.compose = Some(Compose {
            day: journal.today.clone(),
            // The zone the day was read in rides with the sheet, so the entry
            // is filed on `day` IN it (east of UTC+11:59 noon UTC is the next day).
            tz: journal.tz.clone(),
            mood: String::new(),
            text: String::new(),
            status: String::new(),
        });
        self.close_sheet();
    }

    fn save_entry(&mut self, ctx: &Ctx) {
        let Some(compose) = &self.compose else {
            return;
        };
        if !compose.can_save() {
            return;
        }
        let mood = compose.mood.trim().to_owned();
        let text = compose.text.trim().to_owned();
        let day = compose.day.clone();
        let request: wire::ActRequest = act::people::AddJournalEntry {
            mood: mood.clone(),
            text,
            entry_date: Some(day.clone()),
            tz: Some(compose.tz.clone()).filter(|tz| !tz.is_empty()),
        }
        .into();
        let key = kit_act::key(&["person.add_journal_entry", &day, &mood], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        // FILED: the sheet goes; a refused one keeps the words, with the sentence over them.
        if settled.committed {
            self.compose = None;
        } else if let Some(compose) = &mut self.compose {
            compose.refused(ctx.locale(), &settled.refusal);
        }
        self.reload(ctx);
    }

    fn event(&mut self, event: wire::NotesHomeEvent, ctx: &Ctx) {
        let Some(kind) = event.kind else {
            return;
        };
        match kind {
            H::Refreshed(_) => self.reload(ctx),
            // The same place is nothing; More is a sheet; another place is a swap.
            H::Band(picked) => match picked.key.as_str() {
                "more" => self.sheet = wire::NotesSheet::More,
                "notes" if self.place != wire::NotesPlace::Notes => {
                    self.go(ctx, wire::NotesPlace::Notes);
                }
                "notebooks" if self.place != wire::NotesPlace::Notebooks => {
                    self.go(ctx, wire::NotesPlace::Notebooks);
                }
                "journal" if self.place != wire::NotesPlace::Journal => {
                    self.go(ctx, wire::NotesPlace::Journal);
                }
                _ => {}
            },
            H::SearchOpened(_) => self.library.search_opened(),
            H::SearchTerm(typed) => self.library.search_term(ctx, typed.term),
            H::SearchClosed(_) => self.library.search_closed(ctx),
            H::Sort(picked) => {
                self.close_sheet();
                self.library.set_sort(
                    ctx,
                    wire::NotesLibrarySort::try_from(picked.sort)
                        .unwrap_or(wire::NotesLibrarySort::Updated),
                );
            }
            H::PinnedOnly(_) => {
                self.close_sheet();
                self.library.toggle_pinned(ctx);
            }
            H::Tag(toggled) => self.library.toggle_tag(ctx, &toggled.concept_id),
            H::WindowWidened(_) => match self.place {
                wire::NotesPlace::Journal => self.journal.widen(ctx),
                _ => self.library.widen(ctx),
            },
            H::Chip(picked) => self.chip(ctx, &picked.key),
            H::SheetOpened(opened) => match wire::NotesSheet::try_from(opened.sheet) {
                Ok(wire::NotesSheet::Sort) => {
                    self.sheet = wire::NotesSheet::Sort;
                }
                Ok(wire::NotesSheet::More) => self.sheet = wire::NotesSheet::More,
                _ => {}
            },
            H::SheetClosed(_) => self.close_sheet(),
            H::RowMenu(opened) => self.open_row_menu(ctx, &opened.note_id),
            H::Pin(toggled) => self.pin(ctx, &toggled.note_id),
            H::FileInto(opened) => self.open_file_into(ctx, &opened.note_id),
            H::NotebookChosen(chosen) => self.file_into(ctx, &chosen.notebook_id),
            // TRASH IS ASKED FIRST, in full sentences.
            H::Trash(asked) => self.ask_trash(ctx, &asked.note_id),
            H::Confirmed(_) => self.confirmed(ctx),
            H::Dismissed(_) => self.asking = Asking::Nothing,
            H::NotebookPicked(picked) => self.pick_notebook(ctx, &picked.id),
            H::FormOpened(opened) => self.open_form(ctx, &opened.notebook_id),
            H::FormName(edited) => {
                if let Some(form) = &mut self.form {
                    form.name = edited.name;
                    form.status.clear();
                }
            }
            H::FormDismissed(_) => self.form = None,
            H::FormConfirmed(_) => self.confirm_form(ctx),
            H::NotebookMenu(opened) => {
                let known = self.notebooks.name_of(ctx.locale(), &opened.notebook_id);
                if known.is_some() {
                    self.sheet = wire::NotesSheet::NotebookMenu;
                    self.menu_id = opened.notebook_id;
                }
            }
            H::NotebookDelete(asked) => {
                self.close_sheet();
                self.asking = Asking::DeleteNotebook(asked.notebook_id);
            }
            H::NewEntry(_) => self.new_entry(),
            H::ComposeEdited(edited) => {
                if let Some(compose) = &mut self.compose {
                    compose.mood = edited.mood;
                    compose.text = edited.text;
                    compose.status.clear();
                }
            }
            H::ComposeClosed(_) => self.compose = None,
            H::ComposeSaved(_) => self.save_entry(ctx),
        }
    }

    /// A CHIP, by its key: the notebook chip widens to every note, Pinned and a
    /// tag toggle themselves, and the sort opens its sheet.
    fn chip(&mut self, ctx: &Ctx, key: &str) {
        if key == library::CHIP_NOTEBOOK {
            self.library.clear_notebook(ctx);
        } else if key == library::CHIP_PINNED {
            self.library.toggle_pinned(ctx);
        } else if key == library::CHIP_SORT {
            self.sheet = wire::NotesSheet::Sort;
        } else if let Some(concept_id) = key.strip_prefix(library::CHIP_TAG) {
            self.library.toggle_tag(ctx, concept_id);
        }
    }

    fn band(&self, locale: Locale) -> Vec<wire::NotesBandTab> {
        if self.denied() {
            return Vec::new();
        }
        let tab = |key: &str, label: String, icon: &str, current: bool| wire::NotesBandTab {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            current,
        };
        let on = |place| self.place == place;
        vec![
            tab(
                "notes",
                words::band_notes(locale),
                "FileText",
                on(wire::NotesPlace::Notes),
            ),
            tab(
                "notebooks",
                words::band_notebooks(locale),
                "Folder",
                on(wire::NotesPlace::Notebooks),
            ),
            tab(
                "journal",
                words::band_journal(locale),
                "Journal",
                on(wire::NotesPlace::Journal),
            ),
            tab("more", words::band_more(locale), "MoreHoriz", false),
        ]
    }

    fn chrome(locale: Locale, place: wire::NotesPlace) -> wire::NotesHomeChrome {
        wire::NotesHomeChrome {
            new_notebook: words::new_notebook(locale),
            search_placeholder: words::search_placeholder(locale),
            search_label: words::search_label(locale),
            search_close: words::search_close(locale),
            retry: words::retry(locale),
            loading: match place {
                wire::NotesPlace::Notebooks => words::loading_notebooks(locale),
                wire::NotesPlace::Journal => words::loading_journal(locale),
                _ => words::loading(locale),
            },
            more_title: words::more_title(locale),
            file_title: words::file_title(locale),
            sort_title: words::sort_title(locale),
            home: words::home(locale),
            row_menu_label: words::row_menu(locale),
            new_entry: words::new_entry(locale),
            journal_origin: words::journal_origin(locale),
            trash_label: words::trash_label(locale),
            notebook_menu_title: words::notebook_menu(locale),
            cancel: words::cancel(locale),
            close: words::close(locale),
        }
    }

    fn title(&self, locale: Locale) -> String {
        match self.place {
            wire::NotesPlace::Notebooks => words::notebooks_title(locale),
            wire::NotesPlace::Journal => words::journal_title(locale),
            _ => self.library.heading(locale),
        }
    }

    /// The sheet's menu and choices, by which sheet is open.
    fn sheet_parts(&self, locale: Locale) -> (Option<wire::NotesRowMenu>, Vec<wire::NotesChoice>) {
        match self.sheet {
            wire::NotesSheet::RowMenu | wire::NotesSheet::FileInto => {
                let Some(found) = self.library.find(locale, &self.menu_id) else {
                    return (None, Vec::new());
                };
                let menu = wire::NotesRowMenu {
                    note_id: self.menu_id.clone(),
                    title: found.title.clone(),
                    pin_label: if found.pinned {
                        words::unpin(locale)
                    } else {
                        words::pin(locale)
                    },
                    file_label: words::file_verb(locale),
                    trash_label: words::delete_note_verb(locale),
                    rename_label: String::new(),
                };
                let choices = if self.sheet == wire::NotesSheet::FileInto {
                    self.library
                        .phase
                        .data()
                        .map(|library| {
                            super::fold::file_choices(locale, &library.notebooks, &found.notebook_id)
                        })
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                (Some(menu), choices)
            }
            wire::NotesSheet::Sort => (None, self.library.sort_choices(locale)),
            wire::NotesSheet::NotebookMenu => {
                let title = self
                    .notebooks
                    .name_of(locale, &self.menu_id)
                    .unwrap_or_default();
                (
                    Some(wire::NotesRowMenu {
                        note_id: self.menu_id.clone(),
                        title,
                        trash_label: words::delete_notebook_verb(locale),
                        rename_label: words::rename(locale),
                        ..wire::NotesRowMenu::default()
                    }),
                    Vec::new(),
                )
            }
            _ => (None, Vec::new()),
        }
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::NotesHome(home)) => self.event(home, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::notes_home_state::Content as C;
        let locale = ctx.locale();
        let loading = || C::Loading(wire::Loading { first_load: true });
        let from_phase = |content: Content| match content {
            Content::Loading => loading(),
            Content::Failed => C::Failure(read::failure(locale)),
            Content::Denied(denial) => C::Denied(denied(locale, &denial)),
            Content::Data(data) => C::Library(data),
        };
        let content = match self.place {
            wire::NotesPlace::Notebooks => match &self.notebooks.phase {
                Phase::Loading => loading(),
                Phase::Failed => C::Failure(read::failure(locale)),
                Phase::Denied(denial) => C::Denied(denied(locale, denial)),
                Phase::Ready(answer) => C::Notebooks(Notebooks::data(locale, answer)),
            },
            wire::NotesPlace::Journal => match &self.journal.phase {
                Phase::Loading => loading(),
                Phase::Failed => C::Failure(read::failure(locale)),
                Phase::Denied(denial) => C::Denied(denied(locale, denial)),
                Phase::Ready(answer) => C::Journal(Journal::data(locale, answer)),
            },
            _ => from_phase(self.library.content(locale)),
        };
        let notes_place = !matches!(
            self.place,
            wire::NotesPlace::Notebooks | wire::NotesPlace::Journal
        );
        let denied_now = self.denied();
        let (menu, choices) = self.sheet_parts(locale);
        let state = wire::NotesHomeState {
            place: self.place as i32,
            title: self.title(locale),
            band: self.band(locale),
            chrome: Some(Self::chrome(locale, self.place)),
            content: Some(content),
            chips: if notes_place {
                self.library.chips(locale)
            } else {
                Vec::new()
            },
            search: notes_place.then(|| self.library.search_state(locale)),
            more_rows: if denied_now {
                Vec::new()
            } else {
                vec![wire::NotesMoreRow {
                    key: "trash".to_owned(),
                    label: words::trash_label(locale),
                    icon_key: "Trash".to_owned(),
                    route: Some(routes::trash()),
                }]
            },
            sheet: self.sheet as i32,
            menu,
            choices,
            confirm: self.confirm(locale),
            status: self.status.clone(),
            form: self.form.as_ref().map(|form| form.view(locale)),
            compose: self.compose.as_ref().map(|compose| compose.view(locale)),
            new_note: Some(routes::new_note()),
            window: self.library.window,
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::NotesHome(state)),
            ..wire::ViewState::default()
        }
    }
}
