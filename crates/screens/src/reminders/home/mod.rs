//! THE HOME OF REMINDERS (#1128, split from Agenda in round 10 of #1173): the smart lists and My
//! Lists, with Search and More. It reads tasks alone ([`held`]) and has no day: the Inbox is a list
//! among the lists, a task opens from its list, and the quick-add bar lands in the Inbox.
//!
//! The band holds places only (R-CHROME-5): Reminders and More. Search is the bar under the title
//! (R-CHROME-2), opened by `SearchOpened`, and the More sheet's rows are computed here
//! ([`chrome::more_rows`]) so both platforms draw one list.
//!
//! ## Rows open pages by their own route
//!
//! A project row or container, a smart list and the Catch up verb carry the [`wire::Route`] to push;
//! this screen never sees the tap.

mod chrome;
mod held;
mod place;
mod search;

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Sheet;
use wire::screen_event::Kind as E;

use self::held::Held;
use crate::kit::schedule::natural::{Chipper, Fields};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::phase::Phase;
use crate::kit::schedule::rows;
use crate::kit::schedule::style::{Draft, Subject};
use crate::reminders::ops::NewTask;
use crate::reminders::quick::Quick;
use crate::reminders::view::Prefs;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    agenda as words, agenda_home as sentences, agenda_reminders as reminders, fill, task,
};

/// The quick-add bar: a bare title that lands in the Inbox.
#[derive(Default)]
struct QuickAdd {
    title: String,
    /// The bar is drawn: the Plus (or Notes' "Send to Reminders") opened it.
    drawn: bool,
    focused: bool,
    /// What the keyboard toolbar has staged for the next add (#1173).
    staged: Quick,
    /// The core's clock and the chip's dismissal (#1173 Wave 3).
    chip: Chipper,
}

pub(super) struct Home {
    phase: Phase,
    /// The day the core last named as today.
    today: String,
    search_open: bool,
    search_term: String,
    sheet: Sheet,
    /// The Import reminders sheet's option "Include completed reminders"; off each time it opens.
    import_completed: bool,
    filing_task_id: String,
    /// The style sheet's draft: the new list.
    style: Option<Draft>,
    quick: QuickAdd,
    /// The window, widened by "Show more".
    limit: u32,
    ops: Ops,
    held: Held,
    /// The "Filter and sort" choice, kept on the phone (`view`).
    prefs: Prefs,
}

/// The registry factory for Reminders' home.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let args = match &route.args {
        Some(wire::route::Args::AgendaHome(args)) => args.clone(),
        _ => wire::AgendaHomeRoute::default(),
    };
    Some(Box::new(Home::new(&args)))
}

impl Home {
    fn new(args: &wire::AgendaHomeRoute) -> Self {
        // SEEDED WORDS (Notes' "Send to Reminders") wait in the bar, focused.
        let seed = args.quick_add_title.trim().to_owned();
        let bar = !seed.is_empty() || args.open_quick_add;
        Self {
            phase: Phase::Loading,
            today: String::new(),
            search_open: false,
            search_term: String::new(),
            sheet: Sheet::None,
            import_completed: false,
            filing_task_id: String::new(),
            style: None,
            quick: QuickAdd {
                drawn: bar,
                focused: bar,
                title: seed,
                staged: Quick::default(),
                chip: Chipper::default(),
            },
            limit: rows::PAGE,
            ops: Ops::default(),
            held: Held::default(),
            prefs: Prefs::default(),
        }
    }

    /// The term search is answering, or `None` when search is not reading.
    fn active_term(&self) -> Option<String> {
        let term = self.search_term.trim();
        (self.search_open && !term.is_empty()).then(|| term.to_owned())
    }

    fn denied(&self) -> bool {
        matches!(self.phase, Phase::Denied(_))
    }

    /// A pull, or a row moved: the held answers are stale whatever search is
    /// doing, so the next read asks again.
    fn refresh(&mut self, ctx: &Ctx) {
        self.invalidate();
        self.read(ctx);
    }

    fn close_search(&mut self) {
        self.search_open = false;
        self.search_term.clear();
        self.held.search = None;
        self.held.search_term = None;
    }

    /// The quick-add bar put away, its words with it: search opened.
    fn shut_quick_add(&mut self) {
        self.quick = QuickAdd::default();
    }

