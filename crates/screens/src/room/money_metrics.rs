use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::money as reads;
use centraid_domain::read::{Args, Read, Reader};

use super::blocks::{self, Confirm};
use super::frame::room;
use super::money::{self, MONEY};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler};
use crate::strings::{Locale, fill, money as words, shared};
use serde_json::json;

pub const RECURRING: &str = "money/recurring";
pub const MATCH_ACCOUNTS: &str = "money/matches";
const MATCH_HANDS: &str = "money/matches/account";
const MATCH_CANDIDATES: &str = "money/matches/hand";
const MATCH_CONFIRM: &str = "money/matches/confirm";
const EN: Locale = Locale::En;

#[derive(Default)]
struct CursorPage {
    after: Option<String>,
    next: Option<String>,
    previous: Vec<Option<String>>,
}

impl CursorPage {
    fn args(&self, base: Args) -> Args {
        self.after
            .clone()
            .map_or(base.clone(), |after| base.after(after))
    }

    fn set_next(&mut self, next: Option<String>) {
        self.next = next;
    }

    fn next(&mut self) {
        if let Some(next) = self.next.take() {
            self.previous.push(self.after.clone());
            self.after = Some(next);
        }
    }

    fn previous(&mut self) {
        if let Some(after) = self.previous.pop() {
            self.after = after;
        }
    }
}

fn cursor_event(page: &mut CursorPage, tag: &str) {
    if tag == "page:next" {
        page.next();
    } else if tag == "page:previous" {
        page.previous();
    }
}

fn page_keys(
    mut frame: super::frame::Frame,
    b: &mut Build<'_>,
    page: &CursorPage,
) -> super::frame::Frame {
    if !page.previous.is_empty() {
        frame = frame.key(
            &mut b.sel,
            "page/previous",
            wire::RoomKeyRole::Tool,
            "ChevronLeft",
            &words::page_previous(EN),
            Handler::Tag("page:previous".to_owned()),
        );
    }
    if page.next.is_some() {
        frame = frame.key(
            &mut b.sel,
            "page/next",
            wire::RoomKeyRole::Tool,
            "ChevronRight",
            &words::page_next(EN),
            Handler::Tag("page:next".to_owned()),
        );
    }
    frame
}

pub(super) fn registry() -> Registry {
    Registry::new()
        .exact(RECURRING, || Box::new(RecurringRoom))
        .exact(MATCH_ACCOUNTS, || {
            Box::new(MatchAccountsRoom {
                page: CursorPage::default(),
            })
        })
        .with(Box::new(|key| {
            if let Some(rest) = key.strip_prefix("money/matches/confirm/") {
                let (hand, statement) = rest.split_once('/')?;
                return Some(Box::new(MatchConfirmRoom {
                    hand_id: hand.to_owned(),
                    statement_id: statement.to_owned(),
                }));
            }
            if let Some(hand) = key.strip_prefix("money/matches/hand/") {
                return Some(Box::new(MatchCandidatesRoom {
                    hand_id: hand.to_owned(),
                    page: CursorPage::default(),
                }));
            }
            if let Some(account) = key.strip_prefix("money/matches/account/") {
                return Some(Box::new(MatchHandsRoom {
                    account_id: account.to_owned(),
                    page: CursorPage::default(),
                }));
            }
            None
        }))
}

fn failed(
    b: &mut Build<'_>,
    kind: wire::RoomKind,
    key: &str,
    title: &str,
    back: &str,
) -> wire::Room {
    room(kind, key)
        .title(title)
        .back(&mut b.sel, back)
        .failed(&mut b.sel, &shared::read_failed(EN), &shared::kit_retry(EN))
        .build()
}

fn walk_pages<R: 'static>(
    reader: &Reader,
    read: &Read<R>,
    args: Args,
    mut consume: impl FnMut(&[R]) -> Result<(), String>,
) -> Result<(), String> {
    let base = args;
    let mut current = base.clone();
    loop {
        let answer = reader
            .run(read, &current)
            .map_err(|error| error.to_string())?;
        consume(&answer.rows)?;
        let Some(next) = answer.next else {
            return Ok(());
        };
        current = base.clone().after(next);
    }
}

