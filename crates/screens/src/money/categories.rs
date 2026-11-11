//! CATEGORIES (`money.categories`): one scheme, two levels. A category is added
//! under a group, merged into another (every line filed under it moves), or
//! archived so it leaves the pickers and keeps its history; archiving is undone
//! the same way. The starters are the vault's own and are managed here like any
//! other.

use centraid_api_proto::core_v1 as wire;
use wire::money_categories_event::Kind as C;
use wire::money_categories_state::Sheet;
use wire::screen_event::Kind as E;

use super::fold;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Page};
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

const ROW_MERGE: &str = "merge";
const ROW_ARCHIVE: &str = "archive";
const ROW_RESTORE: &str = "restore";
const NAME_MAX: usize = 60;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyCategories(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Categories {
        parent: args.parent.clone(),
        page: Page::loading(),
        sheet: Sheet::None,
        category_id: String::new(),
        name_draft: String::new(),
        group_id: String::new(),
        merge_into: String::new(),
        undo: Undo::default(),
    }))
}

struct Categories {
    parent: String,
    page: Page<wire::MoneyCategories>,
    sheet: Sheet,
    /// The category a row sheet or a merge is about.
    category_id: String,
    name_draft: String,
    group_id: String,
    /// The category a merge waits on a confirmation to move into.
    merge_into: String,
    /// The status line and what its Undo reverses (the kit's one door).
    undo: Undo,
}

fn entry<'a>(
    answer: &'a wire::MoneyCategories,
    id: &str,
) -> Option<&'a wire::money_categories::Category> {
    answer
        .groups
        .iter()
        .flat_map(|g| &g.categories)
        .find(|c| c.category_id == id)
}

impl Categories {
    fn reload(&mut self, ctx: &Ctx) {
        fold::reread(
            &mut self.page,
            ctx.locale(),
            read::read(ctx, load::money::Categories {}, |a| match a {
                wire::app_query_response::Answer::MoneyCategories(x) => Some(x),
                _ => None,
            }),
            |_| false,
        );
    }

    fn submit(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, done: String) {
        let key = kit_act::key(&["money", "category"], kit_act::fresh());
        self.undo.act(ctx, request, &key, |_| done);
        self.reload(ctx);
    }

    fn row_action(&mut self, key: &str, ctx: &Ctx) {
        let locale = ctx.locale();
        match key {
            ROW_MERGE => self.sheet = Sheet::Merge,
            ROW_ARCHIVE => {
                self.sheet = Sheet::None;
                self.submit(
                    ctx,
                    act::money::ArchiveCategory {
                        flag: act::money::ArchiveCategoryFlag::Archived,
                        category_id: self.category_id.clone(),
                    },
                    words::done_archived(locale),
                );
            }
            ROW_RESTORE => {
                self.sheet = Sheet::None;
                self.submit(
                    ctx,
                    act::money::UnarchiveCategory {
                        flag: act::money::UnarchiveCategoryFlag::Archived,
                        category_id: self.category_id.clone(),
                    },
                    words::done_archived(locale),
                );
            }
            _ => {}
        }
    }

    fn add(&mut self, ctx: &Ctx) {
        let name = self.name_draft.trim().to_owned();
        if name.is_empty() || name.chars().count() > NAME_MAX {
            return;
        }
        self.sheet = Sheet::None;
        self.submit(
            ctx,
            act::money::AddCategory {
                title: name,
                parent_id: Some(self.group_id.clone()).filter(|g| !g.is_empty()),
            },
            words::done_category_added(ctx.locale()),
        );
    }

    fn event(&mut self, event: wire::MoneyCategoriesEvent, ctx: &Ctx) {
        match event.kind {
            Some(C::Add(_)) => {
                self.sheet = Sheet::Add;
                self.name_draft.clear();
                self.group_id.clear();
                self.undo.clear();
            }
            Some(C::Name(typed)) => self.name_draft = typed.text,
            Some(C::Group(picked)) => self.group_id = picked.group_id,
            Some(C::Save(_)) => self.add(ctx),
            Some(C::Category(tapped)) => {
                self.sheet = Sheet::Row;
                self.category_id = tapped.category_id;
                self.undo.clear();
            }
            Some(C::RowAction(action)) => self.row_action(&action.key, ctx),
            Some(C::MergeInto(into)) => {
                if self.page.data().is_some_and(|a| {
                    entry(a, &self.category_id).is_some() && entry(a, &into.category_id).is_some()
                }) {
                    self.merge_into = into.category_id;
                }
            }
            Some(C::ConfirmDismissed(_)) => self.merge_into.clear(),
            Some(C::ConfirmAccepted(_)) if !self.merge_into.is_empty() => {
                let into = std::mem::take(&mut self.merge_into);
                self.sheet = Sheet::None;
                self.submit(
                    ctx,
                    act::money::MergeCategory {
                        from_id: self.category_id.clone(),
                        into_id: into,
                    },
                    words::done_merged(ctx.locale()),
                );
            }
            Some(C::SheetClosed(_)) => {
                self.sheet = Sheet::None;
                self.merge_into.clear();
            }
            _ => {}
        }
    }

