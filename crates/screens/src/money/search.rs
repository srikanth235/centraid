//! MONEY'S SEARCH (`money.search`), a page of its own the search bar pushes.
//! The core asks the vault's full-text index over every line ever imported (its
//! name, the bank's words, its category, its account and the notes about it),
//! best match first; this page draws rows and a count, and an empty term reads
//! nothing.

use centraid_api_proto::core_v1 as wire;
use wire::money_search_event::Kind as S;
use wire::screen_event::Kind as E;

use super::fold;
use super::rows;
use crate::catalog::load;
use crate::kit::read::Page;
use crate::kit::{read, search};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

/// Rows asked for.
pub const LIMIT: u32 = 50;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneySearch(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Search {
        parent: args.parent.clone(),
        term: String::new(),
        page: Page::loading(),
        asked_term: String::new(),
    }))
}

struct Search {
    parent: String,
    term: String,
    /// The read of the term asked; the resting page (no term) reads nothing.
    page: Page<wire::MoneySearch>,
    /// The term `page` answers: another term is another question, so the last term's rows are
    /// never shown for it.
    asked_term: String,
}

impl Search {
    fn asked(&self) -> &str {
        self.term.trim()
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.asked().is_empty() {
            self.page = Page::loading();
            self.asked_term.clear();
            return;
        }
        if self.asked_term != self.asked() {
            self.page = Page::loading();
            self.asked_term = self.asked().to_owned();
        }
        let reading = read::read(
            ctx,
            load::money::Search {
                month: String::new(),
                term: self.asked().to_owned(),
                limit: LIMIT,
            },
            |a| match a {
                wire::app_query_response::Answer::MoneySearch(x) => Some(x),
                _ => None,
            },
        );
        fold::reread(&mut self.page, ctx.locale(), reading, |_| false);
    }

    fn data(&self, locale: Locale, answer: &wire::MoneySearch) -> wire::MoneySearchData {
        let parent = words::search_title(locale);
        let lines: Vec<wire::MoneyRow> = answer
            .rows
            .iter()
            .map(|row| {
                let mut line = rows::row(locale, row, "", true, true, &parent);
                // Words only an earlier version of the line held (#1185): the row says so, and
                // opens its Earlier versions.
                if row.in_earlier_version {
                    line.meta = search::earlier_meta(locale, &line.meta);
                    line.accessibility_label = format!(
                        "{}, {}",
                        line.accessibility_label,
                        search::in_earlier_version(locale)
                    );
                    line.route = Some(search::earlier_route(locale, super::EARLIER, &row.txn_id));
                }
                line
            })
            .collect();
        let total = answer.total_matches as usize;
        wire::MoneySearchData {
            count_label: if lines.is_empty() {
                String::new()
            } else if total > lines.len() {
                fill(
                    &words::matches_of(locale),
                    &[
                        ("n", &lines.len().to_string()),
                        ("total", &total.to_string()),
                    ],
                )
            } else {
                fold::count(total, &words::match_one(locale), &words::match_many(locale))
            },
            corrected: answer.corrected.clone().unwrap_or_default(),
            ask: Some(search::offer(locale, self.asked(), "money")),
            rows: lines,
        }
    }
}

impl Screen for Search {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneySearch(wire::MoneySearchEvent {
                kind: Some(wire::money_search_event::Kind::Refreshed(_)),
            })) => self.reload(ctx),
            Some(E::MoneySearch(search)) => match search.kind {
                Some(S::Term(typed)) => {
                    self.term = typed.term;
                    self.reload(ctx);
                }
                Some(S::Cleared(_)) => {
                    self.term.clear();
                    self.reload(ctx);
                }
                Some(S::Refreshed(_)) | None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_search_state::Content;
        let locale = ctx.locale();
        let resting = self.asked().is_empty();
        let content = if resting {
            None
        } else {
            self.page
                .data()
                .map(|answer| Content::Data(Box::new(self.data(locale, answer))))
        };
        // The resting page and a term that matched nothing are the page's empty state; the answer
        // stays for the second, because its Ask offer is drawn under the empty sentence.
        let nothing = self
            .page
            .data()
            .is_some_and(|answer| answer.rows.is_empty());
        let page = if resting {
            Page::<()>::Empty.wire(
                locale,
                |_| fold::denied(locale),
                || wire::EmptyState {
                    headline: words::search_resting(locale),
                    ..Default::default()
                },
            )
        } else {
            fold::wire_page_keeping(&self.page, locale, nothing, || wire::EmptyState {
                headline: fill(&words::nothing_matches(locale), &[("term", self.asked())]),
                body: words::search_not_searched(locale),
                ..Default::default()
            })
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneySearch(
                wire::MoneySearchState {
                    content,
                    page: Some(page),
                    chrome: Some(fold::chrome(
                        locale,
                        words::search_title(locale),
                        &self.parent,
                    )),
                    placeholder: words::search_placeholder(locale),
                    clear_label: words::clear(locale),
                    term: self.term.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
