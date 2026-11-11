//! PEOPLE'S LISTS (`people.lists`, #1185): where a member makes a list, renames it and moves it to the
//! trash. A list is a container of people (`contains` edges), so the page is the closest thing People
//! has to Docs' folders and Reminders' lists, and it follows the same rules:
//!
//! - One page of rows by name, each with how many people are in it, and "New list" in the header.
//! - One sheet makes a list or renames the one tapped. A name arms it.
//! - **Move to trash** is on that sheet, destructive and asking nothing: the list goes to People's
//!   trash with the people in it left alone, the status line says "{name} moved to trash" and carries
//!   Undo, and a restore from the trash brings the list back with its people in it again.
//!
//! The count under a name is the people the roster window held, so it is said only when the window
//! held them all: a count that stopped at the window is no count.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::people_lists_event::Kind as L;
use wire::screen_event::Kind as E;

use super::denied;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Page};
use crate::kit::trash::moved_to_trash;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, people_lists as words, shared};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PeopleLists(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Lists {
        back: args.back_label.clone(),
        page: Page::loading(),
        sheet: None,
        undo: Undo::default(),
    }))
}

/// What the page holds once read: the lists by name, and how many people each holds when the
/// roster window held every person.
struct Held {
    lists: Vec<(String, String)>,
    counts: Option<BTreeMap<String, u64>>,
}

/// The name sheet: a new list, or the one tapped.
struct Sheet {
    /// The list being renamed, with the name it had.
    editing: Option<(String, String)>,
    name: String,
}

impl Sheet {
    fn can_submit(&self) -> bool {
        !self.name.trim().is_empty()
    }
}

struct Lists {
    back: String,
    page: Page<Held>,
    sheet: Option<Sheet>,
    /// What a write did (or a refusal's sentence), and what its Undo takes back. The list moved
    /// to the trash is taken back by its restore (`entity.restore` serves a list as it serves a
    /// person; `delete-list` asks first in chat, so the core states no inverse for it).
    undo: Undo,
}

impl Lists {
    fn reload(&mut self, ctx: &Ctx) {
        let reading = match read::read(
            ctx,
            load::people::People {
                filter: Some("all".to_owned()),
                limit: 0,
                sort: Some("name".to_owned()),
            },
            |answer| match answer {
                Answer::PeopleRoster(roster) => Some(roster),
                _ => None,
            },
        ) {
            read::Reading::Data(roster) => {
                let counts = (!roster.truncated).then(|| {
                    let mut counts = BTreeMap::new();
                    for list_id in roster.people.iter().filter_map(|p| p.list_id.as_deref()) {
                        *counts.entry(list_id.to_owned()).or_insert(0) += 1;
                    }
                    counts
                });
                read::Reading::Data(Held {
                    lists: roster
                        .lists
                        .into_iter()
                        .map(|list| (list.list_id, list.name))
                        .collect(),
                    counts,
                })
            }
            read::Reading::Denied(denial) => read::Reading::Denied(denial),
            read::Reading::Failed => read::Reading::Failed,
        };
        // A refresh never blanks the page shown: a failed one keeps it under a note.
        let held = std::mem::replace(&mut self.page, Page::loading());
        self.page = held.after(reading, ctx.locale(), |held| held.lists.is_empty());
    }

    fn name_of(&self, list_id: &str) -> Option<String> {
        self.page
            .data()?
            .lists
            .iter()
            .find(|(id, _)| id == list_id)
            .map(|(_, name)| name.clone())
    }

    fn submit(&mut self, ctx: &Ctx) {
        let Some(sheet) = self.sheet.as_ref().filter(|sheet| sheet.can_submit()) else {
            return;
        };
        let name = sheet.name.trim().to_owned();
        match sheet.editing.clone() {
            None => {
                let key = kit_act::key(&["create-list", &name], kit_act::fresh());
                let settled = self.undo.act(
                    ctx,
                    act::people::CreateList {
                        title: name.clone(),
                        id: None,
                    },
                    &key,
                    |locale| fill(&words::created(locale), &[("name", &name)]),
                );
                if settled.committed {
                    self.sheet = None;
                    self.reload(ctx);
                }
            }
            // A name that did not change writes nothing and closes.
            Some((_, was)) if was.trim() == name => self.sheet = None,
            Some((id, _)) => {
                let key = kit_act::key(&["rename-list", &id], kit_act::fresh());
                let settled = self.undo.act(
                    ctx,
                    act::people::RenameList {
                        people_list_id: id,
                        title: name.clone(),
                    },
                    &key,
                    |locale| fill(&words::renamed(locale), &[("name", &name)]),
                );
                if settled.committed {
                    self.sheet = None;
                    self.reload(ctx);
                }
            }
        }
    }

