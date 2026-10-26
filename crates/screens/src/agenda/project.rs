//! ONE PROJECT (`agenda.project`): its work in no section, then every section
//! in its order — an empty section drawn too, with its own "Add task" — "Add
//! section" and "Rename".
//!
//! A quick add here is one write: `add-task` filed in the project and, when
//! the member pointed a section's "Add task" at it, in that section.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::todo_project_event::Kind as P;
use wire::todo_project_state::Sheet;

use super::list::{self, Phase};
use super::todo::ops::Ops;
use super::todo::rows::{self, Context};
use crate::catalog::{act, load};
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda_todo, task as words};

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
        target_section_id: String::new(),
        sheet: Sheet::None,
        new_section_name: String::new(),
        rename_name: String::new(),
    }))
}

struct Project {
    project_id: String,
    /// The name riding along from the route, until the answer names it.
    name: String,
    phase: Phase<wire::AgendaTaskBoard>,
    ops: Ops,
    quick_title: String,
    /// The section a quick add lands in; empty is the project's unsectioned work.
    target_section_id: String,
    sheet: Sheet,
    new_section_name: String,
    rename_name: String,
}

impl Project {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(list::board(
            ctx,
            load::agenda::BoardView::Project,
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

    fn data(&self, locale: Locale, board: &wire::AgendaTaskBoard) -> wire::TodoProjectData {
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
        let groups = rows::groups(locale, &board.groups, &row_ctx);
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
            ..wire::TodoProjectData::default()
        })
    }

    fn quick_add(&self, locale: Locale) -> wire::TodoQuickAdd {
        let found = self.found();
        wire::TodoQuickAdd {
            title: self.quick_title.clone(),
            can_submit: !self.quick_title.trim().is_empty(),
            lands_label: format!("{} {}", words::lands_in(locale), self.lands_in()),
            shown: found,
            focused: false,
            // A PUSHED PAGE HAS NO PLUS, so its bar stays drawn.
            add_label: String::new(),
            drawn: found,
        }
    }

    fn submit_quick_add(&mut self, ctx: &Ctx) {
        let title = self.quick_title.trim().to_owned();
        if title.is_empty() || !self.found() {
            return;
        }
        let section = (!self.target_section_id.is_empty()).then(|| self.target_section_id.clone());
        let lands_in = self.lands_in();
        if self.ops.add(
            ctx,
            &title,
            "",
            &lands_in,
            Some(&self.project_id),
            section.as_deref(),
        ) {
            self.quick_title.clear();
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
            act::agenda::CreateSection {
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
            act::agenda::RenameList {
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
            Some(P::QuickAddSubmitted(_)) => self.submit_quick_add(ctx),
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
            Some(P::SheetClosed(_)) => {
                self.sheet = Sheet::None;
                self.new_section_name.clear();
                self.rename_name.clear();
            }
            Some(P::Rename(_)) if self.found() => {
                self.sheet = Sheet::Rename;
                self.rename_name.clone_from(&self.name);
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
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::TodoProject(project)) => self.event(project, ctx),
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
            Phase::Ready(board) => Content::Data(Box::new(self.data(locale, board))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoProject(
                wire::TodoProjectState {
                    project_id: self.project_id.clone(),
                    title: self.name.clone(),
                    content: Some(content),
                    chrome: Some(rows::chrome(locale)),
                    status: self.ops.status.clone(),
                    quick_add: Some(self.quick_add(locale)),
                    sheet: self.sheet as i32,
                    new_section_name: self.new_section_name.clone(),
                    new_section_can_submit: !self.new_section_name.trim().is_empty(),
                    target_section_id: self.target_section_id.clone(),
                    rename_name: self.rename_name.clone(),
                    rename_can_submit: !self.rename_name.trim().is_empty()
                        && self.rename_name.trim() != self.name,
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
