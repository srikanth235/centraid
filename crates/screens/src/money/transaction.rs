//! ONE TRANSACTION (`money.transaction`): what the bank said never changes; the
//! category and the name are the member's decisions, layered on top. The page
//! draws what the core derived and offers four acts: file it, name it, move it to
//! the trash, and take back a transfer. A transfer and a rule are PROPOSED by the app and
//! written only when the member accepts.
//!
//! MOVE TO TRASH (#1185) is the member's way to remove a line, and it replaces the final void: it asks
//! nothing (the status line says what happened with Undo, and the trash restores it for 30 days), the
//! line leaves every balance, total, recurring charge and search result, and the bank's own words are
//! untouched. The page stays open on the gone state so the line shows.

use centraid_api_proto::core_v1 as wire;
use wire::MoneyFlag as Flag;
use wire::money_transaction_event::Kind as T;
use wire::money_transaction_state::Sheet;
use wire::screen_event::Kind as E;
use wire::status_chip::Tone;

use super::fold::{self, Phase};
use super::rows;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::earlier;
use crate::kit::links::{self, Kind, Links, Outcome};
use crate::kit::read::{self, Reading};
use crate::kit::share::{self, Share};
use crate::kit::trash;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, links as link_words, money as words, shared};

const ACTION_CATEGORY: &str = "category";
const ACTION_NAME: &str = "name";
const ACTION_UNLINK: &str = "unlink";
/// Move the line to the trash (#1185).
const ACTION_TRASH: &str = "trash";
/// Hand the line to the OS share sheet as a spreadsheet file (#1185): the shells draw every action
/// row and send its key, so the row needs no shell code of its own.
const ACTION_SHARE: &str = "share";
/// The "With" row (#1173): who the line was with, picked by name.
const ACTION_WITH: &str = "with";
const OFFER_TRANSFER: &str = "transfer";
const OFFER_RULE: &str = "rule";
const OFFER_WITH: &str = "with";

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::MoneyTransaction(args)) = &route.args else {
        return None;
    };
    if args.txn_id.is_empty() {
        return None;
    }
    Some(Box::new(Transaction {
        txn_id: args.txn_id.clone(),
        parent: args.parent.clone(),
        phase: Phase::Loading,
        sheet: Sheet::None,
        name_draft: String::new(),
        undo: Undo::default(),
        dismissed: Vec::new(),
        links: Links::new(&[Kind::Person]),
        earlier: earlier::Foot::default(),
        share: Share::default(),
    }))
}

struct Loaded {
    txn: wire::MoneyTransaction,
    categories: wire::MoneyCategories,
    /// The people the line was with (`people.links`).
    with: Vec<wire::PeopleLinked>,
    /// The person the payee names, PROPOSED and never written until the member confirms.
    with_proposal: Option<links::Person>,
}

struct Transaction {
    txn_id: String,
    parent: String,
    phase: Phase<Loaded>,
    sheet: Sheet,
    name_draft: String,
    /// The status line and what its Undo reverses (the kit's one door).
    undo: Undo,
    /// Offers the member waved off this sitting: `transfer`, `rule`, `with`.
    dismissed: Vec<String>,
    /// The "With" row's picker and the people it lists.
    links: Links,
    /// The entry to the line's earlier versions, read with the page (#1185).
    earlier: earlier::Foot,
    /// The line handed to the OS share sheet as a spreadsheet file (#1185).
    share: Share,
}