    fn data(&self, locale: Locale, answer: &wire::MoneyCategories) -> wire::MoneyCategoriesData {
        // A GROUP WITH NO CATEGORY IN IT IS NOT A HEADING OVER NOTHING (the board draws none); the
        // add sheet still offers it as a group to file under (`group_options`).
        let groups: Vec<wire::MoneyCategoryGroup> = answer
            .groups
            .iter()
            .filter(|group| !group.categories.is_empty())
            .map(|group| wire::MoneyCategoryGroup {
                group_id: group.group_id.clone(),
                label: group.label.clone(),
                rows: group
                    .categories
                    .iter()
                    .map(|category| wire::MoneyCategoryEntry {
                        category_id: category.category_id.clone(),
                        label: category.label.clone(),
                        archived: category.archived,
                        meta: if category.archived {
                            words::archived(locale)
                        } else {
                            String::new()
                        },
                        accessibility_label: [
                            category.label.clone(),
                            group.label.clone(),
                            if category.archived {
                                words::archived(locale)
                            } else {
                                String::new()
                            },
                        ]
                        .into_iter()
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                        .join(", "),
                    })
                    .collect(),
            })
            .collect();
        let name = self.name_draft.trim();
        let too_long = name.chars().count() > NAME_MAX;
        let picked = entry(answer, &self.category_id);
        let action = |key: &str, label: String, icon: &str, enabled: bool| wire::MoneyAction {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            enabled,
            destructive: false,
        };
        wire::MoneyCategoriesData {
            add_label: words::category_add(locale),
            add_title: words::category_add_title(locale),
            name_label: words::category_name(locale),
            group_label: words::category_group(locale),
            group_options: std::iter::once(fold::choice(
                "",
                &words::no_group(locale),
                self.group_id.is_empty(),
                "",
            ))
            .chain(
                answer
                    .groups
                    .iter()
                    .map(|g| fold::choice(&g.group_id, &g.label, g.group_id == self.group_id, "")),
            )
            .collect(),
            save_label: words::category_add_save(locale),
            can_save: !name.is_empty() && !too_long,
            issue: if too_long {
                words::category_name_long(locale)
            } else {
                String::new()
            },
            row_title: picked.map(|c| c.label.clone()).unwrap_or_default(),
            row_actions: picked
                .map(|c| {
                    vec![
                        action(
                            ROW_MERGE,
                            words::action_merge(locale),
                            "Layers",
                            !c.archived,
                        ),
                        if c.archived {
                            action(ROW_RESTORE, words::action_restore(locale), "Refresh", true)
                        } else {
                            action(ROW_ARCHIVE, words::action_archive(locale), "Archive", true)
                        },
                    ]
                })
                .unwrap_or_default(),
            merge_title: words::merge_sheet_title(locale),
            merge_options: answer
                .groups
                .iter()
                .flat_map(|g| {
                    g.categories
                        .iter()
                        .filter(|c| !c.archived && c.category_id != self.category_id)
                        .map(move |c| fold::choice(&c.category_id, &c.label, false, &g.label))
                })
                .collect(),
            groups,
            cancel_label: words::cancel(locale),
        }
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        let answer = self.page.data()?;
        if self.merge_into.is_empty() {
            return None;
        }
        let (from, into) = (
            entry(answer, &self.category_id)?,
            entry(answer, &self.merge_into)?,
        );
        Some(wire::Confirm {
            title: words::merge_title(locale),
            body: fill(
                &words::merge_body(locale),
                &[("from", &from.label), ("into", &into.label)],
            ),
            confirm_label: words::merge_confirm(locale),
            destructive: true,
        })
    }
}

impl Screen for Categories {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyCategories(wire::MoneyCategoriesEvent {
                kind: Some(wire::money_categories_event::Kind::Refreshed(_)),
            })) => self.reload(ctx),
            Some(E::MoneyCategories(c)) => self.event(c, ctx),
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
        use wire::money_categories_state::Content;
        let locale = ctx.locale();
        let content = self
            .page
            .data()
            .map(|answer| Content::Data(Box::new(self.data(locale, answer))));
        // No category at all is the page's own empty state; the answer stays, because the add sheet
        // still offers its groups.
        let nothing = self
            .page
            .data()
            .is_some_and(|answer| answer.groups.iter().all(|g| g.categories.is_empty()));
        let page = fold::wire_page_keeping(&self.page, locale, nothing, || wire::EmptyState {
            headline: words::categories_empty(locale),
            action_label: words::category_add(locale),
            ..Default::default()
        });
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyCategories(
                wire::MoneyCategoriesState {
                    content,
                    page: Some(page),
                    sheet: self.sheet as i32,
                    category_id: self.category_id.clone(),
                    name_draft: self.name_draft.clone(),
                    group_id: self.group_id.clone(),
                    confirm: self.confirm(locale),
                    chrome: Some(fold::chrome(
                        locale,
                        words::categories_title(locale),
                        &self.parent,
                    )),
                    status: self.undo.status(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
