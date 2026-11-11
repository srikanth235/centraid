//! THE HOME OF CALENDAR (#1046, split from Agenda in round 10 of #1173): Day, Week, Month, List, Year
//! and Invites, with Search and the Calendars sheet.
//!
//! The band holds places only (R-CHROME-5): Calendar, Calendars and Invites. The views are Day, Week,
//! Month, Schedule and Year behind its view menu; Day and Week draw an hour grid, Month and Year
//! their cells, all laid out here ([`grid`]) and only drawn by a shell. Search is the bar under the
//! title (R-CHROME-2), opened by `SearchOpened`. Opening lands on Day, anchored on the `today` the
//! core answers, never on a device-clock guess.
//!
//! ## What reads and what re-folds
//!
//! A read is a WINDOW: the anchor and the place's span (a day, or [`held::LIST_DAYS`]). Everything
//! else is local and re-folds the held answers: hiding a calendar, Schedule to Waiting, closing
//! search. A search term reads the search alone while the window is held. A change event or a pull
//! clears every held answer and reads again.
//!
//! ## Rows open pages by their own route
//!
//! An event row and a reminder row carry the [`wire::Route`] to push (a reminder's is Reminders' own);
//! this screen never sees the tap.

mod chrome;
mod drag;
mod fold;
mod grid;
mod held;

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Sheet;
use wire::screen_event::Kind as E;

use self::held::Held;
use super::follow::CalendarFollow;
use super::routes;
use crate::follow::Store;
use crate::kit::civil;
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::phase::Phase;
use crate::kit::schedule::style::{Draft, Subject};
use crate::screen::{Ctx, Screen};
use crate::strings::{
    agenda as words, agenda_calendar as calendar_words, agenda_reminders as reminders, shared,
};

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
    /// The Month's style, Grid until the view menu says otherwise.
    month_style: wire::AgendaMonthStyle,
    /// The Calendar view last used: where the band's Calendar tab returns to.
    last_calendar: Dest,
    sheet: Sheet,
    /// Whether the More sheet is the band's menu (Trash) and not the Calendars sheet.
    menu: bool,
    /// The style sheet's draft: the new calendar or the calendar being edited.
    style: Option<Draft>,
    /// The status line of a write here (a calendar made, an event moved) and its Undo.
    ops: Ops,
    held: Held,
    /// The phone's calendar, imported here; the coordinator follows it (`crate::follow`).
    calendar: CalendarFollow,
    /// The stop-reading confirm is up (#1185).
    asking_stop: bool,
}

/// The registry factory for Calendar's home.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let args = match &route.args {
        Some(wire::route::Args::AgendaHome(args)) => args.clone(),
        _ => wire::AgendaHomeRoute::default(),
    };
    Some(Box::new(Home::new(&args)))
}

/// Whether Calendar has this place: every calendar view and Invites. A place it does not have is
/// never moved to.
const fn allows(destination: Dest) -> bool {
    !matches!(destination, Dest::Todo | Dest::Unspecified)
}

