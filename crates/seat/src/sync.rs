//! The sync loop: drain pages, drain the outbox, settle.
//!
//! ## Why this is here and not in the simulation (D-1020-D2-10)
//!
//! The simulation is #1020's primary sync proof, and a proof of a sync loop
//! that only exists inside the test is a proof of nothing. So the loop is
//! production code in this crate, written over two traits, and `crates/sim`
//! implements them over turmoil while a real seat implements them over
//! `crates/net`. The alternative — a driver in the test crate — would have made
//! every simulation bug a bug in code no phone runs.
//!
//! ## The driver is async; `Handle::call` is not (D-1020-D2-12)
//!
//! These two facts are separate and were briefly conflated. A sync *pass* is
//! network I/O — fetch a page, wait, submit an intent, wait — so [`pass`] is
//! `async` and the two traits below return futures. [`centraid_core`]'s `call`
//! is synchronous because a *shell* asking one question wants one answer and
//! should not need a runtime in Swift.
//!
//! The SQLite work between the awaits stays synchronous, which is correct: an
//! apply is one transaction per commit and there is nothing to await inside
//! one. So a pass is `await`, work, `await`, work — and the applier never
//! holds a transaction across an await point, which is the rule that keeps a
//! cancelled future from leaving one open.
//!
//! ## Two traits, not one
//!
//! [`LogSource`] and [`IntentSink`] are separate because they fail
//! independently and the remedies differ. A seat whose log source is down is
//! *stale*: it shows what it has and says how far behind it is. A seat whose
//! intent sink is down is *blocked*: its writes are queued and the badge says
//! so. Collapsing them into one "connection" trait makes those the same state,
//! and they are the two most different states a seat has.
//!
//! ## The loop's order is the contract
//!
//! 1. **Drain the inbound log first.** An intent's answer settles against a
//!    commit seq, so a seat that submitted before applying would hold an
//!    `awaiting-change` overlay it could have cleared this pass.
//! 2. **Then submit.** One intent at a time, in outbox order, skipping the ones
//!    a hold blocks.
//! 3. **Then apply the answers**, which parks the executed ones at
//!    `awaiting-change`.
//! 4. **Then drain the log again**, because step 2's own effects are now in it.
//!
//! Step 4 is not a nicety: without it an intent submitted and executed in this
//! pass waits a whole poll interval before its overlay clears, which is the
//! "it didn't save" flicker seen from the other side.

use std::future::Future;

use rusqlite::Connection;

use crate::applier::{ApplyHooks, PageHeader, apply_page};
use crate::error::{Result, SeatError};
use crate::intent::{IntentRecord, IntentState};
use crate::outbox::Outbox;
use crate::settlement::{Answer, apply_intent_outcomes, settle_at_commit_seq};
use crate::state::seat_state;

/// One page of the log, as a source hands it over.
#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub header: PageHeader,
    pub rows: Vec<centraid_vault::log::LogRow>,
    pub has_more: bool,
    /// Where to ask from next: the last served seq when `has_more`, else the
    /// watermark.
    pub next: i64,
}

/// What a source says instead of a page.
#[derive(Debug, Clone)]
pub enum FetchOutcome {
    Page(FetchedPage),
    /// The cursor cannot be served from. **A response, not an error**: the seat
    /// is being told what to do next.
    RebootstrapRequired {
        reason: centraid_vault::RebootstrapReason,
        epoch: String,
        floor: i64,
        watermark: i64,
    },
    /// The source is not reachable. The seat is *stale*, not broken.
    Unavailable(String),
}

/// Where a seat gets log pages.
///
/// The future is boxed so the trait is `dyn`-compatible: [`pass`] takes
/// `&mut dyn LogSource`, because a seat picks its transport once at startup and
/// a generic parameter would push that choice into every caller's signature.
pub trait LogSource {
    /// One page from `since`, at most `limit` rows.
    fn fetch<'a>(
        &'a mut self,
        epoch: &'a str,
        since: i64,
        limit: i64,
    ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>>;
}

