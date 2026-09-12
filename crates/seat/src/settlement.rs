//! Settlement: an answer is the gateway's fact, an overlay is this seat's.
//!
//! That one sentence organises the whole module. When the gateway answers
//! `executed` with a `commit_seq`, the *write happened* — but the rows have not
//! arrived at this seat, so the overlay must stay. Clearing it on the answer is
//! how a screen flickers back to the pre-edit value for one frame and then
//! forward again, which members report as "it didn't save".
//!
//! So an `executed` answer carrying a commit seq parks at
//! [`IntentState::AwaitingChange`], and [`settle_at_commit_seq`] is what finally
//! settles it — called from the applier's in-transaction hook, so the overlay
//! and the rows that replace it are one fact.
//!
//! ## Two settlement paths, and why both exist
//!
//! `settles_by_commit_seq` is the primary: the answer names a commit and the
//! seat waits for its cursor to reach it. The `answered_versions` path is the
//! #929 fallback for an answer that carries versions but no commit — the seat
//! can then check whether its mirrored rows already hold those versions. A
//! missing probe means "holds nothing", so an answer *waits* rather than
//! clearing early.

use crate::error::{Result, SeatError};
use crate::intent::{IntentRecord, IntentState, OutcomeStatus, intent_verdict};
use crate::occ::Conflict;
use crate::outbox::Outbox;

/// One answer from the gateway.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub intent_id: String,
    pub status: OutcomeStatus,
    pub commit_seq: Option<i64>,
    pub conflicts: Vec<Conflict>,
    pub answered_versions: Vec<centraid_vault::intents::BaseVersion>,
    pub waiting_on: Vec<crate::intent::WaitingOn>,
    pub reason: Option<String>,
}

/// What applying one answer did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// Out of the queue and into the journal.
    Settled,
    /// Parked at `awaiting-change`: the gateway is done, this seat is not.
    AwaitingChange,
    /// Moved to some other state.
    Transitioned(IntentState),
    /// The outbox does not hold this intent. A duplicate answer for an intent
    /// already settled is exactly this, and it is not an error.
    Unknown,
}

/// Apply answers in intent order.
///
/// **Serialised, not concurrent.** Two answers for chained intents applied in
/// parallel can settle a successor before its predecessor, and the overlay set
/// briefly shows the successor's paint over rows the predecessor has not
/// written.
pub fn apply_intent_outcomes(
    outbox: &Outbox<'_>,
    answers: &[Answer],
    applied_commit_seq: i64,
    now: &str,
) -> Result<Vec<(String, Applied)>> {
    let mut out = Vec::with_capacity(answers.len());
    for answer in answers {
        out.push((
            answer.intent_id.clone(),
            apply_one(outbox, answer, applied_commit_seq, now)?,
        ));
    }
    Ok(out)
}

fn apply_one(
    outbox: &Outbox<'_>,
    answer: &Answer,
    applied_commit_seq: i64,
    now: &str,
) -> Result<Applied> {
    if outbox.get(&answer.intent_id)?.is_none() {
        return Ok(Applied::Unknown);
    }

    if answer.status == OutcomeStatus::Executed {
        if let Some(commit_seq) = answer.commit_seq {
            if commit_seq <= applied_commit_seq {
                // The rows are already here. Settling now is not early.
                outbox.settle(&answer.intent_id, now)?;
                return Ok(Applied::Settled);
            }
            outbox.transition(
                &answer.intent_id,
                IntentState::AwaitingChange,
                now,
                |record| {
                    record.commit_seq = Some(commit_seq);
                    record.reason = answer.reason.clone();
                },
            )?;
            return Ok(Applied::AwaitingChange);
        }
        // THE #929 PATH. No commit seq; the answer carries versions instead.
        //
        // WITH NEITHER, PARKING IS A LIVENESS BUG AND NOT CAUTION. The
        // deterministic simulation found this on its first run: an `executed`
        // answer with no commit seq and no versions parked at
        // `awaiting-change`, `settle_at_commit_seq` never matched it (its
        // `commit_seq` is NULL) and `settle_answered_intents` skipped it (its
        // version set is empty) — so the overlay stayed on the screen for the
        // life of the seat. "Wait rather than clear early" is only conservative
        // when something will eventually arrive.
        //
        // So it is refused, loudly, naming the gap. A gateway that answers
        // `executed` owes the seat one of the two, and the remedy is the
        // gateway's rather than something a seat can paper over.
        if answer.answered_versions.is_empty() {
            return Err(SeatError::Invariant {
                context: format!(
                    "`{}` was answered `executed` with neither a commit seq nor an \
                     answered-version set; nothing could ever settle it. A gateway that \
                     answers `executed` owes the seat one of the two (#1020, found by \
                     crates/sim seed 0)",
                    answer.intent_id
                ),
            });
        }
        outbox.transition(
            &answer.intent_id,
            IntentState::AwaitingChange,
            now,
            |record| {
                record.base_versions = answer.answered_versions.clone();
                record.reason = answer.reason.clone();
            },
        )?;
        return Ok(Applied::AwaitingChange);
    }

    let base_is_missing = answer.conflicts.iter().any(Conflict::base_is_missing);
    let state = intent_verdict(answer.status, base_is_missing);
    outbox.transition(&answer.intent_id, state, now, |record| {
        record.commit_seq = answer.commit_seq.or(record.commit_seq);
        record.conflicts = answer.conflicts.clone();
        record.waiting_on = answer.waiting_on.clone();
        record.reason = answer.reason.clone();
    })?;
    Ok(Applied::Transitioned(state))
}

