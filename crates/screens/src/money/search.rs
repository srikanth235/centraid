//! MONEY'S SEARCH (`money.search`), a page of its own the search bar pushes.
//! The core asks the vault's full-text index over every line ever imported (its
//! name, the bank's words, its category, its account and the notes about it),
//! best match first; this page draws rows and a count, and an empty term reads
//! nothing.

use centraid_api_proto::core_v1 as wire;
use wire::money_search_event::Kind as S;
use wire::screen_event::Kind as E;

use super::fold::{self, Phase};
use super::rows;
use crate::catalog::load;
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
        phase: Phase::Loading,
    }))
}

struct Search {
    parent: String,
    term: String,
    /// `Loading` is the resting page: no term, nothing read.
    phase: Phase<wire::MoneySearch>,
}

impl Search {
    fn asked(&self) -> &str {
        self.term.trim()
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.asked().is_empty() {
            self.phase = Phase::Loading;
            return;
        }
        self.phase = Phase::of(read::read(
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
        ));
    }

    fn data(&self, locale: Locale, answer: &wire::MoneySearch) -> wire::MoneySearchData {
        let parent = words::search_title(locale);
        let lines: Vec<wire::MoneyRow> = answer
            .rows
            .iter()
            .map(|row| rows::row(locale, row, "", true, true, &parent))
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
            empty: lines.is_empty().then(|| wire::EmptyState {
                headline: fill(&words::nothing_matches(locale), &[("term", self.asked())]),
                body: words::search_not_searched(locale),
                ..Default::default()
            }),
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
        let content = match &self.phase {
            _ if resting => None,
            Phase::Loading => Some(Content::Loading(wire::Loading { first_load: true })),
            Phase::Failed => Some(Content::Failure(read::failure(locale))),
            Phase::Denied => Some(Content::Denied(fold::denied(locale))),
            Phase::Ready(answer) => Some(Content::Data(self.data(locale, answer))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneySearch(
                wire::MoneySearchState {
                    content,
                    resting: resting.then(|| wire::EmptyState {
                        headline: words::search_resting(locale),
                        ..Default::default()
                    }),
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