/// What a sink says about one intent.
#[derive(Debug, Clone)]
pub enum SubmitOutcome {
    /// The gateway answered.
    Answered(Answer),
    /// The sink is not reachable. The intent stays queued and its attempt count
    /// rises, which is what the backoff reads.
    Unavailable(String),
}

/// Where a seat submits intents.
pub trait IntentSink {
    fn submit<'a>(
        &'a mut self,
        record: &'a IntentRecord,
    ) -> std::pin::Pin<Box<dyn Future<Output = SubmitOutcome> + 'a>>;
}

/// What one pass did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PassReport {
    pub rows_applied: usize,
    pub rows_duplicate: usize,
    pub commits_applied: usize,
    pub pages_fetched: usize,
    pub intents_submitted: usize,
    pub intents_settled: usize,
    /// Intents whose overlay cleared because the cursor reached their commit.
    pub overlays_cleared: Vec<String>,
    /// The seat was told to re-bootstrap, and the reason.
    pub rebootstrap: Option<centraid_vault::RebootstrapReason>,
    /// The log source was unreachable this pass: the seat is stale.
    pub stale: Option<String>,
    /// The intent sink was unreachable this pass: writes are blocked.
    pub blocked: Option<String>,
    /// How far behind the gateway this seat is **as of the last page it
    /// fetched**.
    ///
    /// A DISPLAY NUMBER, and the qualifier is the whole of it. `behind` is
    /// derived from `seat_state.gateway_watermark`, which is the watermark the
    /// last served page carried — so a gateway that committed something after
    /// that page was cut leaves this at zero while the seat is genuinely
    /// behind. A caller that treated `behind == 0` as "done and may stop
    /// polling" would stop early and stay stale.
    ///
    /// The simulation found exactly that: seeds 1, 6, 11 and 14 had seats
    /// reporting `behind 0` on every pass while missing a commit another seat's
    /// intent had produced after their last fetch (#1020).
    pub behind: i64,
    /// Whether the last page this pass fetched said it was the end.
    ///
    /// The honest termination test, and still only "as of that page": it is
    /// `true` when a fetch returned `has_more: false`. A seat that wants to
    /// know it is current does not poll for this — it waits for a change event.
    /// This is for a caller draining on purpose, which is what a simulation and
    /// a `centraid doctor` run are.
    pub reached_the_end: bool,
}

/// How many rows a pass asks for at a time.
///
/// Not the door's 10,000 ceiling: a page is applied in one transaction per
/// commit and held in memory first, and on a phone a ten-thousand-row page of
/// blob images is the allocation that gets the process killed. A thousand is
/// v0's own default for the same reason.
pub const SYNC_PAGE_ROWS: i64 = 1_000;

/// How many pages one pass will drain before yielding.
///
/// A bound, so a seat that is a million rows behind still returns to its caller
/// — which is what lets the shell show progress and lets a `Cancel` land. A
/// pass that drained to the watermark would be an unbounded operation wearing a
/// bounded one's clothes.
pub const SYNC_PAGES_PER_PASS: usize = 32;