impl Transaction {
    fn reload(&mut self, ctx: &Ctx) {
        use wire::app_query_response::Answer;
        let txn = read::read(
            ctx,
            load::money::Transaction {
                txn_id: self.txn_id.clone(),
            },
            |a| match a {
                Answer::MoneyTransaction(x) => Some(x),
                _ => None,
            },
        );
        let categories = read::read(ctx, load::money::Categories {}, |a| match a {
            Answer::MoneyCategories(x) => Some(x),
            _ => None,
        });
        let with = links::read_people(ctx, &self.txn_id);
        self.phase = match (txn, categories, with) {
            (Reading::Data(txn), Reading::Data(categories), Reading::Data(with)) if txn.found => {
                let linked: Vec<String> = with.iter().map(|p| p.party_id.clone()).collect();
                let voided = txn.flags.contains(&(Flag::Void as i32));
                let with_proposal = if voided || !linked.is_empty() {
                    None
                } else {
                    let people = self.links.people(ctx);
                    links::propose(&[&txn.display_name, &txn.raw], people, &linked).cloned()
                };
                Phase::Ready(Loaded {
                    txn,
                    categories,
                    with,
                    with_proposal,
                })
            }
            (Reading::Denied(_), _, _) => Phase::Denied,
            _ => Phase::Failed,
        };
        self.earlier = match &self.phase {
            Phase::Ready(loaded) => {
                earlier::foot(ctx, super::EARLIER, &self.txn_id, &loaded.txn.display_name)
            }
            _ => earlier::Foot::default(),
        };
    }

    /// The ids of the people the line is with now.
    fn with_ids(&self) -> Vec<String> {
        self.phase
            .data()
            .map(|loaded| loaded.with.iter().map(|p| p.party_id.clone()).collect())
            .unwrap_or_default()
    }

    /// One event of the "With" picker. Nothing is written until a person is picked or confirmed.
    fn link_event(&mut self, event: &wire::LinkEvent, ctx: &Ctx) {
        let linked = self.with_ids();
        match self.links.update(event, &linked, ctx) {
            Outcome::Add { id, .. } => self.set_with(ctx, &id, true),
            Outcome::Remove { id } => self.set_with(ctx, &id, false),
            Outcome::Moved => {}
        }
    }

    /// Put a person on the line, or take them off.
    fn set_with(&mut self, ctx: &Ctx, person_id: &str, on: bool) {
        let from = self.txn_id.clone();
        let to = person_id.to_owned();
        if on {
            self.submit(
                ctx,
                act::money::AddWith {
                    from,
                    rel: act::money::AddWithRel::With,
                    to,
                    ..Default::default()
                },
                link_words::saved(ctx.locale()),
            );
        } else {
            self.submit(
                ctx,
                act::money::RemoveWith {
                    from,
                    rel: act::money::RemoveWithRel::With,
                    to,
                    ..Default::default()
                },
                link_words::removed(ctx.locale()),
            );
        }
    }

    fn dismiss(&mut self, key: &str) {
        if !self.dismissed.iter().any(|k| k == key) {
            self.dismissed.push(key.to_owned());
        }
    }

    /// Submit one write and read again; the verdict is the status line.
    fn submit(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, done: String) {
        let key = kit_act::key(&["money", "txn", &self.txn_id], kit_act::fresh());
        self.undo.act(ctx, request, &key, |_| done);
        self.reload(ctx);
    }

    /// MOVE TO TRASH: the title the status line names is the line's own, as its page shows it.
    fn trash_line(&mut self, ctx: &Ctx) {
        let Some(loaded) = self.phase.data() else {
            return;
        };
        let title = if loaded.txn.display_name.is_empty() {
            loaded.txn.raw.clone()
        } else {
            loaded.txn.display_name.clone()
        };
        let id = self.txn_id.clone();
        let key = kit_act::key(&["trash-transaction", &id], kit_act::fresh());
        self.undo.act(
            ctx,
            act::money::TrashTransaction { transaction_id: id },
            &key,
            |locale| trash::moved_to_trash(locale, &title),
        );
        self.reload(ctx);
    }

    fn action(&mut self, key: &str, ctx: &Ctx) {
        match key {
            ACTION_CATEGORY => self.sheet = Sheet::Category,
            ACTION_NAME => {
                self.name_draft = self
                    .phase
                    .data()
                    .map(|l| l.txn.display_name.clone())
                    .unwrap_or_default();
                self.sheet = Sheet::Name;
            }
            ACTION_UNLINK => self.submit(
                ctx,
                act::money::UnlinkTransfer {
                    transaction_id: self.txn_id.clone(),
                },
                words::done_unlinked(ctx.locale()),
            ),
            ACTION_TRASH => self.trash_line(ctx),
            ACTION_WITH => {
                let linked = self.with_ids();
                let open = wire::LinkEvent {
                    kind: Some(wire::link_event::Kind::Add(wire::link_event::AddTapped {
                        key: Kind::Person.key().to_owned(),
                    })),
                };
                self.links.update(&open, &linked, ctx);
            }
            _ => {}
        }
    }

