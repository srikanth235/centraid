//! ONE PROJECT (`reminders.project`): its work in no section, then every section
//! in its order — an empty section drawn too, with its own "Add task" — "Add
//! section", "Rename" and "Edit List" (name, colour and icon: [`crate::kit::schedule::style`]).
//!
//! A quick add here is one write: `add-task` filed in the project and, when
//! the member pointed a section's "Add task" at it, in that section.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::todo_project_event::Kind as P;
use wire::todo_project_state::Sheet;

use super::list::{self, Phase};
use crate::catalog::{act, load};
use crate::kit::civil::HourCycle;
use crate::kit::read;
use crate::kit::schedule::natural::{Chipper, Fields};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::rows::{self, Context};
use crate::kit::schedule::style::{self, Draft, Subject};
use crate::reminders::ops::NewTask;
use crate::reminders::order;
use crate::reminders::quick::Quick;
use crate::reminders::view::{Prefs, Sort};
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, agenda_lists as words_lists, agenda_reminders as reminders, agenda_todo, task as words,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::TodoProject(args)) = &route.args else {
        return None;
    };
    if args.project_id.is_empty() {
        return None;
    }
    Some(Box::new(Project {
        project_id: args.project_id.clone(),
        name: args.name.clone(),
        phase: Phase::Loading,
        ops: Ops::default(),
        quick_title: String::new(),
        quick: Quick::default(),
        quick_focused: false,
        chip: Chipper::default(),
        target_section_id: String::new(),
        sheet: Sheet::None,
        new_section_name: String::new(),
        rename_name: String::new(),
        style: None,
        show_completed: false,
        completed: Vec::new(),
        prefs: Prefs::default(),
    }))
}

struct Project {
    project_id: String,
    /// The name riding along from the route, until the answer names it.
    name: String,
    phase: Phase<wire::AgendaTaskBoard>,
    ops: Ops,
    quick_title: String,
    /// What the keyboard toolbar has staged for the next add.
    quick: Quick,
    /// The field has the keyboard: Return added one and the next is typed at once.
    quick_focused: bool,
    /// The core's clock and the date chip's dismissal (#1173 Wave 3).
    chip: Chipper,
    /// The section a quick add lands in; empty is the project's unsectioned work.
    target_section_id: String,
    sheet: Sheet,
    new_section_name: String,
    rename_name: String,
    /// The style sheet's draft, while it is up.
    style: Option<Draft>,
    /// The completed rows are drawn ("Show"); they are counted either way.
    show_completed: bool,
    /// This list's completed tasks (done, not won't-do), newest first.
    completed: Vec<wire::AgendaTask>,
    /// The Reminders "Filter and sort" choice: its order and filter shape the rows, and its
    /// "Completed" opens the completed rows drawn (the page's own toggle then overrides it).
    prefs: Prefs,
}