/// Run one sync pass.
///
/// `now` is passed in rather than read from a clock so a simulation's schedule
/// and a seat's retries are reproducible from a seed.
pub async fn pass(
    connection: &Connection,
    source: &mut dyn LogSource,
    sink: &mut dyn IntentSink,
    now: &str,
) -> Result<PassReport> {
    let mut report = PassReport::default();

    // 1. DRAIN THE INBOUND LOG FIRST.
    drain(connection, source, &mut report, now).await?;
    if report.rebootstrap.is_some() {
        // Nothing else this pass. The cutover is the caller's, and submitting
        // against a cursor that is about to be replaced gets the intent refused
        // on a cursor nobody will have.
        return Ok(report);
    }

    // 2. SUBMIT, in outbox order, skipping what a hold blocks.
    let outbox = Outbox::open(connection)?;
    let queued = outbox.all()?;
    let holds = crate::chain::chain_holds(&queued);
    for record in &queued {
        if record.state != IntentState::Queued {
            continue;
        }
        if holds.iter().any(|hold| hold.intent_id == record.intent_id) {
            continue;
        }
        if record.online_only {
            // Belt to the outbox's braces: the refusal is at queuing, and an
            // `online_only` row in the queue at all would be a file written by
            // a build that allowed it.
            continue;
        }
        match sink.submit(record).await {
            SubmitOutcome::Answered(answer) => {
                report.intents_submitted += 1;
                // 3. APPLY THE ANSWER. An `executed` answer parks at
                // `awaiting-change`; the rows have not arrived yet.
                let applied_commit_seq = seat_state(connection)?.applied_commit_seq;
                apply_intent_outcomes(&outbox, &[answer], applied_commit_seq, now)?;
            }
            SubmitOutcome::Unavailable(reason) => {
                // The attempt count rises, which is what the backoff reads.
                // The intent stays QUEUED: an intent moved to `sending` and
                // left there by a dropped connection is an intent nothing
                // retries.
                outbox.transition(&record.intent_id, IntentState::Queued, now, |entry| {
                    entry.attempts += 1;
                })?;
                report.blocked = Some(reason);
                // One unreachable submission means the rest are too. Trying
                // them all would be N timeouts per pass.
                break;
            }
        }
    }

    // 4. DRAIN AGAIN, because step 2's own effects are now in the log. Without
    // this an intent executed in this pass waits a whole poll interval before
    // its overlay clears.
    if report.blocked.is_none() && report.intents_submitted > 0 {
        drain(connection, source, &mut report, now).await?;
    }

    let state = seat_state(connection)?;
    report.behind = crate::state::watermark(&state).behind;
    Ok(report)
}

/// Drain up to [`SYNC_PAGES_PER_PASS`] pages.
async fn drain(
    connection: &Connection,
    source: &mut dyn LogSource,
    report: &mut PassReport,
    now: &str,
) -> Result<()> {
    for _ in 0..SYNC_PAGES_PER_PASS {
        let state = seat_state(connection)?;
        match source
            .fetch(&state.epoch, state.applied_seq, SYNC_PAGE_ROWS)
            .await
        {
            FetchOutcome::Unavailable(reason) => {
                report.stale = Some(reason);
                return Ok(());
            }
            FetchOutcome::RebootstrapRequired { reason, .. } => {
                report.rebootstrap = Some(reason);
                return Ok(());
            }
            FetchOutcome::Page(page) => {
                report.pages_fetched += 1;
                apply_with_settlement(connection, &page, report, now)?;
                if !page.has_more {
                    // The end OF THIS PAGE'S VIEW. The gateway may commit
                    // again the moment after it cut this page, which is why
                    // this is `reached_the_end` and not `caught_up`.
                    report.reached_the_end = true;
                    return Ok(());
                }
                report.reached_the_end = false;
            }
        }
    }
    Ok(())
}

/// Apply one page, clearing overlays inside each commit's transaction.
fn apply_with_settlement(
    connection: &Connection,
    page: &FetchedPage,
    report: &mut PassReport,
    now: &str,
) -> Result<()> {
    let mut cleared: Vec<String> = Vec::new();
    let applied = {
        // THE OVERLAY CLEARS INSIDE THE TRANSACTION THAT CARRIES THE ROWS.
        // This closure is the whole reason the outbox shares a database with
        // the mirrored rows: there is no instant at which both the paint and
        // the rows are visible, and none at which neither is.
        let mut in_transaction = |connection: &Connection, commit_seq: i64| -> Result<()> {
            let outbox = Outbox::open(connection)?;
            cleared.extend(settle_at_commit_seq(&outbox, commit_seq, now)?);
            Ok(())
        };
        let mut hooks = ApplyHooks {
            on_commit_in_transaction: Some(&mut in_transaction),
            on_commit_durable: None,
        };
        apply_page(connection, &page.header, &page.rows, &mut hooks)?
    };
    report.rows_applied += applied.applied;
    report.rows_duplicate += applied.duplicate;
    report.commits_applied += applied.commits;
    report.intents_settled += cleared.len();
    report.overlays_cleared.extend(cleared);
    Ok(())
}