struct RecurringRoom;

impl RoomScreen for RecurringRoom {
    fn key(&self) -> String {
        RECURRING.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        b.read(&reads::ACCOUNTS.decl);
        b.read(&reads::RECURRING_OBSERVATIONS.decl);
        let reader = match b.door.reader() {
            Ok(reader) => reader,
            Err(_) => {
                return failed(
                    b,
                    wire::RoomKind::PushedPage,
                    RECURRING,
                    &words::recurring_title(EN),
                    &words::title(EN),
                );
            }
        };
        let today = b.door.today();
        let from_day =
            centraid_domain::civil::shift_day(&today, -89).unwrap_or_else(|| today.clone());
        let mut candidates: Vec<(String, centraid_domain::apps::money::RecurringCandidate)> =
            Vec::new();
        let accounts = walk_pages(&reader, &reads::ACCOUNTS, Args::new(), |accounts| {
            for account in accounts {
                let mut accumulator = reads::RecurringAccumulator::default();
                walk_pages(
                    &reader,
                    &reads::RECURRING_OBSERVATIONS,
                    Args::new()
                        .text("account", &account.id)
                        .day("from_day", &from_day)
                        .day("to_day", &today),
                    |rows| {
                        accumulator.push_page(rows);
                        Ok(())
                    },
                )?;
                candidates.extend(
                    accumulator
                        .candidates()
                        .into_iter()
                        .map(|candidate| (account.title.clone(), candidate)),
                );
            }
            Ok(())
        });
        if accounts.is_err() {
            return failed(
                b,
                wire::RoomKind::PushedPage,
                RECURRING,
                &words::recurring_title(EN),
                &words::title(EN),
            );
        }
        candidates.sort_by(|(account_a, a), (account_b, b)| {
            (&a.normalized_payee, account_a, &a.currency, a.amount_minor).cmp(&(
                &b.normalized_payee,
                account_b,
                &b.currency,
                b.amount_minor,
            ))
        });
        let content = if candidates.is_empty() {
            vec![blocks::empty(
                blocks::glyph("Repeat", "app.money"),
                &words::recurring_empty_title(EN),
                &words::recurring_empty_body(EN),
                None,
            )]
        } else {
            let rows = candidates
                .iter()
                .enumerate()
                .map(|(index, (account, candidate))| {
                    let cadence = match candidate.cadence {
                        reads::RecurringCadence::Weekly => words::recurring_weekly(EN),
                        reads::RecurringCadence::Monthly => words::recurring_monthly(EN),
                    };
                    let payments = words::recurring_payments(EN, candidate.occurrences as u64);
                    let meta = fill(
                        &words::recurring_meta(EN),
                        &[
                            ("cadence", &cadence),
                            ("payments", &payments),
                            ("account", account),
                        ],
                    );
                    blocks::still_row(
                        &mut b.sel,
                        &format!("recurring/{index}"),
                        &candidate.display_payee,
                    )
                    .meta(&meta)
                    .trailing(
                        &money::fmt_minor(candidate.amount_minor, &candidate.currency),
                        wire::RoomTone::Neutral,
                    )
                    .into_block()
                })
                .collect::<Vec<_>>();
            vec![
                blocks::section(&mut b.sel, "section/recurring", &words::recurring_title(EN))
                    .blocks(rows)
                    .into_block(),
            ]
        };
        room(wire::RoomKind::PushedPage, RECURRING)
            .title(&words::recurring_title(EN))
            .back(&mut b.sel, &words::title(EN))
            .subtitle(&words::recurring_basis(EN))
            .ready(content)
            .band(money::money_band(&mut b.sel, MONEY))
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(outcome) = money::handle_band_nav(tag) {
            return outcome;
        }
        Outcome::default()
    }
}

struct MatchAccountsRoom {
    page: CursorPage,
}

