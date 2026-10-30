//! AGENDA'S HOME (#1046, #1128): Day, Schedule, Waiting and To-do, with Search
//! as a mode and More as a sheet.
//!
//! The band holds places only (R-CHROME-5): Day, Schedule, Waiting, To-do, then
//! More; there is no month or hour grid. To-do is the Inbox and the projects
//! ([`place`]); it reads tasks and no event, and has no day bar. Search is the
//! bar under the title (R-CHROME-2), opened by `SearchOpened`, and the More
//! sheet's rows are computed here ([`chrome::more_rows`]) so both platforms draw
//! one list. Opening lands on Day, anchored on the `today` the core answers,
//! never on a device-clock guess.
//!
//! ## What reads and what re-folds
//!
//! A read is a WINDOW: the anchor and the place's span (a day, or
//! [`held::LIST_DAYS`]). Everything else is local and re-folds the held answers:
//! hiding a calendar, Schedule to Waiting (one window), closing search. A
//! search term reads the search alone while the window is held. A change event
//! or a pull clears every held answer and reads again. Loads and writes are
//! synchronous, so a gesture that writes reads again before the view is drawn.
//!
//! ## Rows open pages by their own route
//!
//! An event row, a task row, a project row or container, the Plus on the add
//! sheet, the Overdue verb and the absence notice carry the [`wire::Route`] to
//! push; this screen never sees the tap.

mod chrome;
mod fold;
mod held;
mod place;
mod search;

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Sheet;
use wire::screen_event::Kind as E;

use self::held::Held;
use super::calendar::CalendarFollow;
use super::routes;
use super::todo::ops::Ops;
use super::todo::rows;
use crate::catalog::act;
use crate::kit::civil;
use crate::screen::{Ctx, Screen};
use crate::strings::{agenda as words, agenda_home as sentences, fill, task};

/// Where a read stands.
pub(super) enum Phase {
    Loading,
    Failed,
    /// The vault would not let Agenda read: the kit's gate.
    Denied(wire::AppQueryDenial),
    Ready,
}

/// The quick-add bar: a bare title that lands in the Inbox.
#[derive(Default)]
struct QuickAdd {
    title: String,
    /// The bar is drawn: the Plus (or Notes' "Send to Agenda") opened it.
    drawn: bool,
    focused: bool,
}

pub(super) struct Home {
    phase: Phase,
    destination: Dest,
    /// The day the surface is anchored on; EMPTY until an answer names today.
    anchor: String,
    /// The day the core last named as today.
    today: String,
    search_open: bool,
    search_term: String,
    /// Calendars switched off, for the session.
    hidden: Vec<String>,
    sheet: Sheet,
    filing_task_id: String,
    new_project_name: String,
    quick: QuickAdd,
    /// To-do's window, widened by "Show more".
    limit: u32,
    ops: Ops,
    held: Held,
    /// The phone's calendar, imported and followed for as long as Agenda is up.
    calendar: CalendarFollow,
}

