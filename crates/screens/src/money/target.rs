//! A CATEGORY'S PLAN FOR ONE MONTH (`money.target`). The stored facts are four:
//! month, category, amount, carry. The page shows what the last six months
//! averaged and previews the NEXT month's effect before the member commits, so
//! the core is asked again as they type.

use centraid_api_proto::core_v1 as wire;
use wire::money_target_event::Kind as T;
use wire::screen_event::Kind as E;

use super::fold::{self, Phase};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::money as money_kit;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, money as words};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyTarget(args)) = &route.args else {
        return None;
    };
    if args.category_id.is_empty() {
        return None;
    }
    Some(Box::new(Target {
        month: args.month.clone(),
        category_id: args.category_id.clone(),
        currency: args.currency.clone(),
        phase: Phase::Loading,
        amount_text: String::new(),
        carry: false,
        seeded: false,
        status: None,
        finished: false,
    }))
}

struct Target {
    month: String,
    category_id: String,
    currency: String,
    phase: Phase<wire::MoneyTargetSheet>,
    amount_text: String,
    carry: bool,
    /// The form was seeded from the stored plan; later answers never overwrite typing.
    seeded: bool,
    status: Option<wire::StatusLine>,
    finished: bool,
}

impl Target {
    fn exponent(&self) -> u32 {
        self.phase
            .data()
            .map_or(0, |a| a.spent.as_ref().map_or(0, |s| s.exponent))
    }

    fn typed(&self) -> Option<i64> {
        money_kit::parse(&self.amount_text, self.exponent())
    }

    fn reload(&mut self, ctx: &Ctx) {
        let typing = if self.seeded { self.typed() } else { None };
        self.phase = Phase::of(read::read(
            ctx,
            load::money::TargetSheet {
                category_id: self.category_id.clone(),
                currency: self.currency.clone(),
                month: self.month.clone(),
                typing_amount_minor: typing,
                typing_carry: Some(i64::from(self.seeded && self.carry)),
            },
            |a| match a {
                wire::app_query_response::Answer::MoneyTargetSheet(x) => Some(x),
                _ => None,
            },
        ));
        // THE FIRST ANSWER SEEDS THE FORM from the stored plan.
        if !self.seeded
            && let Phase::Ready(answer) = &self.phase
        {
            self.seeded = true;
            self.amount_text = answer
                .amount
                .as_ref()
                .map(|a| money_kit::amount_text(a.minor, a.exponent))
                .unwrap_or_default();
            self.carry = answer.carry;
        }
    }

    fn save(&mut self, ctx: &Ctx, remove: bool) {
        let amount = if remove {
            None
        } else {
            match self.typed() {
                Some(minor) => Some(minor),
                None => return,
            }
        };
        let key = kit_act::key(
            &["money", "target", &self.month, &self.category_id],
            kit_act::fresh(),
        );
        let settled = kit_act::act(
            ctx,
            act::money::SetTarget {
                amount_minor: amount,
                category_id: self.category_id.clone(),
                month: self.month.clone(),
                carry: (!remove).then_some(self.carry),
                currency: Some(self.currency.clone()),
            },
            &key,
        );
        if settled.committed {
            self.finished = true;
            self.status = None;
        } else {
            self.status = Some(fold::refusal(ctx.locale(), &settled.refusal));
        }
    }

    fn data(&self, locale: Locale, answer: &wire::MoneyTargetSheet) -> wire::MoneyTargetData {
        let exponent = self.exponent();
        let minor = self.typed();
        let issue = if self.amount_text.trim().is_empty() || minor.is_some() {
            String::new()
        } else {
            words::amount_invalid(locale)
        };
        let stored = answer.amount.is_some() && self.seeded;
        wire::MoneyTargetData {
            title: fill(
                &words::target_title(locale),
                &[("category", &answer.category_label)],
            ),
            month_label: fold::month_label(locale, &answer.month),
            amount_label: words::target_amount_label(locale),
            currency_label: answer.currency.clone(),
            figures: vec![
                fold::figure(
                    &words::target_average(locale),
                    answer.six_month_average.as_ref(),
                    wire::status_chip::Tone::Neutral,
                ),
                fold::figure(
                    &words::target_spent(locale),
                    answer.spent.as_ref(),
                    wire::status_chip::Tone::Neutral,
                ),
                fold::figure(
                    &words::target_carried_in(locale),
                    answer.carry_in.as_ref(),
                    wire::status_chip::Tone::Neutral,
                ),
            ],
            use_average_label: words::target_use_average(locale),
            carry_label: words::target_carry(locale),
            carry_note: words::target_carry_note(locale),
            preview_label: fill(
                &words::target_preview(locale),
                &[(
                    "month",
                    &fold::month_label(locale, &fold::shift_month(&answer.month, 1)),
                )],
            ),
            preview: fold::text(answer.next_month_preview.as_ref()),
            preview_note: if self.carry {
                words::target_preview_carries(locale)
            } else {
                words::target_preview_nothing(locale)
            },
            save_label: words::target_save(locale),
            remove_label: if stored {
                words::target_remove(locale)
            } else {
                String::new()
            },
            can_save: minor.is_some() && issue.is_empty(),
            issue,
            exponent_hint: if exponent == 0 {
                words::whole_units(locale)
            } else {
                String::new()
            },
        }
    }

    fn event(&mut self, event: wire::MoneyTargetEvent, ctx: &Ctx) {
        match event.kind {
            // TYPING ASKS THE CORE FOR THE PREVIEW: the page's figures are the core's.
            Some(T::Amount(edited)) => {
                self.amount_text = edited.text;
                self.reload(ctx);
            }
            Some(T::Carry(_)) => {
                self.carry = !self.carry;
                self.reload(ctx);
            }
            Some(T::UseAverage(_)) => {
                if let Some(average) = self.phase.data().and_then(|a| a.six_month_average.clone()) {
                    self.amount_text = money_kit::amount_text(average.minor, average.exponent);
                    self.reload(ctx);
                }
            }
            Some(T::Save(_)) => self.save(ctx, false),
            Some(T::Remove(_)) => self.save(ctx, true),
            None => {}
        }
    }
}

impl Screen for Target {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyTarget(t)) => self.event(t, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_target_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied => Content::Denied(fold::denied(locale)),
            Phase::Ready(answer) => Content::Data(Box::new(self.data(locale, answer))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyTarget(
                wire::MoneyTargetState {
                    month: self.month.clone(),
                    category_id: self.category_id.clone(),
                    currency: self.currency.clone(),
                    content: Some(content),
                    amount_text: self.amount_text.clone(),
                    carry: self.carry,
                    chrome: Some(fold::chrome(locale, words::target_sheet_title(locale), "")),
                    status: self.status.clone(),
                    finished: self.finished,
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