    fn accept(&mut self, key: &str, ctx: &Ctx) {
        let Some(loaded) = self.phase.data() else {
            return;
        };
        let locale = ctx.locale();
        match key {
            OFFER_TRANSFER => {
                let Some(offer) = loaded.txn.transfer_proposal.clone() else {
                    return;
                };
                self.submit(
                    ctx,
                    act::money::LinkTransfer {
                        transaction_id: self.txn_id.clone(),
                        other_id: offer.other_txn_id,
                    },
                    words::done_linked(locale),
                );
            }
            OFFER_WITH => {
                let Some(person) = loaded.with_proposal.clone() else {
                    return;
                };
                self.set_with(ctx, &person.id, true);
            }
            OFFER_RULE => {
                let Some(offer) = loaded.txn.rule_proposal.clone() else {
                    return;
                };
                let kind = match fold::match_kind_key(offer.kind) {
                    "is" => act::money::AddRuleMatch::Is,
                    "matches" => act::money::AddRuleMatch::Matches,
                    _ => act::money::AddRuleMatch::Contains,
                };
                self.submit(
                    ctx,
                    act::money::AddRule {
                        category_id: offer.category_id,
                        r#match: kind,
                        text: offer.pattern,
                        ..Default::default()
                    },
                    words::done_rule(locale),
                );
            }
            _ => {}
        }
    }