    fn on_event(&mut self, event: H, ctx: &Ctx) {
        match event {
            H::Refreshed(_) => self.refresh(ctx),
            // Taken before this match: it returns the shell's effects.
            H::FilterMenuPicked(_) | H::FilterMenuCleared(_) => {}
            H::Band(picked) => {
                if picked.key == chrome::BAND_MORE {
                    self.sheet = Sheet::More;
                }
            }
            H::SearchOpened(_) => {
                self.shut_quick_add();
                self.search_open = true;
                self.sheet = Sheet::None;
            }
            H::SearchTerm(typed) => {
                self.shut_quick_add();
                self.search_open = true;
                self.sheet = Sheet::None;
                self.search_term = typed.term;
                if self.active_term().is_none() {
                    self.held.search = None;
                    self.held.search_term = None;
                }
                self.read(ctx);
            }
            H::SearchClosed(_) => {
                self.close_search();
                self.read(ctx);
            }
            H::MoreRow(picked) => self.more_row(&picked.key, ctx),
            H::SheetOpened(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                if sheet != Sheet::Unspecified {
                    self.open_sheet(sheet);
                }
            }
            H::SheetClosed(_) => {
                self.sheet = Sheet::None;
                self.filing_task_id.clear();
                self.style = None;
            }
            H::TaskChecked(checked) => {
                if let Some(found) = self.held.find(&checked.task_id) {
                    self.ops.check(ctx, &found);
                    self.refresh(ctx);
                }
            }
            H::TaskFlagged(flagged) => {
                if self.held.find(&flagged.task_id).is_some() {
                    self.ops.flag(ctx, &flagged.task_id, flagged.flagged);
                    self.refresh(ctx);
                }
            }
            H::StatusActed(_) => {
                self.ops.undo(ctx);
                self.refresh(ctx);
            }
            H::FileRequested(asked) => {
                if self.held.find(&asked.task_id).is_some() {
                    self.sheet = Sheet::File;
                    self.filing_task_id = asked.task_id;
                }
            }
            H::FileChosen(chosen) => self.file(&chosen.key, ctx),
            H::QuickAddChanged(typed) => self.quick.title = typed.title,
            H::QuickAddChipDismissed(_) => {
                let words = self.quick.title.clone();
                self.quick.chip.dismiss(&words);
            }
            H::QuickAddSubmitted(_) => self.add(ctx),
            // THE PLUS OPENS THE BAR on the keyboard (R-CHROME-1).
            H::QuickAddOpened(_) => {
                self.quick.drawn = true;
                self.quick.focused = true;
                self.quick.chip.hold(ctx);
            }
            // THE KEYBOARD LEFT IT: an empty bar goes away; typed words keep it
            // open, so nothing the member wrote is thrown away.
            H::QuickAddClosed(_) => {
                if self.quick.title.trim().is_empty() {
                    self.shut_quick_add();
                }
            }
            H::StyleName(typed) => self.style_name(typed.name),
            H::StyleColor(picked) => {
                if let Some(draft) = &mut self.style {
                    draft.pick_color(&picked.key);
                }
            }
            H::StyleIcon(picked) => {
                if let Some(draft) = &mut self.style {
                    draft.pick_icon(&picked.key);
                }
            }
            H::StyleSubmitted(_) => self.submit_style(ctx),
            // THE IMPORT REMINDERS SHEET (iOS): the switch, then the verb.
            H::ImportRemindersCompleted(_) => {
                if self.sheet == Sheet::ImportReminders {
                    self.import_completed = !self.import_completed;
                }
            }
            H::ImportRemindersSubmitted(_) => self.import_reminders(ctx),
            // THE EMPTY LIST'S ONE ACTION is the new-project sheet.
            H::TodoEmptyActed(_) => {
                let acts = self
                    .data(ctx)
                    .and_then(|data| data.todo)
                    .and_then(|todo| todo.empty)
                    .is_some_and(|empty| !empty.action_label.is_empty());
                if acts {
                    self.open_sheet(Sheet::NewProject);
                }
            }
            // THE SWIPE'S DELETE: to the trash, with Undo.
            H::TaskDeleted(deleted) => {
                if let Some(task) = self.held.find(&deleted.task_id) {
                    self.ops.delete(ctx, &deleted.task_id, &task.title);
                    self.refresh(ctx);
                }
            }
            // THE KEYBOARD TOOLBAR (#1173): drawn over the bar only.
            H::QuickTool(picked) if self.toolbar_up() => self.quick.staged.pick_tool(&picked.key),
            H::QuickDue(picked) if self.toolbar_up() => self.quick.staged.pick_due(&picked.key),
            H::QuickTag(added) if self.toolbar_up() => self.quick.staged.add_tag(&added.text),
            H::NextPage(_) => {
                if self.limit < rows::MAX_WINDOW {
                    self.limit = (self.limit + rows::PAGE).min(rows::MAX_WINDOW);
                    self.held.todo = false;
                    self.read(ctx);
                }
            }
            // Calendar's gestures: a days-and-hours home Reminders does not have.
            _ => {}
        }
    }