impl RoomScreen for MatchAccountsRoom {
    fn key(&self) -> String {
        MATCH_ACCOUNTS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let accounts = match b.run(&reads::ACCOUNTS, &self.page.args(Args::new())) {
            Ok(answer) => answer,
            Err(_) => {
                return failed(
                    b,
                    wire::RoomKind::PushedPage,
                    MATCH_ACCOUNTS,
                    &words::match_accounts_title(EN),
                    &words::title(EN),
                );
            }
        };
        self.page.set_next(accounts.next.clone());
        let content = if accounts.rows.is_empty() {
            vec![blocks::empty(
                blocks::glyph("Coin", "app.money"),
                &words::match_accounts_empty_title(EN),
                &words::match_accounts_empty_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "account/add",
                    &words::more_accounts(EN),
                    "Wallet",
                    Handler::Open(money::NEW_ACCOUNT.to_owned()),
                )),
            )]
        } else {
            let rows = accounts
                .rows
                .iter()
                .map(|account| {
                    blocks::row(
                        &mut b.sel,
                        &format!("account/{}", account.id),
                        &account.title,
                        Handler::Open(format!("{MATCH_HANDS}/{}", account.id)),
                    )
                    .meta(&account.currency)
                    .into_block()
                })
                .collect::<Vec<_>>();
            let section = blocks::section(
                &mut b.sel,
                "section/accounts",
                &words::match_accounts_title(EN),
            )
            .blocks(rows);
            vec![section.into_block()]
        };
        let frame = page_keys(
            room(wire::RoomKind::PushedPage, MATCH_ACCOUNTS),
            b,
            &self.page,
        )
        .title(&words::match_accounts_title(EN))
        .back(&mut b.sel, &words::title(EN))
        .band(money::money_band(&mut b.sel, MONEY));
        frame.ready(content).build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(outcome) = money::handle_band_nav(tag) {
            return outcome;
        }
        cursor_event(&mut self.page, tag);
        Outcome::default()
    }
}

struct MatchHandsRoom {
    account_id: String,
    page: CursorPage,
}