/// Settle every `awaiting-change` intent whose commit the cursor has reached.
///
/// This is what the applier's in-transaction hook calls. Because it runs inside
/// the transaction carrying the commit's rows, the overlay and the rows are one
/// fact: there is no instant at which both are visible and none at which
/// neither is.
pub fn settle_at_commit_seq(
    outbox: &Outbox<'_>,
    cursor_commit_seq: i64,
    now: &str,
) -> Result<Vec<String>> {
    let ready = outbox.awaiting_at_or_below(cursor_commit_seq)?;
    for intent_id in &ready {
        outbox.settle(intent_id, now)?;
    }
    Ok(ready)
}

/// The version-set twin: settle answers whose versions the mirror already holds.
///
/// `holds_version` is the probe. **A `None` means "holds nothing"** and the
/// answer waits, which is the conservative direction: waiting shows stale paint
/// for a moment, clearing early shows the *wrong* value.
pub fn settle_answered_intents(
    outbox: &Outbox<'_>,
    now: &str,
    mut holds_version: impl FnMut(&centraid_vault::intents::BaseVersion) -> Option<bool>,
) -> Result<Vec<String>> {
    let mut settled = Vec::new();
    for record in outbox.all()? {
        if record.state != IntentState::AwaitingChange || record.commit_seq.is_some() {
            continue;
        }
        if record.base_versions.is_empty() {
            continue;
        }
        let all_held = record
            .base_versions
            .iter()
            .all(|version| holds_version(version) == Some(true));
        if all_held {
            outbox.settle(&record.intent_id, now)?;
            settled.push(record.intent_id);
        }
    }
    Ok(settled)
}