/// Whether an intent is due to be retried.
///
/// `now_ms` against the deterministic backoff. Exposed so a simulation's
/// schedule and a real seat's timer read the same rule.
#[must_use]
pub fn is_due(record: &IntentRecord, updated_at_ms: i64, now_ms: i64) -> bool {
    if record.attempts == 0 {
        return true;
    }
    now_ms - updated_at_ms >= crate::chain::backoff_ms(record.attempts)
}

/// The six-step cutover, run as data.
///
/// Returns the outbox rows to carry over. **Reading them is step 2 and the file
/// swap is step 3**, and that order is the contract: swapping first has a
/// window in which a crash destroys work that exists nowhere else.
pub fn carry_over(connection: &Connection) -> Result<Vec<IntentRecord>> {
    let outbox = Outbox::open(connection)?;
    // Every unsettled intent, whatever its state. A `denied` one is carried too
    // and stays denied: the member is owed the refusal, and dropping it on a
    // re-bootstrap would make a refusal look like a success.
    Ok(outbox
        .all()?
        .into_iter()
        .filter(|record| !record.state.is_settled())
        .collect())
}

/// Write carried-over intents into the new file. **Step 4.**
pub fn restore_carried_over(
    connection: &Connection,
    records: &[IntentRecord],
    now: &str,
) -> Result<usize> {
    let outbox = Outbox::open(connection)?;
    let mut written = 0;
    for record in records {
        if outbox.get(&record.intent_id)?.is_some() {
            continue;
        }
        // The states that still need sending go back as `queued`; the rest keep
        // their verdict. An `awaiting-change` intent is re-queued because the
        // commit it was waiting for is in a log this file no longer has.
        let mut carried = record.clone();
        if matches!(
            record.state,
            IntentState::Sending | IntentState::AwaitingChange
        ) {
            carried.state = IntentState::Queued;
            carried.commit_seq = None;
        }
        // `enqueue` refuses an `online_only` row, which is correct: one cannot
        // have been in the queue, so a carried-over file that has one is
        // corrupt and saying so is better than admitting it.
        outbox.enqueue(&carried, now)?;
        written += 1;
    }
    Ok(written)
}

/// What a seat does when it is told to re-bootstrap while writes are pending.
///
/// The answer is [`crate::chain::admission_during_rebootstrap`]: admit, do not
/// send. Re-exported through the sync module because this is where a caller is
/// standing when it needs to know.
#[must_use]
pub const fn admission_during_rebootstrap() -> crate::chain::Admission {
    crate::chain::admission_during_rebootstrap()
}