impl RoomScreen for MatchHandsRoom {
    fn key(&self) -> String {
        format!("{MATCH_HANDS}/{}", self.account_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let account = match b.run(
            &reads::ACCOUNT_BY_ID,
            &Args::new().text("id", &self.account_id),
        ) {
            Ok(answer) => match answer.rows.into_iter().next() {
                Some(account) => account,
                None => {
                    return failed(
                        b,
                        wire::RoomKind::PushedPage,
                        &self.key(),
                        &words::match_title(EN),
                        &words::match_accounts_title(EN),
                    );
                }
            },
            Err(_) => {
                return failed(
                    b,
                    wire::RoomKind::PushedPage,
                    &self.key(),
                    &words::match_title(EN),
                    &words::match_accounts_title(EN),
                );
            }
        };
        let proposals = match b.run(
            &reads::MATCH_PROPOSALS,
            &self.page.args(
                Args::new()
                    .text("account", &self.account_id)
                    .int("days", centraid_vault::commands::txn::MATCH_DAYS),
            ),
        ) {
            Ok(answer) => answer,
            Err(_) => {
                return failed(
                    b,
                    wire::RoomKind::PushedPage,
                    &self.key(),
                    &words::match_title(EN),
                    &words::match_accounts_title(EN),
                );
            }
        };
        self.page.set_next(proposals.next.clone());
        let content = if proposals.rows.is_empty() {
            vec![blocks::empty(
                blocks::glyph("Repeat", "app.money"),
                &words::match_empty_title(EN),
                &words::match_empty_body(EN),
                None,
            )]
        } else {
            let rows = proposals
                .rows
                .iter()
                .map(|proposal| {
                    let meta = fill(&words::match_hand_meta(EN), &[("day", &proposal.hand_day)]);
                    blocks::row(
                        &mut b.sel,
                        &format!("hand/{}", proposal.hand_id),
                        &proposal.hand_title,
                        Handler::Open(format!("{MATCH_CANDIDATES}/{}", proposal.hand_id)),
                    )
                    .meta(&meta)
                    .trailing(
                        &money::fmt_minor(proposal.amount_minor, &proposal.currency),
                        wire::RoomTone::Neutral,
                    )
                    .into_block()
                })
                .collect::<Vec<_>>();
            let section = blocks::section(&mut b.sel, "section/proposals", &words::match_title(EN))
                .blocks(rows);
            vec![section.into_block()]
        };
        let frame = page_keys(room(wire::RoomKind::PushedPage, &self.key()), b, &self.page)
            .title(&words::match_title(EN))
            .subtitle(&account.title)
            .back(&mut b.sel, &words::match_accounts_title(EN));
        frame.ready(content).build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        cursor_event(&mut self.page, tag);
        Outcome::default()
    }
}

struct MatchCandidatesRoom {
    hand_id: String,
    page: CursorPage,
}

impl RoomScreen for MatchCandidatesRoom {
    fn key(&self) -> String {
        format!("{MATCH_CANDIDATES}/{}", self.hand_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let hand = match b.run(&reads::TXN_BY_ID, &Args::new().text("id", &self.hand_id)) {
            Ok(answer) => match answer.rows.into_iter().next() {
                Some(hand) if hand.entered == "hand" => hand,
                _ => {
                    return failed(
                        b,
                        wire::RoomKind::PushedPage,
                        &self.key(),
                        &words::match_candidates_title(EN),
                        &words::match_title(EN),
                    );
                }
            },
            Err(_) => {
                return failed(
                    b,
                    wire::RoomKind::PushedPage,
                    &self.key(),
                    &words::match_candidates_title(EN),
                    &words::match_title(EN),
                );
            }
        };
        let candidates = match b.run(
            &reads::MATCH_CANDIDATES,
            &self.page.args(
                Args::new()
                    .text("hand", &self.hand_id)
                    .int("days", centraid_vault::commands::txn::MATCH_DAYS),
            ),
        ) {
            Ok(answer) => answer,
            Err(_) => {
                return failed(
                    b,
                    wire::RoomKind::PushedPage,
                    &self.key(),
                    &words::match_candidates_title(EN),
                    &words::match_title(EN),
                );
            }
        };
        self.page.set_next(candidates.next.clone());
        let content = if candidates.rows.is_empty() {
            vec![blocks::empty(
                blocks::glyph("Repeat", "app.money"),
                &words::match_candidates_empty_title(EN),
                &words::match_candidates_empty_body(EN),
                None,
            )]
        } else {
            let hand_meta = fill(&words::match_hand_meta(EN), &[("day", &hand.posted_on)]);
            let mut rows = vec![
                blocks::still_row(&mut b.sel, "hand/selected", &hand.title)
                    .meta(&hand_meta)
                    .trailing(
                        &money::fmt_minor(hand.amount_minor, &hand.currency),
                        wire::RoomTone::Neutral,
                    )
                    .into_block(),
            ];
            rows.extend(candidates.rows.iter().map(|candidate| {
                let meta = fill(
                    &words::match_statement_meta(EN),
                    &[("day", &candidate.statement_day)],
                );
                blocks::row(
                    &mut b.sel,
                    &format!("candidate/{}", candidate.statement_id),
                    &candidate.statement_title,
                    Handler::Open(format!(
                        "{MATCH_CONFIRM}/{}/{}",
                        self.hand_id, candidate.statement_id
                    )),
                )
                .meta(&meta)
                .into_block()
            }));
            let section = blocks::section(
                &mut b.sel,
                "section/candidates",
                &words::match_candidates_title(EN),
            )
            .blocks(rows);
            vec![section.into_block()]
        };
        let frame = page_keys(room(wire::RoomKind::PushedPage, &self.key()), b, &self.page)
            .title(&words::match_candidates_title(EN))
            .back(&mut b.sel, &words::match_title(EN));
        frame.ready(content).build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        cursor_event(&mut self.page, tag);
        Outcome::default()
    }
}

struct MatchConfirmRoom {
    hand_id: String,
    statement_id: String,
}

impl MatchConfirmRoom {
    fn pair(&self, b: &mut Build<'_>) -> Result<(reads::TxnDetail, reads::TxnDetail), ()> {
        let hand = b
            .run(&reads::TXN_BY_ID, &Args::new().text("id", &self.hand_id))
            .map_err(|_| ())?
            .rows
            .into_iter()
            .next()
            .filter(|row| row.entered == "hand")
            .ok_or(())?;
        let statement = b
            .run(
                &reads::TXN_BY_ID,
                &Args::new().text("id", &self.statement_id),
            )
            .map_err(|_| ())?
            .rows
            .into_iter()
            .next()
            .filter(|row| row.entered == "statement")
            .ok_or(())?;
        if hand.account_id != statement.account_id
            || hand.currency != statement.currency
            || hand.amount_minor != statement.amount_minor
        {
            return Err(());
        }
        let reader = b.door.reader().map_err(|_| ())?;
        b.read(&reads::MATCH_CANDIDATES.decl);
        let mut found = false;
        walk_pages(
            &reader,
            &reads::MATCH_CANDIDATES,
            Args::new()
                .text("hand", &self.hand_id)
                .int("days", centraid_vault::commands::txn::MATCH_DAYS),
            |rows| {
                found |= rows.iter().any(|row| row.statement_id == self.statement_id);
                Ok(())
            },
        )
        .map_err(|_| ())?;
        if !found {
            return Err(());
        }
        Ok((hand, statement))
    }
}

impl RoomScreen for MatchConfirmRoom {
    fn key(&self) -> String {
        format!("{MATCH_CONFIRM}/{}/{}", self.hand_id, self.statement_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let (hand, statement) = match self.pair(b) {
            Ok(pair) => pair,
            Err(()) => {
                return failed(
                    b,
                    wire::RoomKind::Sheet,
                    &self.key(),
                    &words::match_review_title(EN),
                    &words::match_candidates_title(EN),
                );
            }
        };
        let hand_meta = fill(&words::match_hand_meta(EN), &[("day", &hand.posted_on)]);
        let statement_meta = fill(
            &words::match_statement_meta(EN),
            &[("day", &statement.posted_on)],
        );
        let details = vec![
            blocks::still_row(&mut b.sel, "hand", &hand.title)
                .meta(&hand_meta)
                .trailing(
                    &money::fmt_minor(hand.amount_minor, &hand.currency),
                    wire::RoomTone::Neutral,
                )
                .into_block(),
            blocks::still_row(&mut b.sel, "statement", &statement.title)
                .meta(&statement_meta)
                .trailing(
                    &money::fmt_minor(statement.amount_minor, &statement.currency),
                    wire::RoomTone::Neutral,
                )
                .into_block(),
        ];
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::match_review_title(EN),
                body: &words::match_review_body(EN),
                warning: "",
                confirm_label: &words::match_confirm(EN),
                confirm: Handler::Tag("match:confirm".to_owned()),
                cancel_label: &words::match_dismiss(EN),
                cancel: Handler::Tag("match:dismiss".to_owned()),
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::match_review_title(EN))
            .ready(vec![
                blocks::section(&mut b.sel, "section/pair", "")
                    .blocks(details)
                    .into_block(),
                confirm,
            ])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        let (command, sentence) = match tag {
            "match:confirm" => ("txn.confirm_match", words::match_confirmed(EN)),
            "match:dismiss" => ("txn.dismiss_match", words::match_dismissed(EN)),
            _ => return Outcome::default(),
        };
        let action = Act::new(
            command,
            json!({"hand_id": self.hand_id, "statement_id": self.statement_id}),
        );
        match e.door.act(&action) {
            Ok(done) => Outcome {
                nav: super::screen::Nav::Pop,
                status: Some(super::screen::Status {
                    sentence,
                    undo: done.undo,
                    refused: false,
                }),
                ..Outcome::default()
            },
            Err(refused) => Outcome::refuse(&refused.0),
        }
    }
}