    /// MOVE TO TRASH: no confirm. The people in the list are not touched, and Undo restores it.
    fn trash(&mut self, ctx: &Ctx) {
        let Some((id, name)) = self.sheet.as_ref().and_then(|sheet| sheet.editing.clone()) else {
            return;
        };
        let key = kit_act::key(&["delete-list", &id], kit_act::fresh());
        let settled = self.undo.act_reverting(
            ctx,
            act::people::DeleteList {
                people_list_id: id.clone(),
            },
            act::people::RestorePerson { person_id: id },
            &key,
            |locale| moved_to_trash(locale, &name),
        );
        if settled.committed {
            self.sheet = None;
            self.reload(ctx);
        }
    }

    fn event(&mut self, event: wire::PeopleListsEvent, ctx: &Ctx) {
        match event.kind {
            Some(L::Refreshed(_)) => self.reload(ctx),
            Some(L::NewTapped(_)) => {
                self.sheet = Some(Sheet {
                    editing: None,
                    name: String::new(),
                });
                self.undo.clear();
            }
            Some(L::RowTapped(tapped)) => {
                if let Some(name) = self.name_of(&tapped.list_id) {
                    self.sheet = Some(Sheet {
                        editing: Some((tapped.list_id, name.clone())),
                        name,
                    });
                    self.undo.clear();
                }
            }
            Some(L::NameChanged(changed)) => {
                if let Some(sheet) = &mut self.sheet {
                    sheet.name = changed.text;
                }
            }
            Some(L::Submitted(_)) => self.submit(ctx),
            Some(L::SheetClosed(_)) => self.sheet = None,
            Some(L::TrashTapped(_)) => self.trash(ctx),
            None => {}
        }
    }

    fn data(&self, locale: Locale, held: &Held) -> wire::PeopleListsData {
        let rows: Vec<wire::PeopleListRow> = held
            .lists
            .iter()
            .map(|(id, name)| {
                let meta = held
                    .counts
                    .as_ref()
                    .map(|counts| words::members(locale, counts.get(id).copied().unwrap_or(0)))
                    .unwrap_or_default();
                wire::PeopleListRow {
                    list_id: id.clone(),
                    name: name.clone(),
                    accessibility_label: if meta.is_empty() {
                        name.clone()
                    } else {
                        fill(&words::row_a11y(locale), &[("name", name), ("meta", &meta)])
                    },
                    meta,
                }
            })
            .collect();
        wire::PeopleListsData { rows }
    }

    fn sheet_state(&self, locale: Locale) -> Option<wire::PeopleListSheet> {
        let sheet = self.sheet.as_ref()?;
        let editing = sheet.editing.is_some();
        Some(wire::PeopleListSheet {
            title: if editing {
                words::sheet_rename(locale)
            } else {
                words::sheet_new(locale)
            },
            name: sheet.name.clone(),
            name_placeholder: words::name_placeholder(locale),
            submit_label: if editing {
                words::save(locale)
            } else {
                words::create(locale)
            },
            can_submit: sheet.can_submit(),
            cancel_label: words::cancel(locale),
            trash_label: editing.then(|| shared::trash_move(locale)),
        })
    }
}

impl Screen for Lists {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                // THE PERSON PAGE ABOVE CLOSED (moved to trash): its line and Undo are drawn here.
                self.undo.take_handed(ctx);
            }
            Some(E::PeopleLists(event)) => self.event(event, ctx),
            Some(E::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(E::Left(_)) => self.undo.clear(),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::people_lists_state::Content;
        let locale = ctx.locale();
        let content = self
            .page
            .data()
            .map(|held| Content::Data(self.data(locale, held)));
        let drawn = matches!(self.page, Page::Ready { .. } | Page::Empty);
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PeopleLists(
                wire::PeopleListsState {
                    title: words::title(locale),
                    back_label: self.back.clone(),
                    content,
                    page: Some(self.page.wire(
                        locale,
                        |denial| denied(locale, denial),
                        || wire::EmptyState {
                            headline: words::empty_headline(locale),
                            body: words::empty_body(locale),
                            icon_key: "List".to_owned(),
                            ..wire::EmptyState::default()
                        },
                    )),
                    add_label: if drawn {
                        words::new_list(locale)
                    } else {
                        String::new()
                    },
                    status: self.undo.status(),
                    sheet: self.sheet_state(locale),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