/// A refusal a caller can give when the seat has no source at all.
#[must_use]
pub fn unavailable(reason: impl Into<String>) -> SeatError {
    SeatError::Invariant {
        context: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::OutcomeStatus;
    use centraid_vault::log::LogOp;
    use centraid_vault::value::Value;

    /// A source that hands over a scripted list of outcomes, then says it is
    /// caught up.
    struct ScriptedSource {
        outcomes: Vec<FetchOutcome>,
        asked: Vec<(String, i64)>,
    }

    impl LogSource for ScriptedSource {
        fn fetch<'a>(
            &'a mut self,
            epoch: &'a str,
            since: i64,
            _limit: i64,
        ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>> {
            Box::pin(async move {
                self.asked.push((epoch.to_owned(), since));
                if self.outcomes.is_empty() {
                    return FetchOutcome::Page(FetchedPage {
                        header: PageHeader {
                            epoch: epoch.to_owned(),
                            schema_epoch: 4,
                            ddl_version: 0,
                            watermark: since,
                        },
                        rows: Vec::new(),
                        has_more: false,
                        next: since,
                    });
                }
                self.outcomes.remove(0)
            })
        }
    }

    struct ScriptedSink {
        answers: Vec<SubmitOutcome>,
        submitted: Vec<String>,
    }

    impl IntentSink for ScriptedSink {
        fn submit<'a>(
            &'a mut self,
            record: &'a IntentRecord,
        ) -> std::pin::Pin<Box<dyn Future<Output = SubmitOutcome> + 'a>> {
            Box::pin(async move {
                self.submitted.push(record.intent_id.clone());
                if self.answers.is_empty() {
                    return SubmitOutcome::Unavailable("the script ran out".to_owned());
                }
                self.answers.remove(0)
            })
        }
    }

    /// Drive a future that never actually yields.
    ///
    /// A five-line executor rather than a tokio dev-dependency: every future in
    /// these tests is `async` only because the trait is, and none of them
    /// awaits anything real. Pulling in a runtime to poll a future that is
    /// always `Ready` on its first poll would be a dependency for decoration —
    /// and this `unreachable!` is the assertion that it stays true.
    fn drive<T>(future: impl Future<Output = T>) -> T {
        use std::task::{Context, Poll, Waker};
        // `Waker::noop`, not a hand-rolled `RawWaker`: this crate forbids
        // `unsafe`, and rightly — a seat is the half of the plane that runs on
        // a member's phone.
        let mut context = Context::from_waker(Waker::noop());
        let mut pinned = Box::pin(future);
        match pinned.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => unreachable!(
                "a scripted source or sink pended; these futures are always ready on \
                 their first poll, and a runtime would be needed if that changed"
            ),
        }
    }

    fn seat() -> Connection {
        let connection = Connection::open_in_memory().expect("opens");
        connection
            .execute_batch("CREATE TABLE mirror (id TEXT PRIMARY KEY, value TEXT) STRICT;")
            .expect("the mirror");
        crate::state::init_seat_state(
            &connection,
            &crate::state::SeatPosition {
                vault_id: "v".to_owned(),
                epoch: "e".to_owned(),
                schema_epoch: 4,
                ddl_version: 0,
                applied_seq: 0,
                applied_commit_seq: 0,
            },
            "t",
        )
        .expect("the state");
        Outbox::open(&connection).expect("the outbox");
        connection
    }

    fn row(seq: i64, commit_seq: i64, id: &str) -> centraid_vault::log::LogRow {
        let mut image = centraid_vault::RowImage::new();
        image.insert("id".to_owned(), Value::Text(id.to_owned()));
        image.insert("value".to_owned(), Value::Text(format!("v{seq}")));
        centraid_vault::log::LogRow {
            seq,
            commit_seq,
            epoch: "e".to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            table: "mirror".to_owned(),
            op: LogOp::Insert,
            primary_key: vec![Value::Text(id.to_owned())],
            row: Some(image),
            prior: None,
            indirect: false,
            producer: "sim".to_owned(),
            deferred: false,
            local: false,
            committed_at: "t".to_owned(),
        }
    }

    fn page(
        rows: Vec<centraid_vault::log::LogRow>,
        has_more: bool,
        watermark: i64,
    ) -> FetchOutcome {
        let next = rows.last().map_or(watermark, |row| row.seq);
        FetchOutcome::Page(FetchedPage {
            header: PageHeader {
                epoch: "e".to_owned(),
                schema_epoch: 4,
                ddl_version: 0,
                watermark,
            },
            rows,
            has_more,
            next,
        })
    }

    fn queued(id: &str) -> IntentRecord {
        IntentRecord {
            intent_id: id.to_owned(),
            created_order: 0,
            app_id: "notes".to_owned(),
            action: "edit".to_owned(),
            input: serde_json::json!({}),
            payload_hash: "a".repeat(64),
            state: IntentState::Queued,
            attempts: 0,
            depends_on: Vec::new(),
            base_versions: Vec::new(),
            optimistic: None,
            commit_seq: None,
            waiting_on: Vec::new(),
            needs_blobs: Vec::new(),
            enqueued_at: "t".to_owned(),
            updated_at: "t".to_owned(),
            reason: None,
            conflicts: Vec::new(),
            online_only: false,
        }
    }

    fn answer(id: &str, commit_seq: Option<i64>) -> Answer {
        Answer {
            intent_id: id.to_owned(),
            status: OutcomeStatus::Executed,
            commit_seq,
            conflicts: Vec::new(),
            answered_versions: Vec::new(),
            waiting_on: Vec::new(),
            reason: None,
        }
    }

    #[test]
    fn a_pass_drains_the_log_before_it_submits() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: vec![page(vec![row(1, 1, "a")], false, 1)],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: vec![SubmitOutcome::Answered(answer("i-1", Some(2)))],
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t2")).expect("the pass runs");

        assert_eq!(report.rows_applied, 1);
        assert_eq!(report.intents_submitted, 1);
        // The FIRST fetch was at cursor 0, before any submission — which is the
        // ordering claim.
        assert_eq!(source.asked.first(), Some(&("e".to_owned(), 0)));
        assert_eq!(sink.submitted, ["i-1"]);
    }

    /// STEP 4. Without the second drain an intent executed in this pass waits a
    /// whole poll interval before its overlay clears.
    #[test]
    fn an_intent_executed_this_pass_has_its_overlay_cleared_this_pass() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: vec![
                // The first drain: nothing yet.
                page(Vec::new(), false, 0),
                // The second drain, after the submission: the commit the
                // gateway just made.
                page(vec![row(1, 7, "a")], false, 1),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: vec![SubmitOutcome::Answered(answer("i-1", Some(7)))],
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t2")).expect("the pass runs");

        assert_eq!(report.pages_fetched, 2, "the log was drained twice");
        assert_eq!(report.overlays_cleared, ["i-1"]);
        // THE COUNT, not only the list. Killed the mutant that turned
        // `intents_settled +=` into `*=`: the list and the count are extended
        // by two different statements, and a caller that shows "3 writes saved"
        // reads the count.
        assert_eq!(report.intents_settled, 1);
        assert!(
            outbox.get("i-1").expect("reads").is_none(),
            "the intent settled in the same pass it was submitted in"
        );
        assert!(outbox.was_settled("i-1").expect("reads"));
    }

    #[test]
    fn an_unreachable_source_makes_the_seat_stale_and_not_broken() {
        let connection = seat();
        let mut source = ScriptedSource {
            outcomes: vec![FetchOutcome::Unavailable("no route".to_owned())],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report =
            drive(pass(&connection, &mut source, &mut sink, "t")).expect("the pass still runs");
        assert_eq!(report.stale.as_deref(), Some("no route"));
        assert_eq!(report.rows_applied, 0);
        // And the pass RETURNED rather than erroring: a stale seat is a state,
        // not a failure.
        assert!(report.rebootstrap.is_none());
    }

    #[test]
    fn an_unreachable_sink_blocks_writes_and_raises_the_attempt_count() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");
        outbox.enqueue(&queued("i-2"), "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: Vec::new(),
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: vec![SubmitOutcome::Unavailable("no route".to_owned())],
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t2")).expect("the pass runs");
        assert_eq!(report.blocked.as_deref(), Some("no route"));
        // ONE ATTEMPT, not two: the rest of the queue is not tried, because N
        // timeouts per pass is a pass that never returns.
        assert_eq!(sink.submitted, ["i-1"]);
        let record = outbox.get("i-1").expect("reads").expect("still queued");
        assert_eq!(record.attempts, 1);
        assert_eq!(
            record.state,
            IntentState::Queued,
            "an intent left at `sending` by a dropped connection is one nothing retries"
        );
    }

    #[test]
    fn a_held_intent_is_not_submitted() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");
        let mut successor = queued("i-2");
        successor.depends_on.push("i-1".to_owned());
        outbox.enqueue(&successor, "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: Vec::new(),
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            // Only `i-1` gets an answer, and it parks at `awaiting-change`.
            answers: vec![SubmitOutcome::Answered(answer("i-1", Some(9)))],
            submitted: Vec::new(),
        };
        drive(pass(&connection, &mut source, &mut sink, "t2")).expect("the pass runs");
        assert_eq!(
            sink.submitted,
            ["i-1"],
            "`i-2` waits on `i-1`, which has not settled"
        );
    }

    #[test]
    fn a_rebootstrap_stops_the_pass_before_it_submits_anything() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");
        let mut source = ScriptedSource {
            outcomes: vec![FetchOutcome::RebootstrapRequired {
                reason: centraid_vault::RebootstrapReason::EpochMismatch,
                epoch: "new".to_owned(),
                floor: 100,
                watermark: 200,
            }],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t")).expect("the pass runs");
        assert_eq!(
            report.rebootstrap,
            Some(centraid_vault::RebootstrapReason::EpochMismatch)
        );
        assert!(
            sink.submitted.is_empty(),
            "submitting against a cursor about to be replaced gets the intent refused"
        );
    }

    /// The counters ACCUMULATE across the pages of one pass.
    ///
    /// Killed four mutants that turned `+=` into `-=` and `*=` on
    /// `rows_applied`, `rows_duplicate` and `commits_applied`. A single-page
    /// pass cannot tell the difference — `0 += n` and `0 -= n` differ only in
    /// sign, and every other test fetched one page. So this one fetches three.
    #[test]
    fn the_counters_accumulate_across_every_page_of_one_pass() {
        let connection = seat();
        let mut source = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 5),
                page(vec![row(3, 2, "c")], true, 5),
                page(vec![row(4, 3, "d"), row(5, 3, "e")], false, 5),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t")).expect("the pass runs");
        assert_eq!(report.pages_fetched, 3);
        // FIVE rows over THREE pages: a counter that multiplied would be 0 and
        // one that subtracted would be negative — which a `usize` cannot even
        // hold, so the mutant that does it panics rather than lying.
        assert_eq!(report.rows_applied, 5);
        assert_eq!(report.commits_applied, 3);

        // And the duplicate counter accumulates too: the whole span again.
        let mut again = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 5),
                page(vec![row(3, 2, "c")], false, 5),
            ],
            asked: Vec::new(),
        };
        let replayed =
            drive(pass(&connection, &mut again, &mut sink, "t2")).expect("the pass runs");
        assert_eq!(replayed.rows_duplicate, 3);
        assert_eq!(replayed.rows_applied, 0);
        assert_eq!(replayed.intents_settled, 0, "nothing settled on a replay");
    }

    /// `intents_settled` accumulates across the pages of one pass.
    ///
    /// Two intents waiting on two different commits, arriving on two pages. A
    /// count that multiplied would be 0 and one that took only the last page
    /// would be 1.
    #[test]
    fn the_settled_count_accumulates_across_pages() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        for (id, commit_seq) in [("i-1", 1), ("i-2", 2)] {
            outbox.enqueue(&queued(id), "t").expect("queues");
            outbox
                .transition(id, IntentState::AwaitingChange, "t", |entry| {
                    entry.commit_seq = Some(commit_seq);
                })
                .expect("waits");
        }
        let mut source = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a")], true, 2),
                page(vec![row(2, 2, "b")], false, 2),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t2")).expect("the pass runs");
        assert_eq!(report.pages_fetched, 2);
        assert_eq!(report.intents_settled, 2);
        assert_eq!(report.overlays_cleared.len(), 2);
    }

    /// `is_due` measures ELAPSED time, which is a subtraction.
    ///
    /// Killed the mutant that turned `-` into `+`. Every other test used
    /// `updated_at_ms = 0`, where `now - 0` and `now + 0` are the same number —
    /// so the arithmetic was unasserted for every intent that had ever been
    /// tried at a real time.
    #[test]
    fn a_retry_measures_elapsed_time_from_when_it_was_last_tried() {
        let mut record = queued("i-1");
        record.attempts = 1; // a 2,000 ms backoff
        let last_tried = 1_000_000_i64;
        assert!(
            !is_due(&record, last_tried, last_tried + 1_999),
            "not due 1,999 ms after the last attempt"
        );
        assert!(
            is_due(&record, last_tried, last_tried + 2_000),
            "due 2,000 ms after the last attempt"
        );
        // AND NOT DUE at a `now` before the last attempt, which is what a
        // clock that went backwards looks like: an addition would call it due.
        assert!(
            !is_due(&record, last_tried, last_tried - 5_000),
            "a clock that went backwards does not make a retry due"
        );
    }

    #[test]
    fn a_pass_is_bounded_and_returns_even_when_there_is_more() {
        let connection = seat();
        let mut outcomes = Vec::new();
        for index in 1..=(SYNC_PAGES_PER_PASS + 10) {
            let seq = index as i64;
            outcomes.push(page(vec![row(seq, seq, &format!("r{seq}"))], true, 1_000));
        }
        let mut source = ScriptedSource {
            outcomes,
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(pass(&connection, &mut source, &mut sink, "t")).expect("the pass runs");
        assert_eq!(
            report.pages_fetched, SYNC_PAGES_PER_PASS,
            "a pass that drained to the watermark would be unbounded"
        );
        // And the caller can see there is more to do.
        assert!(report.behind > 0);
    }

    #[test]
    fn the_cutover_carries_the_outbox_over_before_the_file_is_swapped() {
        let old = seat();
        let outbox = Outbox::open(&old).expect("opens");
        outbox.enqueue(&queued("i-queued"), "t").expect("queues");
        outbox.enqueue(&queued("i-awaiting"), "t").expect("queues");
        outbox
            .transition("i-awaiting", IntentState::AwaitingChange, "t", |entry| {
                entry.commit_seq = Some(42)
            })
            .expect("transitions");
        outbox.enqueue(&queued("i-denied"), "t").expect("queues");
        outbox
            .transition("i-denied", IntentState::Denied, "t", |entry| {
                entry.reason = Some("you may not".to_owned())
            })
            .expect("transitions");

        // STEP 2, before any swap.
        let carried = carry_over(&old).expect("the carry-over reads");
        assert_eq!(carried.len(), 3);

        // STEP 3 and 4: the new file, then the restore.
        let new = seat();
        assert_eq!(
            restore_carried_over(&new, &carried, "t2").expect("the restore runs"),
            3
        );
        let restored = Outbox::open(&new).expect("opens");
        assert_eq!(
            restored
                .get("i-awaiting")
                .expect("reads")
                .expect("there")
                .state,
            IntentState::Queued,
            "the commit it was waiting for is in a log this file no longer has"
        );
        assert_eq!(
            restored
                .get("i-awaiting")
                .expect("reads")
                .expect("there")
                .commit_seq,
            None
        );
        // A DENIED INTENT STAYS DENIED. The member is owed the refusal, and
        // dropping it would make a refusal look like a success.
        let denied = restored.get("i-denied").expect("reads").expect("there");
        assert_eq!(denied.state, IntentState::Denied);
        assert_eq!(denied.reason.as_deref(), Some("you may not"));
    }

    #[test]
    fn a_restore_is_idempotent_so_a_crash_mid_cutover_can_repeat_it() {
        let old = seat();
        Outbox::open(&old)
            .expect("opens")
            .enqueue(&queued("i-1"), "t")
            .expect("queues");
        let carried = carry_over(&old).expect("reads");
        let new = seat();
        assert_eq!(restore_carried_over(&new, &carried, "t").expect("runs"), 1);
        assert_eq!(
            restore_carried_over(&new, &carried, "t").expect("runs"),
            0,
            "a crash between step 4 and step 5 is repaired by running step 4 again"
        );
    }

    #[test]
    fn a_retry_is_due_only_after_its_backoff() {
        let mut record = queued("i-1");
        assert!(is_due(&record, 0, 0), "a first attempt is always due");
        record.attempts = 1;
        assert!(!is_due(&record, 0, 1_999));
        assert!(is_due(&record, 0, 2_000));
        record.attempts = 99;
        assert!(!is_due(&record, 0, 299_999));
        assert!(is_due(&record, 0, 300_000), "the ceiling is five minutes");
    }

    #[test]
    fn a_write_during_a_rebootstrap_is_admitted_and_not_sent() {
        let admission = admission_during_rebootstrap();
        assert!(admission.admit);
        assert!(!admission.send);
    }
}
