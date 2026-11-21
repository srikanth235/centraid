//! MONEY'S SEARCH, IN PLACE (owner, 2026-11-19): the band's search key opens a field at the foot of
//! the home, as in every other app, and the answer replaces the page's content while it is open.
//! The core asks the vault's full-text index over every line ever imported (its name, the bank's
//! words, its category, its account and the notes about it), best match first; this draws rows, a
//! count and the Ask row, and an empty term reads nothing. Closing the field brings the tab back.

use centraid_api_proto::core_v1 as wire;

use super::fold;
use super::rows;
use crate::catalog::load;
use crate::kit::read::Page;
use crate::kit::{read, search};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, money as words};

/// Rows asked for.
pub const LIMIT: u32 = 50;

/// The search field and its answer. A search that matched nothing is [`Page::Empty`], never ready
/// data.
#[derive(Default)]
pub(super) struct Search {
    pub open: bool,
    pub term: String,
    /// The answer for the trimmed `term`, once there is one to ask.
    held: Option<Page<wire::MoneySearch>>,
    /// The trimmed term `held` answers: another term is another question, so the last term's rows
    /// are never shown for it.
    answered: String,
}

impl Search {
    fn asked(&self) -> &str {
        self.term.trim()
    }

    /// Is a term being answered? Then a read is a search.
    pub fn active(&self) -> bool {
        self.open && !self.asked().is_empty()
    }

    pub fn opened(&mut self) {
        self.open = true;
    }

    pub fn typed(&mut self, ctx: &Ctx, term: String) {
        self.open = true;
        self.term = term;
        if self.active() {
            self.reload(ctx);
        } else {
            self.held = None;
            self.answered.clear();
        }
    }

    pub fn closed(&mut self) {
        *self = Self::default();
    }

    /// Read the answer for the term again (the data changed, or the term did).
    pub fn reload(&mut self, ctx: &Ctx) {
        if !self.active() {
            return;
        }
        let term = self.asked().to_owned();
        let reading = read::read(
            ctx,
            load::money::Search {
                month: String::new(),
                term: term.clone(),
                limit: LIMIT,
            },
            |a| match a {
                wire::app_query_response::Answer::MoneySearch(x) => Some(x),
                _ => None,
            },
        );
        let held = match self.held.take() {
            Some(held) if self.answered == term => held.refreshing(),
            _ => Page::loading(),
        };
        self.answered = term;
        self.held = Some(held.after(reading, ctx.locale(), |found| found.rows.is_empty()));
    }

    /// THE PAGE'S READ over an open search: nothing typed is ready (the hint is under the field), a
    /// term that matched nothing is the page's empty state with the term quoted, and a failure or
    /// the gate is the search's own.
    pub fn wire_page(&self, locale: Locale) -> wire::PageState {
        let gate = |_: &wire::AppQueryDenial| fold::denied(locale);
        match (&self.held, self.active()) {
            (Some(held), true) => held.wire(locale, gate, || wire::EmptyState {
                headline: fill(&words::nothing_matches(locale), &[("term", self.asked())]),
                body: words::search_not_searched(locale),
                ..Default::default()
            }),
            _ => Page::<()>::Ready {
                data: (),
                note: None,
            }
            .wire(locale, gate, wire::EmptyState::default),
        }
    }

    /// The field's state: the typed term, the answer's rows, the corrected line and the Ask row.
    pub fn field(&self, locale: Locale) -> wire::MoneySearchField {
        let mut field = wire::MoneySearchField {
            open: self.open,
            term: self.term.clone(),
            ..wire::MoneySearchField::default()
        };
        if !self.open {
            return field;
        }
        if !self.active() {
            field.results = Some(wire::MoneySearchResults {
                hint: words::search_resting(locale),
                ..wire::MoneySearchResults::default()
            });
            return field;
        }
        match &self.held {
            Some(Page::Ready { data, .. }) => {
                field.results = Some(results(locale, data));
                if let Some(corrected) = data.corrected.as_deref().filter(|c| !c.is_empty()) {
                    field.corrected = search::corrected(locale, corrected);
                }
                field.ask = Some(search::offer(locale, self.asked(), "money"));
            }
            // A TERM THAT MATCHED NOTHING still offers the Ask row, under the empty sentence.
            Some(Page::Empty) => field.ask = Some(search::offer(locale, self.asked(), "money")),
            _ => {}
        }
        field
    }
}

fn results(locale: Locale, answer: &wire::MoneySearch) -> wire::MoneySearchResults {
    let parent = words::app_title(locale);
    let lines: Vec<wire::MoneyRow> = answer
        .rows
        .iter()
        .map(|row| {
            let mut line = rows::row(locale, row, "", true, true, &parent);
            // Words only an earlier version of the line held (#1185): the row says so, and opens its
            // Earlier versions.
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
    wire::MoneySearchResults {
        count_label: if total > lines.len() {
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
        rows: lines,
        hint: String::new(),
    }
}