impl Home {
    fn new(args: &wire::AgendaHomeRoute) -> Self {
        let named = Dest::try_from(args.destination).unwrap_or(Dest::Unspecified);
        let destination = if allows(named) { named } else { Dest::Day };
        Self {
            phase: Phase::Loading,
            destination,
            anchor: String::new(),
            today: String::new(),
            search_open: false,
            search_term: String::new(),
            hidden: Vec::new(),
            month_style: wire::AgendaMonthStyle::Grid,
            last_calendar: if grid::is_calendar_view(destination) {
                destination
            } else {
                Dest::Day
            },
            sheet: Sheet::None,
            menu: false,
            style: None,
            ops: Ops::default(),
            held: Held::default(),
            calendar: CalendarFollow::new(),
            asking_stop: false,
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
        if !allows(destination) {
            return;
        }
        self.close_search();
        self.destination = destination;
        if grid::is_calendar_view(destination) {
            self.last_calendar = destination;
        }
        self.sheet = Sheet::None;
        self.read(ctx);
    }

    fn close_search(&mut self) {
        self.search_open = false;
        self.search_term.clear();
        self.held.search = None;
        self.held.search_term = None;
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
            H::Refreshed(_) => {
                self.refresh(ctx);
                ctx.follows().changed(ctx, Store::Calendar);
            }
            // Taken before this match: it returns the shell's effects.
            H::ImportRequested(_) => {}
            H::Destination(moved) => {
                let destination = Dest::try_from(moved.destination).unwrap_or(Dest::Unspecified);
                self.move_to(destination, ctx);
            }
            H::Band(picked) => match picked.key.as_str() {
                // The Calendar tab lands on the view the member last used.
                chrome::BAND_CALENDAR => self.move_to(self.last_calendar, ctx),
                chrome::BAND_INVITES => self.move_to(Dest::Waiting, ctx),
                chrome::BAND_MORE => {
                    self.sheet = Sheet::More;
                    self.menu = false;
                }
                chrome::BAND_MENU => {
                    self.sheet = Sheet::More;
                    self.menu = true;
                }
                _ => {}
            },
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
                self.search_open = true;
                self.sheet = Sheet::None;
            }
            H::SearchTerm(typed) => {
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
            H::StopDismissed(_) => self.asking_stop = false,
            // Taken in `update`: it returns the shell's effects.
            H::StopConfirmed(_) => {}
            H::SheetOpened(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                if sheet != Sheet::Unspecified {
                    self.open_sheet(sheet);
                }
            }
            H::SheetClosed(_) => {
                // A calendar's style sheet was opened from the Calendars sheet: closing returns there.
                self.sheet = if matches!(self.sheet, Sheet::NewCalendar | Sheet::EditCalendar) {
                    Sheet::More
                } else {
                    Sheet::None
                };
                self.style = None;
                self.menu = false;
            }
            // THE TICK ON A REMINDER'S DAY (round 12): Reminders' own `complete-task` or
            // `reopen-task`, sent by the kit's check. A later occurrence of a repeating reminder
            // has no row to tick, so it is never found here.
            H::TaskChecked(checked) => {
                if let Some(found) = self.held.find_reminder(&checked.task_id) {
                    self.ops.check(ctx, &found);
                    self.refresh(ctx);
                }
            }
            H::StatusActed(_) => {
                self.ops.undo(ctx);
                self.refresh(ctx);
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
            H::CalendarEdit(asked) => self.edit_calendar(&asked.calendar_id, ctx),
            // A STRIP DAY, A MONTH CELL OR A YEAR'S MONTH: the anchor moves to the
            // day and the view to the cell's `opens`. A day that is not one is
            // nothing, and no destination keeps the view.
            H::DayPicked(picked) => {
                if civil::epoch_day_of(&picked.day).is_none() {
                    return;
                }
                let opens = Dest::try_from(picked.destination).unwrap_or(Dest::Unspecified);
                self.anchor = picked.day;
                self.move_to(
                    if grid::is_calendar_view(opens) {
                        opens
                    } else {
                        self.destination
                    },
                    ctx,
                );
            }
            // ‹ and › and a swipe: one day, week, month or year.
            H::PeriodStepped(step) => {
                if self.anchor.is_empty() || step.by == 0 {
                    return;
                }
                if let Some(moved) = grid::step(self.destination, &self.anchor, step.by) {
                    self.anchor = moved;
                    self.read(ctx);
                }
            }
            // THE CALENDAR'S HEADER (#1173). The chip goes back to the month the anchor is in.
            H::MonthChip(_) => {
                if chrome::has_calendar_header(self.destination) && !self.anchor.is_empty() {
                    self.move_to(Dest::Month, ctx);
                }
            }
            // A layout choice keeps the anchor; only a Calendar view is one.
            H::LayoutToggled(chosen) => {
                let layout = Dest::try_from(chosen.layout).unwrap_or(Dest::Unspecified);
                if grid::is_calendar_view(layout) && layout != self.destination {
                    self.move_to(layout, ctx);
                }
            }
            // A swipe on the strip or the Week grid: whole weeks, the weekday kept.
            H::WeekPaged(paged) => {
                if self.anchor.is_empty() || paged.weeks == 0 {
                    return;
                }
                if let Some(moved) = civil::plus_days(&self.anchor, 7 * i64::from(paged.weeks)) {
                    self.anchor = moved;
                    self.read(ctx);
                }
            }
            H::MonthStyle(chosen) => match wire::AgendaMonthStyle::try_from(chosen.style) {
                Ok(style) if style != wire::AgendaMonthStyle::Unspecified => {
                    self.month_style = style;
                }
                _ => {}
            },
            H::EventMoved(moved) => self.move_event(ctx, &moved),
            H::EventResized(resized) => self.resize_event(ctx, &resized),
            // TAKEN IN `update`: the press returns the shell's effect.
            H::SlotPressed(_) => {}
            // Reminders' gestures (filing, the quick add, the lists): a home Calendar does not have.
            _ => {}
        }
    }

    /// STOP READING, once the member said so: the status line says what happened, and Calendar
    /// goes on showing the events it already holds (they are ordinary ones now).
    fn stop(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        if !std::mem::take(&mut self.asking_stop) {
            return Vec::new();
        }
        let effects = match self.calendar.stop(ctx) {
            Some(effects) => {
                self.ops.say(calendar_words::calendars_stopped(locale));
                effects
            }
            None => {
                self.ops.line.refuse(shared::write_refused(locale));
                Vec::new()
            }
        };
        self.refresh(ctx);
        effects
    }

    /// A Calendars sheet row, by its key. A key the sheet does not hold now (a calendar
    /// gone since it was drawn) does nothing.
    fn more_row(&mut self, key: &str, ctx: &Ctx) {
        // THE ONE MENU ROW WITH NO ROUTE: it asks before it stops.
        if self.menu && key == chrome::MORE_STOP {
            if self.calendar.can_stop(ctx) {
                self.asking_stop = true;
                self.sheet = Sheet::None;
                self.menu = false;
            }
            return;
        }
        // THE MENU'S ROW is a route the shell pushes: the sheet is done.
        if self.menu && key == chrome::MORE_TRASH {
            self.sheet = Sheet::None;
            self.menu = false;
            return;
        }
        let rows = self.more_rows(ctx);
        let Some(row) = rows.iter().find(|row| row.key == key) else {
            return;
        };
        if row.key == chrome::MORE_READS {
            self.sheet = Sheet::Reads;
        } else if row.key == chrome::MORE_NEW_CALENDAR {
            self.open_sheet(Sheet::NewCalendar);
        } else if let Some(id) = row.key.strip_prefix(chrome::MORE_CALENDAR) {
            let id = id.to_owned();
            self.toggle_calendar(&id);
        }
    }

    /// A sheet up, with the draft it names: a new calendar starts blank. A calendar edit has its
    /// own entry ([`Self::edit_calendar`]).
    fn open_sheet(&mut self, sheet: Sheet) {
        self.menu = false;
        match sheet {
            Sheet::NewCalendar => {
                self.style = Some(Draft::making(Subject::Calendar));
            }
            // Reminders' sheets, and the edit, open by their own events.
            Sheet::NewProject | Sheet::File | Sheet::ImportReminders | Sheet::EditCalendar => {
                return;
            }
            _ => {}
        }
        self.sheet = sheet;
    }

    fn style_name(&mut self, name: String) {
        self.style
            .get_or_insert_with(|| Draft::making(Subject::Calendar))
            .set_name(name);
    }

    /// A calendar's edit control: its name, colour and icon, from the row on screen.
    fn edit_calendar(&mut self, id: &str, ctx: &Ctx) {
        let Some(calendar) = self.data(ctx).and_then(|data| {
            data.calendars
                .into_iter()
                .find(|calendar| calendar.calendar_id == id)
        }) else {
            return;
        };
        self.style = Some(Draft::editing(
            Subject::Calendar,
            id,
            &calendar.name,
            Some(&calendar.color_key),
            Some(&calendar.icon_key)
                .filter(|key| !key.is_empty())
                .map(String::as_str),
        ));
        self.sheet = Sheet::EditCalendar;
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
        let term = self.active_term();
        fold::events(&fold::Fold {
            locale: ctx.locale(),
            cycle: ctx.hour_cycle(),
            destination: self.destination,
            anchor: &self.anchor,
            term: term.as_deref(),
            hidden: &self.hidden,
            held: &self.held,
            week_start: grid::week_start_of(ctx.region()),
            month_style: self.month_style,
        })
    }

    fn more_rows(&self, ctx: &Ctx) -> Vec<wire::AgendaMoreRow> {
        if self.denied() {
            return Vec::new();
        }
        if self.menu {
            return chrome::menu_rows(ctx.locale(), self.calendar.can_stop(ctx));
        }
        let calendars = self
            .data(ctx)
            .map(|data| data.calendars)
            .unwrap_or_default();
        chrome::more_rows(ctx.locale(), &calendars, true)
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.refresh(ctx);
                ctx.follows().changed(ctx, Store::Calendar);
                // THE CALENDAR'S FLAG IS A KEYCHAIN READ and an answer carries no key, so the
                // choice is read after it has landed, never beside it.
                return self.calendar.attach();
            }
            Some(E::EnvironmentChanged(_) | E::DataChanged(_)) => {
                self.refresh(ctx);
                // A PAGE ABOVE CLOSED (the event editor, a cancelled event): its line is drawn here.
                self.ops.line.take_handed(ctx);
            }
            // THE KIT'S ONE STATUS VERB, beside the home's own (`H::StatusActed`).
            Some(E::StatusActed(_)) => {
                self.ops.undo(ctx);
                self.refresh(ctx);
            }
            Some(E::AgendaHome(home)) => match home.kind {
                Some(H::ImportRequested(_)) => return self.calendar.import(ctx),
                Some(H::StopConfirmed(_)) => return self.stop(ctx),
                // A LONG PRESS ON AN EMPTY SLOT writes nothing: it opens the add
                // sheet at the snapped time.
                Some(H::SlotPressed(pressed)) => {
                    return drag::slot(&pressed.day, pressed.minute)
                        .map(|route| {
                            vec![wire::Effect {
                                kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                                    route: Some(route),
                                })),
                            }]
                        })
                        .unwrap_or_default();
                }
                Some(kind) => self.on_event(kind, ctx),
                None => {}
            },
            Some(E::EffectResult(result)) => {
                return self
                    .calendar
                    .on_event(&E::EffectResult(result), ctx)
                    .unwrap_or_default();
            }
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
        let denied = self.denied();
        let mut data = match self.phase {
            Phase::Ready => self.data(ctx),
            _ => None,
        };
        let searching = self.active_term().is_some();
        let today_now = data
            .as_ref()
            .map(|data| data.today.clone())
            .unwrap_or_else(|| self.held.today());
        // THE HEADER TAKES DAY'S ALL-DAY LANE out of the answer, so it is drawn once.
        let calendar_header = chrome::calendar_header(
            locale,
            self.destination,
            &self.anchor,
            &today_now,
            !denied && !searching,
            data.as_mut(),
        );
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
                .map(|search| search.corrected.as_str())
                .filter(|words| !words.is_empty())
                .map(|words| crate::kit::search::corrected(locale, words))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let menu_up = self.menu && self.sheet == Sheet::More;
        let sheet_up = matches!(self.sheet, Sheet::More | Sheet::Reads) && !menu_up;
        let today = data
            .as_ref()
            .map(|data| data.today.clone())
            .unwrap_or_else(|| self.held.today());
        let new_event = (!denied).then(|| routes::editor("", "", None, &self.anchor));
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
                        chrome::band(locale, self.destination, sheet_up, menu_up)
                    },
                    calendar_header: Some(calendar_header),
                    filter_menu: None,
                    calendar_views: if denied || chrome::has_calendar_header(self.destination) {
                        Vec::new()
                    } else {
                        chrome::calendar_views(locale, self.destination)
                    },
                    calendar_view_label: reminders::view_menu(locale),
                    toolbar: Some(chrome::toolbar(
                        locale,
                        self.destination,
                        &self.anchor,
                        &today,
                        !denied && term.is_none(),
                    )),
                    chrome: Some(wire::AgendaChrome {
                        // The menu sheet is titled for the app, the Calendars sheet for its list.
                        more_title: if menu_up {
                            words::app_title(locale)
                        } else {
                            chrome::words_of(locale).more_title
                        },
                        ..chrome::words_of(locale)
                    }),
                    app_key: "calendar".to_owned(),
                    more_rows: if denied {
                        Vec::new()
                    } else if menu_up {
                        chrome::menu_rows(locale, self.calendar.can_stop(ctx))
                    } else {
                        chrome::more_rows(
                            locale,
                            data.as_ref()
                                .map_or(&[][..], |data| data.calendars.as_slice()),
                            data.is_some(),
                        )
                    },
                    search_corrected: corrected,
                    // THE ASK ROW: for the answer to the term on screen, matched or not.
                    search_ask_row: (held_search && data.is_some()).then(|| {
                        crate::kit::search::offer(
                            locale,
                            term.as_deref().unwrap_or_default(),
                            "calendar",
                        )
                    }),
                    status: self
                        .calendar
                        .status()
                        .cloned()
                        .or_else(|| self.ops.status())
                        .or_else(|| {
                            ctx.follows()
                                .report(Store::Calendar)
                                .status(ctx, Store::Calendar)
                        }),
                    // THE STOP CONFIRM (#1185): the kit's sheet, in the shared words.
                    stop: (self.asking_stop && !denied).then(|| {
                        crate::kit::follow::stop_confirm(
                            locale,
                            &words::app_title(locale),
                            &chrome::stop_store(locale),
                            &calendar_words::calendars_kept(locale),
                        )
                    }),
                    quick_add: Some(wire::TodoQuickAdd::default()),
                    file_choices: Vec::new(),
                    style: self
                        .style
                        .as_ref()
                        .filter(|_| matches!(self.sheet, Sheet::NewCalendar | Sheet::EditCalendar))
                        .map(|draft| Box::new(draft.sheet(locale))),
                    import_reminders: None,
                    // Calendar's Plus adds an event only.
                    add_label: words::new_event(locale),
                    add_opens_quick_add: false,
                    new_event,
                    content,
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}