impl Project {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(list::board(
            ctx,
            load::reminders::BoardView::Project,
            Some(self.project_id.clone()),
            rows::MAX_WINDOW,
        ));
        if let Phase::Ready(board) = &self.phase {
            if let Some(project) = board
                .projects
                .iter()
                .find(|p| p.project_id == self.project_id)
            {
                self.name.clone_from(&project.name);
            }
            // A section that is gone is not a place to add to.
            if !self.target_section_id.is_empty()
                && !board
                    .sections
                    .iter()
                    .any(|s| s.section_id == self.target_section_id)
            {
                self.target_section_id.clear();
            }
            self.ops
                .answered(ctx.locale(), &list::open_tasks(board), &board.today);
        }
        self.load_completed(ctx);
    }

    /// The Logbook's done tasks filed in this list: the summary counts them and
    /// "Show" draws them. A refused or failed read leaves the summary out, never
    /// a wrong count.
    fn load_completed(&mut self, ctx: &Ctx) {
        self.completed = match list::board(
            ctx,
            load::reminders::BoardView::Logbook,
            None,
            rows::MAX_WINDOW,
        ) {
            read::Reading::Data(board) => board
                .groups
                .iter()
                .flat_map(|group| group.tasks.iter())
                .filter(|task| {
                    task.status == rows::STATUS_DONE
                        && task.project_id.as_deref() == Some(self.project_id.as_str())
                })
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
    }

    fn completed_state(
        &self,
        locale: Locale,
        cycle: HourCycle,
        board: &wire::AgendaTaskBoard,
    ) -> wire::TodoCompleted {
        let mut row_ctx = Context::of(&board.today, &board.projects, &board.sections);
        row_ctx.show_project = false;
        row_ctx.cycle = cycle;
        wire::TodoCompleted {
            count: self.completed.len() as u32,
            count_label: reminders::completed_count(locale, self.completed.len() as u64),
            shown: self.show_completed && !self.completed.is_empty(),
            rows: if self.show_completed {
                self.completed
                    .iter()
                    .map(|task| rows::row(locale, task, &row_ctx, false))
                    .collect()
            } else {
                Vec::new()
            },
        }
    }

    /// DRAG TO REORDER: `task_id` dropped before `before_id` (empty: the end of
    /// its group). Only a drop inside one group is a reorder; another group's
    /// neighbour is a move between sections, which the filing sheet owns.
    fn move_row(&mut self, task_id: &str, before_id: &str, ctx: &Ctx) {
        // A DROP IS THE MEMBER'S OWN ORDER: under any other sort the rows are not where the
        // positions put them, so a drop would write places nobody saw.
        if self.prefs.options.sort != Sort::Manual {
            return;
        }
        let Some(board) = self.phase.data() else {
            return;
        };
        let Some(group) = board
            .groups
            .iter()
            .find(|group| group.tasks.iter().any(|task| task.task_id == task_id))
        else {
            return;
        };
        if !before_id.is_empty() && !group.tasks.iter().any(|task| task.task_id == before_id) {
            return;
        }
        let ids: Vec<(String, i64)> = group
            .tasks
            .iter()
            .map(|task| (task.task_id.clone(), task.sort_order))
            .collect();
        for (id, position) in order::plan(&ids, task_id, before_id) {
            if !self.ops.reposition(ctx, &id, position) {
                break;
            }
        }
        self.reload(ctx);
    }

    /// The core's today, for a staged due.
    fn today(&self) -> String {
        self.phase
            .data()
            .map(|board| board.today.clone())
            .unwrap_or_default()
    }

    fn stored<'b>(&self, board: &'b wire::AgendaTaskBoard) -> Option<&'b wire::AgendaTaskProject> {
        board
            .projects
            .iter()
            .find(|project| project.project_id == self.project_id)
    }

    /// "Edit List": the draft starts from what the list stores.
    fn open_style(&mut self) {
        let Some(board) = self.phase.data() else {
            return;
        };
        let Some(project) = self.stored(board) else {
            return;
        };
        self.style = Some(Draft::editing(
            Subject::List,
            &self.project_id,
            &self.name,
            project.color.as_deref(),
            project.icon.as_deref(),
        ));
        self.sheet = Sheet::Style;
    }

    /// Save: a refusal keeps the sheet and the member's words.
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
        self.reload(ctx);
    }

    /// This list's colour on the one palette of eight.
    fn color_key(&self, board: &wire::AgendaTaskBoard) -> String {
        let project = board
            .projects
            .iter()
            .find(|project| project.project_id == self.project_id);
        rows::list_color_of(&self.project_id, project)
    }

    fn found(&self) -> bool {
        self.phase.data().is_some_and(|board| {
            board
                .projects
                .iter()
                .any(|project| project.project_id == self.project_id)
        })
    }

    /// "Garden" or "Garden · Beds": where a quick add lands.
    fn lands_in(&self) -> String {
        let section = self.phase.data().and_then(|board| {
            board.sections.iter().find(|s| {
                !self.target_section_id.is_empty() && s.section_id == self.target_section_id
            })
        });
        match section {
            Some(section) => format!("{} · {}", self.name, section.name),
            None => self.name.clone(),
        }
    }

    fn data(
        &self,
        locale: Locale,
        cycle: HourCycle,
        board: &wire::AgendaTaskBoard,
    ) -> wire::TodoProjectData {
        let rename = |data: wire::TodoProjectData| wire::TodoProjectData {
            rename_label: agenda_todo::rename(locale),
            rename_title: agenda_todo::rename_title(locale),
            rename_placeholder: agenda_todo::rename_placeholder(locale),
            rename_verb: agenda_todo::rename(locale),
            ..data
        };
        if !self.found() {
            return wire::TodoProjectData {
                today: board.today.clone(),
                found: false,
                empty: Some(wire::EmptyState {
                    headline: words::project_gone(locale),
                    ..wire::EmptyState::default()
                }),
                ..wire::TodoProjectData::default()
            };
        }
        let mut row_ctx = Context::of(&board.today, &board.projects, &board.sections);
        row_ctx.show_project = false;
        row_ctx.cycle = cycle;
        let mut shaped = board.groups.clone();
        self.prefs.options.shape(&mut shaped);
        let groups = rows::groups(locale, &shaped, &row_ctx);
        rename(wire::TodoProjectData {
            today: board.today.clone(),
            count_label: rows::count(locale, rows::root_count(&groups)),
            empty: groups.is_empty().then(|| wire::EmptyState {
                headline: words::project_empty(locale),
                ..wire::EmptyState::default()
            }),
            groups,
            add_section_label: words::add_section(locale),
            found: true,
            list_color_key: self.color_key(board),
            icon_key: style::icon_of(self.stored(board).and_then(|p| p.icon.as_deref())),
            style_label: words_lists::edit_list_title(locale),
            completed: Some(self.completed_state(locale, cycle, board)),
            ..wire::TodoProjectData::default()
        })
    }

    fn quick_add(&self, locale: Locale, cycle: HourCycle) -> wire::TodoQuickAdd {
        let found = self.found();
        let mut bar = wire::TodoQuickAdd {
            title: self.quick_title.clone(),
            can_submit: !self.quick_title.trim().is_empty(),
            // THE INLINE ROW (#1173) says "New Reminder"; pointed at a section it
            // says where the task lands.
            lands_label: if self.target_section_id.is_empty() {
                reminders::new_reminder(locale)
            } else {
                format!("{} {}", words::lands_in(locale), self.lands_in())
            },
            shown: found,
            focused: self.quick_focused,
            // A day the toolbar staged is the date: no second reading.
            chip: if self.quick.due_day(&self.today()).is_empty() {
                self.chip
                    .reading(locale, cycle, &self.quick_title)
                    .map(|reading| reading.chip())
            } else {
                None
            },
            // A PUSHED PAGE HAS NO PLUS, so its bar stays drawn.
            add_label: String::new(),
            drawn: found,
            ..wire::TodoQuickAdd::default()
        };
        self.quick.fill(locale, &mut bar);
        bar
    }

    fn submit_quick_add(&mut self, ctx: &Ctx) {
        let title = self.quick_title.trim().to_owned();
        if title.is_empty() || !self.found() {
            return;
        }
        let section = (!self.target_section_id.is_empty()).then(|| self.target_section_id.clone());
        let lands_in = self.lands_in();
        // THE CORE'S CLOCK, read just now, never the device's. A day the toolbar
        // staged is the member's explicit pick: it wins, and the words stay as typed.
        let staged_day = self.quick.due_day(&self.today());
        let fields = if staged_day.is_empty() {
            self.chip.fields(ctx, &title)
        } else {
            Fields {
                title: title.clone(),
                due: staged_day,
                ..Fields::default()
            }
        };
        let task = NewTask {
            project_id: Some(&self.project_id),
            section_id: section.as_deref(),
            tags: self.quick.tags(),
            flagged: self.quick.flagged(),
            ..NewTask::dated(&fields)
        };
        if self.ops.add_full(ctx, &task, &lands_in).is_some() {
            // RETURN KEEPS THE KEYBOARD: the next one is typed at once.
            self.quick_title.clear();
            self.quick.clear();
            self.chip.clear();
            self.quick_focused = true;
        }
        self.reload(ctx);
    }

    fn submit_section(&mut self, ctx: &Ctx) {
        let name = self.new_section_name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        let made = self.ops.created(
            ctx,
            act::reminders::CreateSection {
                parent: self.project_id.clone(),
                title: name.clone(),
                ..Default::default()
            },
            &format!("{}/{name}", self.project_id),
            words::section_added(ctx.locale()),
        );
        self.sheet = Sheet::None;
        if made {
            self.new_section_name.clear();
        }
        self.reload(ctx);
    }

    fn submit_rename(&mut self, ctx: &Ctx) {
        let name = self.rename_name.trim().to_owned();
        self.sheet = Sheet::None;
        if name.is_empty() || name == self.name {
            return;
        }
        self.ops.created(
            ctx,
            act::reminders::RenameList {
                list_id: self.project_id.clone(),
                title: name.clone(),
            },
            &format!("{}={name}", self.project_id),
            agenda_todo::project_renamed(ctx.locale()),
        );
        self.reload(ctx);
    }

    fn event(&mut self, event: wire::TodoProjectEvent, ctx: &Ctx) {
        match event.kind {
            Some(P::Refreshed(_)) => self.reload(ctx),
            Some(P::RowChecked(checked)) => {
                let Some(task) = self
                    .phase
                    .data()
                    .and_then(|board| list::find(board, &checked.task_id))
                else {
                    return;
                };
                self.ops.check(ctx, &task);
                self.reload(ctx);
            }
            Some(P::StatusActed(_)) => {
                self.ops.undo(ctx);
                self.reload(ctx);
            }
            Some(P::QuickAddChanged(changed)) => self.quick_title = changed.title,
            Some(P::QuickAddChipDismissed(_)) => {
                let words = self.quick_title.clone();
                self.chip.dismiss(&words);
            }
            Some(P::QuickAddSubmitted(_)) => self.submit_quick_add(ctx),
            // THE KEYBOARD TOOLBAR (#1173): each key stages what the next add carries.
            Some(P::QuickTool(picked)) if self.found() => {
                self.quick.pick_tool(&picked.key);
                self.quick_focused = true;
            }
            Some(P::QuickDue(picked)) if self.found() => {
                self.quick.pick_due(&picked.key);
                self.quick_focused = true;
            }
            Some(P::QuickTag(added)) if self.found() => {
                self.quick.add_tag(&added.text);
                self.quick_focused = true;
            }
            // `add:<section_id>` points the quick add at a section; `add:` at
            // the project's unsectioned work.
            Some(P::GroupVerb(verb)) => {
                if let Some(section) = verb.key.strip_prefix(rows::VERB_ADD) {
                    self.target_section_id = section.to_owned();
                }
            }
            Some(P::AddSection(_)) => self.sheet = Sheet::AddSection,
            Some(P::SectionName(named)) => self.new_section_name = named.name,
            Some(P::SectionSubmitted(_)) => self.submit_section(ctx),
            Some(P::StyleRequested(_)) if self.found() => self.open_style(),
            Some(P::StyleName(named)) => {
                if let Some(draft) = &mut self.style {
                    draft.set_name(named.name);
                }
            }
            Some(P::StyleColor(picked)) => {
                if let Some(draft) = &mut self.style {
                    draft.pick_color(&picked.key);
                }
            }
            Some(P::StyleIcon(picked)) => {
                if let Some(draft) = &mut self.style {
                    draft.pick_icon(&picked.key);
                }
            }
            Some(P::StyleSubmitted(_)) => self.submit_style(ctx),
            Some(P::SheetClosed(_)) => {
                self.style = None;
                self.sheet = Sheet::None;
                self.new_section_name.clear();
                self.rename_name.clear();
            }
            Some(P::Rename(_)) if self.found() => {
                self.sheet = Sheet::Rename;
                self.rename_name.clone_from(&self.name);
            }
            Some(P::RowFlagged(flagged)) => {
                if self
                    .phase
                    .data()
                    .and_then(|board| list::find(board, &flagged.task_id))
                    .is_some()
                {
                    self.ops.flag(ctx, &flagged.task_id, flagged.flagged);
                    self.reload(ctx);
                }
            }
            Some(P::RowDeleted(deleted)) => {
                if self
                    .phase
                    .data()
                    .and_then(|board| list::find(board, &deleted.task_id))
                    .is_some()
                {
                    self.ops.delete(ctx, &deleted.task_id);
                    self.reload(ctx);
                }
            }
            Some(P::RowMoved(moved)) => self.move_row(&moved.task_id, &moved.before_id, ctx),
            Some(P::CompletedToggled(_)) => self.show_completed = !self.show_completed,
            Some(P::CompletedCleared(_)) => {
                let ids: Vec<String> = self.completed.iter().map(|t| t.task_id.clone()).collect();
                if !ids.is_empty() {
                    self.ops.clear_completed(ctx, &ids);
                    self.reload(ctx);
                }
            }
            Some(P::RenameName(named)) => self.rename_name = named.name,
            Some(P::RenameSubmitted(_)) => self.submit_rename(ctx),
            _ => {}
        }
    }
}