    /// A More row, by its key. A key the sheet does not hold now does nothing.
    fn more_row(&mut self, key: &str, ctx: &Ctx) {
        let rows = self.more_rows(ctx);
        let Some(row) = rows.iter().find(|row| row.key == key) else {
            return;
        };
        if row.key == chrome::MORE_READS {
            self.sheet = Sheet::Reads;
        } else if row.key == chrome::MORE_IMPORT_REMINDERS {
            self.import_completed = false;
            self.sheet = Sheet::ImportReminders;
        } else if chrome::TASK_PLACES.contains(&row.key.as_str()) {
            // A PLACE IS A PAGE: the sheet closes, and the shell pushes the row's route.
            self.sheet = Sheet::None;
        }
    }

    /// The Import reminders sheet's verb: ask the ONE reminders import (`imports.made`'s
    /// `RemindersRequested`) to read the phone with the sheet's option. It runs without the import
    /// status banner's offer and says its outcome on the import status line, in the import's own
    /// words. Only where the platform has a Reminders store; the sheet shuts either way.
    fn import_reminders(&mut self, ctx: &Ctx) {
        if self.sheet != Sheet::ImportReminders {
            return;
        }
        let include_completed = std::mem::take(&mut self.import_completed);
        self.sheet = Sheet::None;
        if !ctx.reminders_source() {
            return;
        }
        ctx.post(
            crate::imports::MADE,
            wire::ScreenEvent {
                kind: Some(E::ImportsMade(wire::ImportsMadeEvent {
                    kind: Some(wire::imports_made_event::Kind::RemindersRequested(
                        wire::imports_made_event::RemindersRequested { include_completed },
                    )),
                })),
            },
        );
    }

    /// A filing choice: the write it makes, with the sheet shut.
    fn file(&mut self, key: &str, ctx: &Ctx) {
        let id = std::mem::take(&mut self.filing_task_id);
        self.sheet = Sheet::None;
        let (Some(found), Some((project, section, label))) = (
            self.held.find(&id),
            place::filing(ctx.locale(), &self.held, key),
        ) else {
            return;
        };
        self.ops
            .file(ctx, &found, project.as_deref(), section.as_deref(), &label);
        self.refresh(ctx);
    }

    /// The bar is drawn, so its toolbar answers.
    fn toolbar_up(&self) -> bool {
        self.quick.drawn && !self.denied()
    }

    /// The quick add, landing in the Inbox: the words as typed, or, while
    /// the date chip shows, the title and day it names, plus what the toolbar
    /// staged (a staged day wins over a phrase in the words). The bar keeps its
    /// words and its staging when the vault refuses, and after an add it stays
    /// drawn and focused for the next one.
    fn add(&mut self, ctx: &Ctx) {
        let title = self.quick.title.trim().to_owned();
        if title.is_empty() || self.denied() {
            return;
        }
        let inbox = task::inbox(ctx.locale());
        // THE CORE'S CLOCK, read just now, never the device's. A day the toolbar
        // staged is the member's explicit pick: it wins, and the words stay as typed.
        let staged_day = self.quick.staged.due_day(&self.held.today());
        let fields = if staged_day.is_empty() {
            self.quick.chip.fields(ctx, &title)
        } else {
            Fields {
                title: title.clone(),
                due: staged_day,
                ..Fields::default()
            }
        };
        let new = NewTask {
            tags: self.quick.staged.tags(),
            flagged: self.quick.staged.flagged(),
            ..NewTask::dated(&fields)
        };
        if self.ops.add_full(ctx, &new, &inbox).is_some() {
            self.quick.title.clear();
            self.quick.chip.clear();
            self.quick.staged.clear();
            self.quick.drawn = true;
            self.quick.focused = true;
        }
        self.refresh(ctx);
    }