    fn event(&mut self, event: wire::MoneyTransactionEvent, ctx: &Ctx) {
        let locale = ctx.locale();
        match event.kind {
            Some(T::Action(picked)) => self.action(&picked.key, ctx),
            Some(T::Category(picked)) => {
                self.sheet = Sheet::None;
                self.submit(
                    ctx,
                    act::money::Categorize {
                        ids: serde_json::json!([self.txn_id]).to_string(),
                        category_id: (!picked.category_id.is_empty()).then_some(picked.category_id),
                    },
                    words::done_category(locale),
                );
            }
            Some(T::NameEdited(edited)) => self.name_draft = edited.text,
            Some(T::NameSaved(_)) => {
                // A cleared name goes back to the bank's own words.
                let raw = self
                    .phase
                    .data()
                    .map(|l| l.txn.raw.clone())
                    .unwrap_or_default();
                let text = match self.name_draft.trim() {
                    "" => raw,
                    typed => typed.to_owned(),
                };
                self.sheet = Sheet::None;
                if !text.is_empty() {
                    self.submit(
                        ctx,
                        act::money::SetDisplayName {
                            transaction_id: self.txn_id.clone(),
                            title: text,
                        },
                        words::done_name(locale),
                    );
                }
            }
            Some(T::SheetClosed(_)) => self.sheet = Sheet::None,
            Some(T::OfferAccepted(accepted)) => self.accept(&accepted.key, ctx),
            Some(T::OfferDismissed(dismissed)) => self.dismiss(&dismissed.key),
            Some(T::WithLink(link)) => self.link_event(&link, ctx),
            Some(T::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            _ => {}
        }
    }

    fn data(&self, locale: Locale, loaded: &Loaded) -> wire::MoneyTransactionData {
        let answer = &loaded.txn;
        let flags = &answer.flags;
        let voided = flags.contains(&(Flag::Void as i32));
        let is_transfer = flags.contains(&(Flag::Transfer as i32));
        let struck = voided || is_transfer;
        let minor = answer.amount.as_ref().map_or(0, |a| a.minor);
        let fact = |label: String, detail: String| wire::MoneyFact {
            label,
            detail,
            ..Default::default()
        };
        let mut facts = vec![
            fact(words::fact_account(locale), answer.account_label.clone()),
            fact(
                words::fact_posted(locale),
                super::fold::day_short(locale, &answer.posted_on),
            ),
            fact(words::fact_bank_wrote(locale), answer.raw.clone()),
            // CATEGORY AND NAME ARE THE FACTS A MEMBER CHANGES: each names its
            // action, and a category still to supply is owed attention (seam).
            wire::MoneyFact {
                label: words::fact_category(locale),
                detail: answer
                    .category_label
                    .clone()
                    .unwrap_or_else(|| words::no_category(locale)),
                action: ACTION_CATEGORY.to_owned(),
                tone: if answer.category_label.is_none() {
                    Tone::Seam
                } else {
                    Tone::Unspecified
                } as i32,
            },
            wire::MoneyFact {
                label: words::fact_name(locale),
                detail: if answer.display_name_source.as_deref() == Some("member") {
                    format!("{} · {}", answer.display_name, words::from_you(locale))
                } else {
                    answer.display_name.clone()
                },
                action: ACTION_NAME.to_owned(),
                ..Default::default()
            },
            // WHO THE LINE WAS WITH is a fact the member changes, like the category (#1173).
            wire::MoneyFact {
                label: link_words::section_with(locale),
                detail: links::names(locale, &loaded.with),
                action: ACTION_WITH.to_owned(),
                ..Default::default()
            },
        ];
        for (label, value) in [
            (words::fact_memo(locale), &answer.memo),
            (words::fact_check(locale), &answer.check_number),
            (words::fact_bank_type(locale), &answer.bank_type),
        ] {
            if let Some(value) = value.as_ref().filter(|v| !v.trim().is_empty()) {
                facts.push(fact(label, value.clone()));
            }
        }
        let transfer_offer = answer
            .transfer_proposal
            .as_ref()
            .filter(|_| !self.dismissed.iter().any(|k| k == OFFER_TRANSFER))
            .map(|offer| wire::MoneyOffer {
                key: OFFER_TRANSFER.to_owned(),
                title: words::transfer_offer_title(locale),
                body: fill(
                    &words::transfer_offer_body(locale),
                    &[
                        ("account", &offer.other_account_label),
                        ("day", &fold::day_short(locale, &offer.other_posted_on)),
                    ],
                ),
                detail: offer.other_description.clone(),
                accept_label: words::transfer_accept(locale),
                dismiss_label: words::not_now(locale),
            });
        let rule_offer = answer
            .rule_proposal
            .as_ref()
            .filter(|_| !self.dismissed.iter().any(|k| k == OFFER_RULE))
            .map(|offer| wire::MoneyOffer {
                key: OFFER_RULE.to_owned(),
                title: words::rule_offer_title(locale),
                body: fill(
                    &words::rule_offer_body(locale),
                    &[
                        ("support", &offer.support.to_string()),
                        ("of", &offer.of.to_string()),
                        ("name", &answer.display_name),
                        ("category", &offer.category_label),
                    ],
                ),
                detail: format!(
                    "{} {}",
                    fold::match_kind_word(locale, offer.kind),
                    offer.pattern
                ),
                accept_label: words::rule_accept(locale),
                dismiss_label: words::not_now(locale),
            });
        let with_offer = loaded
            .with_proposal
            .as_ref()
            .filter(|_| !self.dismissed.iter().any(|k| k == OFFER_WITH))
            .map(|person| links::offer(locale, &person.name));
        let mut notes = Vec::new();
        if answer.seen_times > 1 {
            notes.push(fold::with_n(words::seen_times(locale), answer.seen_times));
        }
        if let Some(recurring) = &answer.recurring {
            notes.push(fill(
                &words::repeats(locale),
                &[("cadence", &fold::cadence_words(locale, recurring.cadence))],
            ));
        }
        if !answer.applied_rule_ids.is_empty() {
            notes.push(words::named_by_rule(locale));
        }
        let action = |key: &str, label: String, icon: &str, enabled: bool, destructive: bool| {
            wire::MoneyAction {
                key: key.to_owned(),
                label,
                icon_key: icon.to_owned(),
                enabled,
                destructive,
            }
        };
        let mut actions = vec![
            action(
                ACTION_CATEGORY,
                words::action_category(locale),
                "Tag",
                !voided,
                false,
            ),
            action(
                ACTION_NAME,
                words::action_name(locale),
                "Pencil",
                !voided,
                false,
            ),
        ];
        actions.push(action(
            ACTION_WITH,
            link_words::section_with(locale),
            "Users",
            !voided,
            false,
        ));
        if answer.transferred_with.is_some() {
            actions.push(action(
                ACTION_UNLINK,
                words::action_unlink(locale),
                "SwitchVert",
                true,
                false,
            ));
        }
        actions.push(action(
            ACTION_SHARE,
            share::label(locale),
            share::ICON,
            true,
            false,
        ));
        actions.push(action(
            ACTION_TRASH,
            shared::trash_move(locale),
            "Trash",
            true,
            true,
        ));
        let mut category_options = vec![fold::choice(
            "",
            &words::no_category(locale),
            answer.category_id.is_none(),
            "",
        )];
        for group in &loaded.categories.groups {
            for category in group
                .categories
                .iter()
                .filter(|c| !c.archived || Some(&c.category_id) == answer.category_id.as_ref())
            {
                category_options.push(fold::category_choice(
                    &category.category_id,
                    &category.label,
                    Some(&category.category_id) == answer.category_id.as_ref(),
                    &group.label,
                ));
            }
        }
        wire::MoneyTransactionData {
            title: if answer.display_name.is_empty() {
                answer.raw.clone()
            } else {
                answer.display_name.clone()
            },
            amount: fold::text(answer.amount.as_ref()),
            // Money out is ink, not red: red is a state. Money in is green.
            amount_tone: if struck { Tone::Seam } else { Tone::Neutral } as i32,
            amount_positive: !struck && answer.amount.as_ref().is_some_and(|a| a.minor > 0),
            direction_label: if minor < 0 {
                words::money_out(locale)
            } else {
                words::money_in(locale)
            },
            facts,
            chips: rows::chips(locale, flags, answer.category_id.is_some()),
            transfer_offer,
            rule_offer,
            with_offer,
            notes,
            actions,
            category_options,
            category_sheet_title: words::category_sheet_title(locale),
            name_sheet_title: words::name_sheet_title(locale),
            name_placeholder: words::name_placeholder(locale),
            save_label: words::save(locale),
            clear_label: words::clear(locale),
            accessibility_label: [
                answer.display_name.clone(),
                super::fold::day_short(locale, &answer.posted_on),
                answer.account_label.clone(),
            ]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        }
    }
}

impl Screen for Transaction {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::MoneyTransaction(wire::MoneyTransactionEvent {
                kind: Some(wire::money_transaction_event::Kind::Refreshed(_)),
            })) => self.reload(ctx),
            Some(E::MoneyTransaction(wire::MoneyTransactionEvent {
                kind: Some(T::Action(picked)),
            })) if picked.key == ACTION_SHARE => return self.share.tap(ctx.locale()),
            Some(E::MoneyTransaction(t)) => self.event(t, ctx),
            // THE SHELL'S ANSWER to the owner check or the share sheet.
            Some(E::EffectResult(result)) => {
                let id = self.txn_id.clone();
                return self.share.result(ctx, &result, |ctx| {
                    super::export::file(ctx, None, Some(&id))
                });
            }
            Some(E::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(E::Left(_)) => {
                self.undo.clear();
                return self.share.left();
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::money_transaction_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            // The member just moved the line to the trash from this page: it reads as gone, and the
            // status line (with Undo) shows over it. A line that was never here stays a failure.
            Phase::Failed if self.undo.can_undo() => Content::Gone(wire::EmptyState {
                headline: words::transaction_gone(locale),
                ..Default::default()
            }),
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied => Content::Denied(fold::denied(locale)),
            Phase::Ready(loaded) => Content::Data(Box::new(self.data(locale, loaded))),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::MoneyTransaction(
                wire::MoneyTransactionState {
                    txn_id: self.txn_id.clone(),
                    content: Some(content),
                    sheet: self.sheet as i32,
                    with_picker: Some(self.links.picker(locale, &self.with_ids())),
                    name_draft: self.name_draft.clone(),
                    chrome: Some(fold::chrome(
                        locale,
                        words::transaction_title(locale),
                        &self.parent,
                    )),
                    status: self
                        .undo
                        .status()
                        .or_else(|| self.share.status())
                        .or_else(|| self.earlier.status(locale)),
                    earlier: self.earlier.entry.clone(),
                    origin: self.earlier.origin.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