impl Screen for Project {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.chip.hold(ctx);
                self.reload(ctx);
                return self.prefs.reset_and_ask();
            }
            Some(E::EffectResult(result)) => {
                if self.prefs.answers(&result) {
                    self.show_completed = self.prefs.options.show_completed;
                }
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::TodoProject(project)) => {
                if let Some(P::GroupVerb(verb)) = &project.kind
                    && verb.key == rows::VERB_CATCH_UP
                {
                    return list::verb_effects(&verb.key);
                }
                self.event(project, ctx);
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::todo_project_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(list::denied(locale, denial)),
            Phase::Ready(board) => {
                Content::Data(Box::new(self.data(locale, ctx.hour_cycle(), board)))
            }
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoProject(
                wire::TodoProjectState {
                    title: self.name.clone(),
                    content: Some(content),
                    chrome: Some(rows::chrome(locale)),
                    status: self.ops.status.clone(),
                    quick_add: Some(self.quick_add(locale, ctx.hour_cycle())),
                    sheet: self.sheet as i32,
                    new_section_name: self.new_section_name.clone(),
                    new_section_can_submit: !self.new_section_name.trim().is_empty(),
                    rename_name: self.rename_name.clone(),
                    rename_can_submit: !self.rename_name.trim().is_empty()
                        && self.rename_name.trim() != self.name,
                    style: self
                        .style
                        .as_ref()
                        .filter(|_| self.sheet == Sheet::Style)
                        .map(|draft| Box::new(draft.sheet(locale))),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