    /// A sheet up, with the draft it names: a new list starts blank.
    fn open_sheet(&mut self, sheet: Sheet) {
        match sheet {
            Sheet::NewProject => {
                self.style = Some(Draft::making(Subject::List));
            }
            // Calendar's sheets, and the filing and import sheets, open by their own events.
            Sheet::NewCalendar | Sheet::EditCalendar | Sheet::File | Sheet::ImportReminders => {
                return;
            }
            _ => {}
        }
        self.sheet = sheet;
    }

    fn style_name(&mut self, name: String) {
        self.style
            .get_or_insert_with(|| Draft::making(Subject::List))
            .set_name(name);
    }

    /// Create or Save on the style sheet. A refusal keeps the sheet and the
    /// member's words, and the status line says why.
    fn submit_style(&mut self, ctx: &Ctx) {
        let Some(draft) = self.style.take() else {
            return;
        };
        if !draft.can_submit() {
            self.style = Some(draft);
            return;
        }
        if draft.submit(ctx, &mut self.ops) {
            self.sheet = Sheet::None;
        } else {
            self.style = Some(draft);
        }
        self.refresh(ctx);
    }

    /// The data the held answers draw, or `None` when they are not for this state.
    fn data(&self, ctx: &Ctx) -> Option<wire::AgendaHomeData> {
        let locale = ctx.locale();
        if self.active_term().is_none() {
            return place::fold_shaped(
                locale,
                ctx.hour_cycle(),
                &self.held,
                self.limit,
                &self.prefs.options,
            );
        }
        place::search_data(locale, ctx.hour_cycle(), &self.held)
    }

    fn more_rows(&self, ctx: &Ctx) -> Vec<wire::AgendaMoreRow> {
        if self.denied() {
            return Vec::new();
        }
        chrome::more_rows(ctx.locale(), ctx.reminders_source())
    }

