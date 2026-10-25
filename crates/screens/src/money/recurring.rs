//! THE RECURRING CHARGES (`money.recurring`): what the core detected over the
//! last months, with when each is next due and whether this cycle's has posted.
//! The page reads and draws; nothing here is written.

use centraid_api_proto::core_v1 as wire;
use wire::MoneyRecurringStatus as Status;
use wire::screen_event::Kind as E;
use wire::status_chip::Tone;

use super::fold::{self, Phase, chip};
use crate::catalog::load;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyRecurring(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Recurring {
        parent: args.parent.clone(),
        phase: Phase::Loading,
    }))
}

struct Recurring {
    parent: String,
    phase: Phase<wire::MoneyRecurring>,
}

impl Recurring {
    fn reload(&mut self, ctx: &Ctx) {
        self.phase = Phase::of(read::read(ctx, load::money::Recurring {}, |a| match a {
            wire::app_query_response::Answer::MoneyRecurring(x) => Some(x),
            _ => None,
        }));
    }

    fn data(locale: Locale, answer: &wire::MoneyRecurring) -> wire::MoneyRecurringData {
        let rows: Vec<wire::MoneyRecurringRow> = answer
            .series
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let mut parts = Vec::new();
                if let Some(next) = &line.next_due {
                    parts.push(fill(
                        &words::next_due(locale),
                        &[("day", &fold::day_words(locale, next, &answer.today))],
                    ));
                }
                parts.push(fold::with_n(
                    words::seen_times_short(locale),
                    line.seen_times,
                ));
                let detail = parts.join(" · ");
                let cadence = if line.cadence_words.is_empty() {
                    fold::cadence_words(locale, line.cadence)
                } else {
                    line.cadence_words.clone()
                };
                wire::MoneyRecurringRow {
                    key: format!("{index}:{}", line.merchant),
                    merchant: line.merchant.clone(),
                    meta: format!("{cadence} · {}", line.account_label),
                    amount: fold::text(line.amount.as_ref()),
                    chips: match Status::try_from(line.status).unwrap_or(Status::Unspecified) {
                        Status::Late => vec![chip(words::chip_late(locale), Tone::Warning)],
                        Status::Paid => vec![chip(words::chip_paid(locale), Tone::Seam)],
                        Status::Due => vec![chip(words::chip_due(locale), Tone::Neutral)],
                        Status::Unspecified => Vec::new(),
                    },
                    accessibility_label: [
                        line.merchant.clone(),
                        line.cadence_words.clone(),
                        detail.clone(),
                    ]
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join(", "),
                    detail,
                }
            })
            .collect();
        wire::MoneyRecurringData {
            empty: rows.is_empty().then(|| wire::EmptyState {
                headline: words::recurring_empty(locale),
                ..Default::default()
            }),
            rows,
            definitions: fold::definitions(locale, &answer.definitions),
            window_note: if answer.truncated {
                words::window_note(locale)
            } else {
                String::new()
            },
        }
    }
}

impl Screen for Recurring {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyRecurring(_)) => self.reload(ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_recurring_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied => Content::Denied(fold::denied(locale)),
            Phase::Ready(answer) => Content::Data(Self::data(locale, answer)),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyRecurring(
                wire::MoneyRecurringState {
                    content: Some(content),
                    chrome: Some(fold::chrome(
                        locale,
                        words::recurring_title(locale),
                        &self.parent,
                    )),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
