//! Calendar and Reminders share one Agenda, with Invites and More in its band.
//! Calendar owns day/week hour grids, month/year cells and the schedule list.
//! Rust builds the civil dates, routes, selection, filters and mutation intents;
//! native shells lay out the supplied state and report gestures.

mod chrome;
mod fold;
mod grid;
mod held;
mod place;
mod search;

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Sheet;
use wire::screen_event::Kind as E;

use self::held::Held;
use super::appearance::{Appearance, CalendarEditor};
use super::calendar::CalendarFollow;
use super::routes;
use super::todo::ops::Ops;
use super::todo::rows;
use crate::catalog::act;
use crate::field::Field;
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
    due: Option<String>,
    flagged: bool,
    /// The bar is drawn: the Plus (or Notes' "Send to Agenda") opened it.
    drawn: bool,
    focused: bool,
}

pub(super) struct Home {
    phase: Phase,
    destination: Dest,
    calendar_view: String,
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
    new_project_style: Appearance,
    calendar_editor: Option<CalendarEditor>,
    include_completed_import: bool,
    quick: QuickAdd,
    /// To-do's window, widened by "Show more".
    limit: u32,
    ops: Ops,
    held: Held,
    /// The phone's calendar, imported and followed for as long as Agenda is up.
    calendar: CalendarFollow,
    notification_status: super::notification_status::Status,
    reminder_import_pending: Option<bool>,
    import_status: Option<wire::StatusLine>,
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
            calendar_view: if destination == Dest::Schedule {
                "list"
            } else {
                "day"
            }
            .to_owned(),
            anchor: String::new(),
            today: String::new(),
            search_open: false,
            search_term: String::new(),
            hidden: Vec::new(),
            sheet: Sheet::None,
            filing_task_id: String::new(),
            new_project_name: String::new(),
            new_project_style: Appearance::default(),
            calendar_editor: None,
            include_completed_import: false,
            quick: QuickAdd {
                drawn: !seed.is_empty(),
                focused: !seed.is_empty(),
                title: seed,
                ..Default::default()
            },
            limit: rows::PAGE,
            ops: Ops::default(),
            held: Held::default(),
            calendar: CalendarFollow::new(),
            notification_status: super::notification_status::Status::default(),
            reminder_import_pending: None,
            import_status: None,
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
        if destination == Dest::Schedule {
            self.calendar_view = "list".into();
        }
        if destination == Dest::Day && self.calendar_view == "list" {
            self.calendar_view = "day".into();
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
            H::EventAdjusted(adjustment) => self.adjust_event(ctx, &adjustment),
            H::CalendarView(picked) => {
                if grid::VIEWS.contains(&picked.key.as_str()) && !self.denied() {
                    self.calendar_view = picked.key;
                    let destination = if self.calendar_view == "list" {
                        Dest::Schedule
                    } else {
                        Dest::Day
                    };
                    self.move_to(destination, ctx);
                }
            }
            H::CalendarDay(picked) => {
                if civil::epoch_day_of(&picked.day).is_some() && !self.denied() {
                    self.anchor = picked.day;
                    if self.calendar_view == "year" {
                        self.calendar_view = "month".to_owned();
                    }
                    self.read(ctx);
                }
            }
            // Taken before this match: it returns the shell's effects.
            H::ImportRequested(_) => {}
            H::Destination(moved) => {
                let destination = Dest::try_from(moved.destination).unwrap_or(Dest::Unspecified);
                self.move_to(destination, ctx);
            }
            H::Band(picked) => match picked.key.as_str() {
                chrome::BAND_DAY => self.move_to(
                    if self.calendar_view == "list" {
                        Dest::Schedule
                    } else {
                        Dest::Day
                    },
                    ctx,
                ),
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
            H::TaskAction(action) => {
                if let Some(task) = self.held.find(&action.task_id) {
                    self.ops.row_action(ctx, &task, &action);
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
            H::QuickAddTool(tool) => {
                crate::agenda::todo::quick::pick(
                    &tool.key,
                    &self.held.today(),
                    &mut self.quick.due,
                    &mut self.quick.flagged,
                );
            }
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
            H::ContainerForm(changed) => self.change_container(ctx, &changed.field, &changed.value),
            H::ContainerSaved(_) => self.save_calendar(ctx),
            H::ImportOptions(changed) => self.include_completed_import = changed.include_completed,
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

    fn adjust_event(&mut self, ctx: &Ctx, adjustment: &wire::agenda_home_event::EventAdjusted) {
        use crate::catalog::act::agenda as action;
        use crate::field::Field;
        let Some(event) = self
            .held
            .upcoming
            .as_ref()
            .and_then(|upcoming| {
                upcoming
                    .events
                    .iter()
                    .find(|event| event.instance_key == adjustment.instance_key)
            })
            .cloned()
        else {
            return;
        };
        if event.all_day
            || adjustment.delta_minutes == 0
            || adjustment.delta_minutes.unsigned_abs() > 10080
        {
            return;
        }
        let Some((starts, ends)) = grid::adjusted_times(
            &event,
            ctx.zone(),
            adjustment.delta_minutes,
            adjustment.resize,
        ) else {
            return;
        };
        let event_zone = event.start_tz.as_deref().unwrap_or(ctx.zone());
        let (Some(starts), Some(ends)) = (
            grid::in_event_zone(&starts, ctx.zone(), event_zone),
            grid::in_event_zone(&ends, ctx.zone(), event_zone),
        ) else {
            return;
        };
        let request: wire::ActRequest = if let Some(original) = &event.original_start_local {
            action::EditOccurrence {
                event_id: event.event_id.clone(),
                original_start: original.clone(),
                scope: action::EditOccurrenceScope::Occurrence,
                action: action::EditOccurrenceAction::Override,
                starts: Some(starts),
                ends: Field::Is(ends),
                zone: Field::Is(event_zone.to_owned()),
                ..Default::default()
            }
            .into()
        } else {
            action::EditEvent {
                event_id: event.event_id.clone(),
                starts: Some(starts),
                ends: Field::Is(ends),
                zone: Field::Is(event_zone.to_owned()),
                ..Default::default()
            }
            .into()
        };
        self.ops.created(
            ctx,
            request,
            &event.instance_key,
            if adjustment.resize {
                words::resized(ctx.locale())
            } else {
                words::moved(ctx.locale())
            },
        );
        self.refresh(ctx);
    }

    /// A More row, by its key. A key the sheet does not hold now (a calendar
    /// gone since it was drawn) does nothing.
    fn more_row(&mut self, key: &str, ctx: &Ctx) {
        let rows = self.more_rows(ctx);
        let Some(row) = rows
            .iter()
            .find(|row| row.key == key || row.edit_key == key)
        else {
            return;
        };
        if key == chrome::MORE_NEW_CALENDAR {
            self.calendar_editor = Some(CalendarEditor {
                appearance: Appearance {
                    icon: "Calendar".to_owned(),
                    ..Default::default()
                },
                ..Default::default()
            });
            self.sheet = Sheet::CalendarEditor;
        } else if let Some(id) = key.strip_prefix(chrome::MORE_EDIT_CALENDAR) {
            if let Some(calendar) = self.held.upcoming.as_ref().and_then(|upcoming| {
                upcoming
                    .calendars
                    .iter()
                    .find(|calendar| calendar.calendar_id == id)
            }) {
                self.calendar_editor = Some(CalendarEditor {
                    id: id.to_owned(),
                    name: calendar.name.clone().unwrap_or_default(),
                    appearance: Appearance::of(id, calendar.color.as_deref(), &calendar.icon_key),
                });
                self.sheet = Sheet::CalendarEditor;
            }
        } else if key == chrome::MORE_IMPORT {
            self.sheet = Sheet::Imports;
        } else if row.key == chrome::MORE_READS {
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
        if self.ops.add_quick(
            ctx,
            &title,
            &self.held.today(),
            &inbox,
            crate::agenda::todo::quick::Options {
                due: self.quick.due.as_deref(),
                flagged: self.quick.flagged,
                ..Default::default()
            },
        ) {
            self.quick.title.clear();
            self.quick.flagged = false;
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
            color: Field::Is(self.new_project_style.color.clone()),
            icon_key: Field::Is(self.new_project_style.icon.clone()),
            ..Default::default()
        };
        if !self
            .ops
            .created(ctx, request, &name, task::project_created(ctx.locale()))
        {
            return;
        }
        self.sheet = Sheet::None;
        self.new_project_name.clear();
        self.refresh(ctx);
    }

    fn change_container(&mut self, ctx: &Ctx, field: &str, value: &str) {
        if self.sheet == Sheet::NewProject {
            self.new_project_style.change(field, value);
            return;
        }
        let Some(editor) = &mut self.calendar_editor else {
            return;
        };
        if field == "name" {
            editor.name = value.to_owned();
            return;
        }
        let before = editor.appearance.clone();
        if !editor.appearance.change(field, value) {
            return;
        }
        if editor.id.is_empty() {
            return;
        }
        let request = act::agenda::StyleList {
            list_id: editor.id.clone(),
            color: Field::Is(editor.appearance.color.clone()),
            icon_key: Field::Is(editor.appearance.icon.clone()),
        };
        if !self.ops.created(
            ctx,
            request,
            &editor.id,
            words::appearance_saved(ctx.locale()),
        ) {
            editor.appearance = before;
        }
        self.refresh(ctx);
    }

    fn save_calendar(&mut self, ctx: &Ctx) {
        let Some(editor) = self.calendar_editor.as_ref() else {
            return;
        };
        let name = editor.name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        let request: wire::ActRequest = if editor.id.is_empty() {
            act::agenda::CreateCalendar {
                title: name.clone(),
                color: Field::Is(editor.appearance.color.clone()),
                icon_key: Field::Is(editor.appearance.icon.clone()),
                ..Default::default()
            }
            .into()
        } else {
            act::agenda::RenameList {
                list_id: editor.id.clone(),
                title: name.clone(),
            }
            .into()
        };
        if self
            .ops
            .created(ctx, request, &name, words::calendar_saved(ctx.locale()))
        {
            self.sheet = Sheet::None;
            self.calendar_editor = None;
            self.refresh(ctx);
        }
    }

    fn import_options(&self, ctx: &Ctx) -> wire::AgendaImportOptions {
        let locale = ctx.locale();
        let mut options = vec![wire::AgendaImportOption {
            key: "calendar".to_owned(),
            label: words::import_calendar(locale),
            source: wire::ImportSource::Calendar as i32,
            from_file: false,
        }];
        if ctx.platform() == "ios" {
            options.push(wire::AgendaImportOption {
                key: "reminders".to_owned(),
                label: words::import_reminders(locale),
                source: wire::ImportSource::Reminders as i32,
                from_file: false,
            });
        }
        options.push(wire::AgendaImportOption {
            key: "reminders-file".to_owned(),
            label: words::import_reminders_file(locale),
            source: wire::ImportSource::Reminders as i32,
            from_file: true,
        });
        wire::AgendaImportOptions {
            title: words::import_title(locale),
            include_completed_label: words::import_completed(locale),
            include_completed: self.include_completed_import,
            options,
        }
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
            Some(E::EnvironmentChanged(_)) => {
                self.refresh(ctx);
                self.calendar.request(ctx);
            }
            Some(E::DataChanged(changed)) => {
                self.refresh(ctx);
                if changed.tables.iter().any(|table| {
                    ["event", "entity", "occurrence", "edge", "contact_point"]
                        .contains(&table.as_str())
                }) {
                    self.calendar.request(ctx);
                }
            }
            Some(E::Announced(announced)) => self.notification_status.hear(&announced.topic),
            Some(E::AgendaHome(home)) => match home.kind {
                Some(H::StatusActed(_))
                    if self.import_status.is_none()
                        && self.calendar.status().is_none()
                        && self.ops.status.is_none()
                        && self.notification_status.active() =>
                {
                    return self.notification_status.act(ctx);
                }
                Some(H::ImportRequested(request)) => {
                    self.sheet = Sheet::None;
                    self.import_status = None;
                    if request.source == wire::ImportSource::Reminders as i32 || request.from_file {
                        if self.reminder_import_pending.is_some() {
                            return Vec::new();
                        }
                        self.reminder_import_pending = Some(request.include_completed);
                        let kind = if request.from_file {
                            wire::effect::Kind::PickBytes(wire::PickBytes {
                                accept: vec![
                                    "text/calendar".to_owned(),
                                    ".ics".to_owned(),
                                    ".ical".to_owned(),
                                ],
                            })
                        } else {
                            wire::effect::Kind::RemindersRead(wire::RemindersRead {
                                ask_permission: true,
                                include_completed: request.include_completed,
                            })
                        };
                        return vec![wire::Effect { kind: Some(kind) }];
                    }
                    return self.calendar.import(ctx);
                }
                Some(kind) => self.on_event(kind, ctx),
                None => {}
            },
            Some(other) => {
                if let (Some(include_completed), E::EffectResult(result)) =
                    (self.reminder_import_pending, &other)
                {
                    use wire::effect_result::Outcome as O;
                    let snapshot = match &result.outcome {
                        Some(O::RemindersSnapshot(snapshot)) => Some(Ok(snapshot.clone())),
                        Some(O::BytesPicked(file)) if file.cancelled => {
                            self.reminder_import_pending = None;
                            return Vec::new();
                        }
                        Some(O::BytesPicked(file)) => Some(crate::imports::reminder_file::parse(
                            &file.content,
                            &file.name,
                            include_completed,
                            ctx.zone(),
                        )),
                        Some(O::Failed(_)) => Some(Err("the reminder source could not be read")),
                        _ => None,
                    };
                    if let Some(snapshot) = snapshot {
                        self.reminder_import_pending = None;
                        let (sentence, refused) = match snapshot {
                            Ok(snapshot) => {
                                let outcome =
                                    crate::imports::reminders::run_snapshot(ctx, &snapshot);
                                (
                                    crate::imports::reminders::sentence(ctx.locale(), outcome),
                                    outcome.refused > 0,
                                )
                            }
                            Err(_) => (task::import_reminders_failed(ctx.locale()), true),
                        };
                        self.import_status = Some(wire::StatusLine {
                            sentence,
                            refused,
                            action_label: String::new(),
                        });
                        self.refresh(ctx);
                        return Vec::new();
                    }
                }
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
                    chrome: Some(wire::AgendaChrome {
                        title: match self.destination {
                            Dest::Todo => words::band_todo(locale),
                            Dest::Waiting => words::band_waiting(locale),
                            _ => words::band_day(locale),
                        },
                        ..chrome::words_of(locale)
                    }),
                    calendar_grid: (!denied
                        && !self.search_open
                        && matches!(self.destination, Dest::Day | Dest::Schedule))
                    .then(|| grid::build(self, locale)),
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
                        .import_status
                        .clone()
                        .or_else(|| {
                            self.calendar
                                .status()
                                .cloned()
                                .or_else(|| self.ops.status.clone())
                        })
                        .or_else(|| self.notification_status.view(locale)),
                    quick_add: Some(wire::TodoQuickAdd {
                        title: self.quick.title.clone(),
                        can_submit: crate::agenda::todo::quick::with_due(
                            &self.quick.title,
                            &today,
                            self.quick.due.as_deref(),
                            locale,
                        )
                        .valid,
                        preview: crate::agenda::todo::quick::with_due(
                            &self.quick.title,
                            &today,
                            self.quick.due.as_deref(),
                            locale,
                        )
                        .preview,
                        tools: crate::agenda::todo::quick::tools(
                            locale,
                            &today,
                            &crate::agenda::todo::quick::with_due(
                                &self.quick.title,
                                &today,
                                self.quick.due.as_deref(),
                                locale,
                            )
                            .due,
                            self.quick.flagged,
                        ),
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
                    container_form: self
                        .calendar_editor
                        .as_ref()
                        .map(|editor| editor.view(locale)),
                    new_project_appearance: Some(self.new_project_style.view(locale)),
                    import_options: Some(self.import_options(ctx)),
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