    /// Whether the Filter and sort menu is on the page: with its list showing.
    fn menu_offered(&self) -> bool {
        !self.denied() && self.active_term().is_none()
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                // SEEDED WORDS wait in the bar: read them against the core's clock.
                if self.quick.drawn {
                    self.quick.chip.hold(ctx);
                }
                self.refresh(ctx);
                return self.prefs.ask().into_iter().collect();
            }
            Some(E::EnvironmentChanged(_) | E::DataChanged(_)) => self.refresh(ctx),
            Some(E::StatusActed(_)) => {
                self.ops.undo(ctx);
                self.refresh(ctx);
            }
            Some(E::AgendaHome(home)) => match home.kind {
                Some(H::FilterMenuPicked(picked)) if self.menu_offered() => {
                    let mut options = self.prefs.options;
                    if options.pick(crate::kit::menu::Pick::of(&picked)) {
                        self.prefs.options = options;
                        return vec![self.prefs.save()];
                    }
                }
                Some(H::FilterMenuCleared(_)) if self.menu_offered() => {
                    if self.prefs.options.clear() {
                        return vec![self.prefs.save()];
                    }
                }
                Some(H::FilterMenuPicked(_) | H::FilterMenuCleared(_)) => {}
                Some(kind) => self.on_event(kind, ctx),
                None => {}
            },
            Some(E::EffectResult(result)) => {
                // THE CHOICE'S OWN ANSWER.
                self.prefs.answers(&result);
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let denied = self.denied();
        let data = match self.phase {
            Phase::Ready => self.data(ctx),
            _ => None,
        };
        let searching = self.active_term().is_some();
        let content = match &self.phase {
            Phase::Loading => Some(wire::agenda_home_state::Content::Loading(wire::Loading {
                first_load: true,
            })),
            Phase::Denied(denial) => Some(wire::agenda_home_state::Content::Denied(wire::Denied {
                title: words::denied_title(locale),
                body: words::denied_body(locale),
                receipt: denial.code.clone().unwrap_or_default(),
            })),
            Phase::Failed => Some(wire::agenda_home_state::Content::Failure(
                crate::kit::read::failure(locale),
            )),
            Phase::Ready => match data.clone() {
                Some(data) => Some(wire::agenda_home_state::Content::Data(Box::new(data))),
                None => Some(wire::agenda_home_state::Content::Failure(
                    crate::kit::read::incomplete(locale),
                )),
            },
        };
        let term = self.active_term();
        let held_search = term.is_some() && self.held.search.is_some();
        let corrected = if held_search {
            self.held
                .search
                .as_ref()
                .map(|tasks| tasks.corrected.as_str())
                .filter(|words| !words.is_empty())
                .map(|words| crate::kit::search::corrected(locale, words))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let sheet_up = matches!(
            self.sheet,
            Sheet::More | Sheet::Reads | Sheet::ImportReminders
        );
        let drawn = self.quick.drawn;
        wire::ViewState {
            kind: Some(wire::view_state::Kind::AgendaHome(Box::new(
                wire::AgendaHomeState {
                    destination: Dest::Todo as i32,
                    anchor_day: String::new(),
                    search_open: self.search_open,
                    search_term: self.search_term.clone(),
                    hidden_calendar_ids: Vec::new(),
                    sheet: self.sheet as i32,
                    band: if denied {
                        Vec::new()
                    } else {
                        chrome::band(locale, sheet_up)
                    },
                    calendar_header: Some(chrome::header(locale, !denied && !searching)),
                    filter_menu: (self.menu_offered() && data.is_some())
                        .then(|| self.prefs.options.menu(locale)),
                    calendar_views: Vec::new(),
                    calendar_view_label: reminders::view_menu(locale),
                    toolbar: Some(wire::AgendaToolbar::default()),
                    chrome: Some(chrome::words_of(locale)),
                    app_key: "reminders".to_owned(),
                    more_rows: if denied {
                        Vec::new()
                    } else {
                        chrome::more_rows(locale, ctx.reminders_source())
                    },
                    search_corrected: corrected,
                    // THE ASK ROW: for the answer to the term on screen, matched or not.
                    search_ask_row: (held_search && data.is_some()).then(|| {
                        crate::kit::search::offer(
                            locale,
                            term.as_deref().unwrap_or_default(),
                            "reminders",
                        )
                    }),
                    status: self.ops.status(),
                    quick_add: Some({
                        let mut bar = wire::TodoQuickAdd {
                            title: self.quick.title.clone(),
                            can_submit: !self.quick.title.trim().is_empty(),
                            lands_label: fill(
                                &sentences::lands_in(locale),
                                &[("place", &task::inbox(locale))],
                            ),
                            // Hidden while search is open, term or not: the bar and its
                            // Plus would be a second verb over a field that is looking.
                            shown: !denied && data.is_some() && !self.search_open,
                            focused: drawn && self.quick.focused,
                            add_label: task::add_task(locale),
                            drawn,
                            // A day the toolbar staged is the date: no second reading.
                            chip: if self.quick.staged.due_day(&self.held.today()).is_empty() {
                                self.quick
                                    .chip
                                    .reading(locale, ctx.hour_cycle(), &self.quick.title)
                                    .map(|reading| reading.chip())
                            } else {
                                None
                            },
                            ..wire::TodoQuickAdd::default()
                        };
                        self.quick.staged.fill(locale, &mut bar);
                        bar
                    }),
                    file_choices: if self.sheet == Sheet::File {
                        place::file_choices(locale, &self.held, &self.filing_task_id)
                    } else {
                        Vec::new()
                    },
                    style: self
                        .style
                        .as_ref()
                        .filter(|_| matches!(self.sheet, Sheet::NewProject))
                        .map(|draft| Box::new(draft.sheet(locale))),
                    import_reminders: (self.sheet == Sheet::ImportReminders
                        && ctx.reminders_source())
                    .then(|| chrome::import_reminders_sheet(locale, self.import_completed)),
                    add_label: task::add_task(locale),
                    add_opens_quick_add: true,
                    new_event: None,
                    // Stopping the phone's calendars is Calendar's.
                    stop: None,
                    content,
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}