/// The overlays a caller should paint, after settlement has run.
pub fn overlays(outbox: &Outbox<'_>) -> Result<Vec<IntentRecord>> {
    outbox.overlaid()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn record(id: &str) -> IntentRecord {
        IntentRecord {
            intent_id: id.to_owned(),
            created_order: 0,
            app_id: "notes".to_owned(),
            action: "edit".to_owned(),
            input: serde_json::json!({}),
            payload_hash: "a".repeat(64),
            state: IntentState::Sending,
            attempts: 1,
            depends_on: Vec::new(),
            base_versions: Vec::new(),
            optimistic: Some(serde_json::json!({ "note": { "n1": { "title": "typed" } } })),
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

    fn answer(id: &str, status: OutcomeStatus) -> Answer {
        Answer {
            intent_id: id.to_owned(),
            status,
            commit_seq: None,
            conflicts: Vec::new(),
            answered_versions: Vec::new(),
            waiting_on: Vec::new(),
            reason: None,
        }
    }

    fn version(row_id: &str, version: i64) -> centraid_vault::intents::BaseVersion {
        centraid_vault::intents::BaseVersion {
            entity: "note".to_owned(),
            row_id: row_id.to_owned(),
            shape_id: None,
            version,
        }
    }

    /// THE ORGANISING RULE. An `executed` answer does NOT clear the overlay.
    #[test]
    fn an_executed_answer_parks_at_awaiting_change_rather_than_clearing_the_overlay() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");

        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.commit_seq = Some(12);
        let applied = apply_intent_outcomes(&outbox, &[executed], 3, "t2").expect("it applies");
        assert_eq!(applied, [("i-1".to_owned(), Applied::AwaitingChange)]);

        let record = outbox.get("i-1").expect("reads").expect("still queued");
        assert_eq!(record.state, IntentState::AwaitingChange);
        assert!(record.state.holds_overlay(), "the paint is still on");
        assert_eq!(record.commit_seq, Some(12));
    }

    #[test]
    fn an_executed_answer_whose_commit_is_already_applied_settles_at_once() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.commit_seq = Some(3);
        let applied = apply_intent_outcomes(&outbox, &[executed], 5, "t2").expect("applies");
        assert_eq!(applied, [("i-1".to_owned(), Applied::Settled)]);
        assert!(outbox.get("i-1").expect("reads").is_none());
        assert!(outbox.was_settled("i-1").expect("reads"));
    }

    #[test]
    fn the_cursor_reaching_the_commit_is_what_settles_the_overlay() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.commit_seq = Some(12);
        apply_intent_outcomes(&outbox, &[executed], 3, "t2").expect("applies");

        assert!(
            settle_at_commit_seq(&outbox, 11, "t3")
                .expect("runs")
                .is_empty()
        );
        assert_eq!(
            settle_at_commit_seq(&outbox, 12, "t3").expect("runs"),
            ["i-1"]
        );
        assert!(outbox.get("i-1").expect("reads").is_none());
    }

    #[test]
    fn a_conflict_answer_splits_on_whether_the_base_is_missing() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        outbox.enqueue(&record("i-2"), "t").expect("queues");

        let mut moved = answer("i-1", OutcomeStatus::Conflict);
        moved.conflicts.push(Conflict {
            entity: "note".to_owned(),
            row_id: "n1".to_owned(),
            shape_id: None,
            expected_version: 2,
            actual_version: 5,
        });
        let mut gone = answer("i-2", OutcomeStatus::Conflict);
        gone.conflicts.push(Conflict {
            entity: "note".to_owned(),
            row_id: "n1".to_owned(),
            shape_id: None,
            expected_version: 2,
            actual_version: 0,
        });
        let applied = apply_intent_outcomes(&outbox, &[moved, gone], 0, "t2").expect("applies");
        assert_eq!(
            applied,
            [
                (
                    "i-1".to_owned(),
                    Applied::Transitioned(IntentState::Conflict)
                ),
                (
                    "i-2".to_owned(),
                    Applied::Transitioned(IntentState::ConflictBaseMissing)
                ),
            ]
        );
    }

    #[test]
    fn a_duplicate_answer_for_a_settled_intent_is_not_an_error() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.commit_seq = Some(1);
        apply_intent_outcomes(&outbox, &[executed.clone()], 1, "t2").expect("applies");
        assert_eq!(
            apply_intent_outcomes(&outbox, &[executed], 1, "t3").expect("applies"),
            [("i-1".to_owned(), Applied::Unknown)]
        );
    }

    /// A MISSING PROBE MEANS "HOLDS NOTHING", so the answer waits.
    /// THE LIVENESS BUG the simulation found, as a test.
    #[test]
    fn an_executed_answer_with_neither_a_commit_seq_nor_versions_is_refused() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        // No commit seq AND no answered versions: nothing could ever settle it.
        let empty = answer("i-1", OutcomeStatus::Executed);
        let error = apply_intent_outcomes(&outbox, &[empty], 0, "t2").expect_err("it refuses");
        assert!(error.to_string().contains("nothing could ever settle it"));
        // And the intent is left as it was, rather than parked in a state with
        // no way out.
        assert_eq!(
            outbox.get("i-1").expect("reads").expect("there").state,
            IntentState::Sending
        );
    }

    #[test]
    fn the_version_set_path_waits_when_the_probe_cannot_say() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.answered_versions.push(version("n1", 4));
        apply_intent_outcomes(&outbox, &[executed], 0, "t2").expect("applies");

        assert!(
            settle_answered_intents(&outbox, "t3", |_| None)
                .expect("runs")
                .is_empty(),
            "an unanswerable probe waits; clearing early shows the WRONG value"
        );
        assert!(
            settle_answered_intents(&outbox, "t3", |_| Some(false))
                .expect("runs")
                .is_empty()
        );
        assert_eq!(
            settle_answered_intents(&outbox, "t3", |_| Some(true)).expect("runs"),
            ["i-1"]
        );
    }

    #[test]
    fn the_version_set_path_leaves_a_commit_seq_answer_to_the_cursor() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.commit_seq = Some(12);
        apply_intent_outcomes(&outbox, &[executed], 0, "t2").expect("applies");
        assert!(
            settle_answered_intents(&outbox, "t3", |_| Some(true))
                .expect("runs")
                .is_empty(),
            "an answer that named a commit settles against the CURSOR"
        );
    }

    #[test]
    fn answers_are_applied_in_the_order_they_were_given() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        outbox.enqueue(&record("i-2"), "t").expect("queues");
        let applied = apply_intent_outcomes(
            &outbox,
            &[
                answer("i-2", OutcomeStatus::Denied),
                answer("i-1", OutcomeStatus::Failed),
            ],
            0,
            "t2",
        )
        .expect("applies");
        assert_eq!(
            applied
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            ["i-2", "i-1"]
        );
    }

    #[test]
    fn a_parked_answer_carries_its_waits_through() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        let mut parked = answer("i-1", OutcomeStatus::Parked);
        parked.waiting_on.push(crate::intent::WaitingOn {
            seat: crate::intent::WaitingOnSeat::Owner,
            label: "the owner must confirm".to_owned(),
        });
        parked.reason = Some("this needs your confirmation".to_owned());
        apply_intent_outcomes(&outbox, &[parked], 0, "t2").expect("applies");
        let record = outbox.get("i-1").expect("reads").expect("there");
        assert_eq!(record.state, IntentState::Parked);
        assert_eq!(record.waiting_on.len(), 1);
        assert_eq!(
            record.reason.as_deref(),
            Some("this needs your confirmation")
        );
        assert!(record.state.retained_attention());
        assert!(!record.state.actionable_attention());
    }

    #[test]
    fn overlays_are_the_nine_state_set_read_off_the_queue() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&record("i-1"), "t").expect("queues");
        assert_eq!(overlays(&outbox).expect("reads").len(), 1);
        let mut executed = answer("i-1", OutcomeStatus::Executed);
        executed.commit_seq = Some(1);
        apply_intent_outcomes(&outbox, &[executed], 1, "t2").expect("applies");
        assert!(overlays(&outbox).expect("reads").is_empty());
    }
}