/// The registry factory.
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
        // SEEDED WORDS (Notes' "Send to Agenda") wait in To-do's bar, focused,
        // and they name To-do as the place.
        let seed = args.quick_add_title.trim().to_owned();
        let named = Dest::try_from(args.destination).unwrap_or(Dest::Unspecified);
        let destination = match named {
            Dest::Unspecified if !seed.is_empty() => Dest::Todo,
            Dest::Unspecified => Dest::Day,
            other => other,
        };
        Self {
            phase: Phase::Loading,
            destination,
            anchor: String::new(),
            today: String::new(),
            search_open: false,
            search_term: String::new(),
            hidden: Vec::new(),
            sheet: Sheet::None,
            filing_task_id: String::new(),
            new_project_name: String::new(),
            quick: QuickAdd {
                drawn: !seed.is_empty(),
                focused: !seed.is_empty(),
                title: seed,
            },
            limit: rows::PAGE,
            ops: Ops::default(),
            held: Held::default(),
            calendar: CalendarFollow::new(),
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

    /// A place, by the band or by the shell. Picking one LEAVES SEARCH, even the
    /// lit tab: a destination picked is the member choosing the list over the
    /// hits.
    fn move_to(&mut self, destination: Dest, ctx: &Ctx) {
        if destination == Dest::Unspecified {
            return;
        }
        self.shut_quick_add();
        self.close_search();
        self.destination = destination;
        self.sheet = Sheet::None;
        self.read(ctx);
    }

    fn close_search(&mut self) {
        self.search_open = false;
        self.search_term.clear();
        self.held.search = None;
        self.held.search_term = None;
    }

    /// The quick-add bar put away, its words with it: another place, or search.
    fn shut_quick_add(&mut self) {
        self.quick = QuickAdd::default();
    }

    fn toggle_calendar(&mut self, id: &str) {
        if let Some(at) = self.hidden.iter().position(|hidden| hidden == id) {
            self.hidden.remove(at);
        } else {
            self.hidden.push(id.to_owned());
        }
    }

    fn on_event(&mut self, event: H, ctx: &Ctx) {
        match event {
            H::Refreshed(_) => self.refresh(ctx),
            // Taken before this match: it returns the shell's effects.
            H::ImportRequested(_) => {}
            H::Destination(moved) => {
                let destination = Dest::try_from(moved.destination).unwrap_or(Dest::Unspecified);
                self.move_to(destination, ctx);
            }
            H::Band(picked) => match picked.key.as_str() {
                chrome::BAND_DAY => self.move_to(Dest::Day, ctx),
                chrome::BAND_SCHEDULE => self.move_to(Dest::Schedule, ctx),
                chrome::BAND_WAITING => self.move_to(Dest::Waiting, ctx),
                chrome::BAND_TODO => self.move_to(Dest::Todo, ctx),
                chrome::BAND_MORE => self.sheet = Sheet::More,
                _ => {}
            },
            // TO-DO HAS NO DAY: the bar is not drawn, and a stray step is nothing.
            H::DayStepped(_) | H::Today(_) if self.destination == Dest::Todo => {}
            H::DayStepped(step) => {
                if self.anchor.is_empty() || step.days == 0 {
                    return;
                }
                if let Some(moved) = civil::plus_days(&self.anchor, i64::from(step.days)) {
                    self.anchor = moved;
                    self.read(ctx);
                }
            }
            H::Today(_) => {
                let today = self.held.today();
                if !today.is_empty() && today != self.anchor {
                    self.anchor = today;
                    self.read(ctx);
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
                    // NO TERM, NO SEARCH: the window's own list, re-folded.
                    self.held.search = None;
                    self.held.search_term = None;
                }
                self.read(ctx);
            }
            H::SearchClosed(_) => {
                self.close_search();
                self.read(ctx);
            }
            H::CalendarToggled(toggled) => self.toggle_calendar(&toggled.calendar_id),
            H::MoreRow(picked) => self.more_row(&picked.key, ctx),
            H::SheetOpened(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                if sheet != Sheet::Unspecified {
                    self.sheet = sheet;
                }
            }
            H::SheetClosed(_) => {
                self.sheet = Sheet::None;
                self.filing_task_id.clear();
                self.new_project_name.clear();
            }
            H::TaskChecked(checked) => {
                if let Some(found) = self.held.find(&checked.task_id) {
                    self.ops.check(ctx, &found);
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
            H::QuickAddSubmitted(_) => self.add(ctx),
            // THE PLUS OPENS THE BAR on the keyboard (R-CHROME-1), on To-do only.
            H::QuickAddOpened(_) => {
                if self.destination == Dest::Todo {
                    self.quick.drawn = true;
                    self.quick.focused = true;
                }
            }
            // THE KEYBOARD LEFT IT: an empty bar goes away; typed words keep it
            // open, so nothing the member wrote is thrown away.
            H::QuickAddClosed(_) => {
                if self.quick.title.trim().is_empty() {
                    self.shut_quick_add();
                }
            }
            H::NewProjectName(typed) => self.new_project_name = typed.name,
            H::NewProjectSubmitted(_) => self.create_project(ctx),
            // THE EMPTY TO-DO'S ONE ACTION is the new-project sheet.
            H::TodoEmptyActed(_) => {
                let acts = self.destination == Dest::Todo
                    && self
                        .data(ctx)
                        .and_then(|data| data.todo)
                        .and_then(|todo| todo.empty)
                        .is_some_and(|empty| !empty.action_label.is_empty());
                if acts {
                    self.sheet = Sheet::NewProject;
                }
            }
            H::NextPage(_) => {
                if self.limit < rows::MAX_WINDOW {
                    self.limit = (self.limit + rows::PAGE).min(rows::MAX_WINDOW);
                    self.held.todo = false;
                    self.read(ctx);
                }
            }
        }
    }

    /// A More row, by its key. A key the sheet does not hold now (a calendar
    /// gone since it was drawn) does nothing.
    fn more_row(&mut self, key: &str, ctx: &Ctx) {
        let rows = self.more_rows(ctx);
        let Some(row) = rows.iter().find(|row| row.key == key) else {
            return;
        };
        if row.key == chrome::MORE_READS {
            self.sheet = Sheet::Reads;
        } else if let Some(id) = row.key.strip_prefix(chrome::MORE_CALENDAR) {
            let id = id.to_owned();
            self.toggle_calendar(&id);
        } else if chrome::TASK_PLACES.contains(&row.key.as_str()) {
            // A TASKS PLACE IS A PAGE: the sheet closes, and the shell pushes the row's route.
            self.sheet = Sheet::None;
        }
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

    /// To-do's quick add: a bare title, landing in the Inbox. The bar keeps its
    /// words when the vault refuses.
    fn add(&mut self, ctx: &Ctx) {
        let title = self.quick.title.trim().to_owned();
        if title.is_empty() || self.denied() || self.destination != Dest::Todo {
            return;
        }
        let inbox = task::inbox(ctx.locale());
        if self.ops.add(ctx, &title, "", &inbox, None, None) {
            self.quick.title.clear();
        }
        self.refresh(ctx);
    }

    fn create_project(&mut self, ctx: &Ctx) {
        let name = self.new_project_name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        let request = act::agenda::CreateProject {
            kind: act::agenda::CreateProjectKind::Project,
            title: name.clone(),
            ..Default::default()
        };
        self.ops
            .created(ctx, request, &name, task::project_created(ctx.locale()));
        self.sheet = Sheet::None;
        self.new_project_name.clear();
        self.refresh(ctx);
    }

    /// The data the held answers draw, or `None` when they are not for this state.
    fn data(&self, ctx: &Ctx) -> Option<wire::AgendaHomeData> {
        let locale = ctx.locale();
        if self.destination == Dest::Todo && self.active_term().is_none() {
            return place::fold(locale, &self.held, self.limit);
        }
        let term = self.active_term();
        fold::events(&fold::Fold {
            locale,
            destination: self.destination,
            anchor: &self.anchor,
            term: term.as_deref(),
            hidden: &self.hidden,
            held: &self.held,
        })
    }

    fn more_rows(&self, ctx: &Ctx) -> Vec<wire::AgendaMoreRow> {
        if self.denied() {
            return Vec::new();
        }
        let calendars = self
            .data(ctx)
            .map(|data| data.calendars)
            .unwrap_or_default();
        chrome::more_rows(ctx.locale(), &calendars)
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.refresh(ctx);
                return self.calendar.attach();
            }
            Some(E::EnvironmentChanged(_) | E::DataChanged(_)) => self.refresh(ctx),
            Some(E::AgendaHome(home)) => match home.kind {
                Some(H::ImportRequested(_)) => return self.calendar.import(ctx),
                Some(kind) => self.on_event(kind, ctx),
                None => {}
            },
            Some(other) => {
                if let Some(effects) = self.calendar.on_event(&other, ctx) {
                    return effects;
                }
            }
            None => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let todo = self.destination == Dest::Todo;
        let denied = self.denied();
        let data = match self.phase {
            Phase::Ready => self.data(ctx),
            _ => None,
        };
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
                .map(|search| {
                    let events = search.corrected.as_str();
                    let tasks = search
                        .tasks
                        .as_ref()
                        .map_or("", |tasks| tasks.corrected.as_str());
                    if events.is_empty() { tasks } else { events }
                })
                .filter(|words| !words.is_empty())
                .map(|words| crate::kit::search::corrected(locale, words))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let sheet_up = matches!(self.sheet, Sheet::More | Sheet::Reads);
        let today = data
            .as_ref()
            .map(|data| data.today.clone())
            .unwrap_or_else(|| self.held.today());
        let drawn = self.quick.drawn;
        let new_event = (!denied).then(|| {
            routes::editor(
                "",
                "",
                None,
                &self.anchor,
                wire::AgendaEditorKind::Unspecified,
            )
        });
        wire::ViewState {
            kind: Some(wire::view_state::Kind::AgendaHome(Box::new(
                wire::AgendaHomeState {
                    destination: self.destination as i32,
                    anchor_day: self.anchor.clone(),
                    search_open: self.search_open,
                    search_term: self.search_term.clone(),
                    hidden_calendar_ids: self.hidden.clone(),
                    sheet: self.sheet as i32,
                    band: if denied {
                        Vec::new()
                    } else {
                        chrome::band(locale, self.destination, sheet_up)
                    },
                    toolbar: Some(chrome::toolbar(
                        locale,
                        self.destination,
                        &self.anchor,
                        &today,
                        !denied && term.is_none(),
                    )),
                    chrome: Some(chrome::words_of(locale)),
                    more_rows: if denied {
                        Vec::new()
                    } else {
                        chrome::more_rows(
                            locale,
                            data.as_ref()
                                .map_or(&[][..], |data| data.calendars.as_slice()),
                        )
                    },
                    search_corrected: corrected,
                    // THE ASK ROW: for the answer to the term on screen, matched or not.
                    search_ask_row: (held_search && data.is_some()).then(|| {
                        crate::kit::search::offer(
                            locale,
                            term.as_deref().unwrap_or_default(),
                            "agenda",
                        )
                    }),
                    status: self
                        .calendar
                        .status()
                        .cloned()
                        .or_else(|| self.ops.status.clone()),
                    quick_add: Some(wire::TodoQuickAdd {
                        title: self.quick.title.clone(),
                        can_submit: !self.quick.title.trim().is_empty(),
                        lands_label: fill(
                            &sentences::lands_in(locale),
                            &[("place", &task::inbox(locale))],
                        ),
                        // Hidden while search is open, term or not: the bar and its
                        // Plus would be a second verb over a field that is looking.
                        shown: todo && !denied && data.is_some() && !self.search_open,
                        focused: drawn && self.quick.focused,
                        add_label: task::add_task(locale),
                        drawn,
                    }),
                    file_choices: if self.sheet == Sheet::File {
                        place::file_choices(locale, &self.held, &self.filing_task_id)
                    } else {
                        Vec::new()
                    },
                    new_project_name: self.new_project_name.clone(),
                    new_project_can_submit: !self.new_project_name.trim().is_empty(),
                    // "Add", not "New event": on Day, Schedule and Waiting the Plus
                    // opens the sheet that adds an event or a task (R-1128-Z1).
                    add_label: if todo {
                        task::add_task(locale)
                    } else {
                        words::quick_add(locale)
                    },
                    add_opens_quick_add: todo,
                    new_event,
                    content,
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}
