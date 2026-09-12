//! The offline chain: minted rows, synthetic ids, holds, backoff, cutover.
//!
//! An offline seat queues writes that refer to rows earlier queued writes will
//! create. The chain is what turns that into something a gateway can execute.
//!
//! ## Three refusals, stated first because each one was a shipped bug
//!
//! 1. **Never invent an edge from a value.** Two intents that happen to
//!    mention the same string are not ordered by that. An edge exists only when
//!    an intent names a row id an *unsettled predecessor minted*.
//! 2. **Never substitute a predecessor's version before sending.** The
//!    predecessor has not run; its produced version is not knowable, and a
//!    guessed one is an OCC check against a number nobody wrote.
//! 3. **Never clear an overlay on the answer.** The answer is the gateway's
//!    fact; the overlay is this seat's, and it clears when the *rows* arrive.
//!
//! ## Synthetic ids, and the one thing that is dropped for them
//!
//! A row id is **synthetic** when the minting intent's own input never named
//! it (the seat generated it) or when it matches [`stable_pending_row_id`].
//! Only synthetic references are rewritten to `{$intent, table}`, and base
//! versions are dropped **only for synthetic rows**. Dropping them for every
//! row a queued predecessor had upserted is how a connected phone overwrote
//! two newer edits with no conflict and no alert.

use std::collections::{BTreeMap, BTreeSet};

use centraid_vault::intents::BaseVersion;

use crate::intent::{IntentRecord, IntentState};

/// The states that still count as unsettled for chaining purposes.
///
/// **Seven, and not the overlay set's nine.** `denied` and `expired` are
/// dropped because a successor must not wait on a predecessor that will never
/// run, and `executed` because its rows are real. The overlay set answers "is
/// there paint on the screen"; this answers "could this still produce a row",
/// and those are different questions with different answers for exactly three
/// states.
pub const UNSETTLED: [IntentState; 7] = [
    IntentState::Queued,
    IntentState::Sending,
    IntentState::AwaitingChange,
    IntentState::Parked,
    IntentState::Conflict,
    IntentState::ConflictBaseMissing,
    IntentState::Failed,
];

/// A predecessor in one of these will never produce its row.
pub const NEVER: [IntentState; 2] = [IntentState::Denied, IntentState::Expired];

/// Whether a state could still produce a row.
#[must_use]
pub fn is_unsettled(state: IntentState) -> bool {
    UNSETTLED.contains(&state)
}

/// The deterministic pending row id a seat mints for an offline creation.
///
/// Deterministic and not random, so the same intent re-minted after a reload
/// refers to the same pending row — a random id would orphan every successor
/// the moment the app restarted.
#[must_use]
pub fn stable_pending_row_id(intent_id: &str, table: &str) -> String {
    format!("pending:{intent_id}:{table}")
}

/// One row an unsettled intent will create or update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MintedRow {
    pub intent_id: String,
    pub table: String,
    pub row_id: String,
    /// The minting intent's own input never named this id, or it is a stable
    /// pending id. Only these are rewritten and only their base versions are
    /// dropped.
    pub synthetic: bool,
}

/// What an intent claims to write, as the caller knows it.
///
/// Supplied by the caller rather than parsed out of `input`, because "which
/// rows does this action upsert" is the *action's* knowledge and a chain that
/// guessed it from JSON keys would be inventing edges from values — refusal 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upsert {
    pub table: String,
    pub row_id: String,
    /// Whether the intent's own input named this id.
    pub named_by_input: bool,
}

/// Index every row an unsettled intent will mint.
///
/// `superseded` are intent ids a later intent replaced; their rows are not
/// minted by anybody and an edge to one is an edge to nothing.
pub fn minted_row_index(
    intents: &[(IntentRecord, Vec<Upsert>)],
    superseded: &BTreeSet<String>,
) -> BTreeMap<(String, String), MintedRow> {
    let mut index = BTreeMap::new();
    for (record, upserts) in intents {
        if !is_unsettled(record.state) || superseded.contains(&record.intent_id) {
            continue;
        }
        for upsert in upserts {
            let stable = stable_pending_row_id(&record.intent_id, &upsert.table);
            let synthetic = !upsert.named_by_input || upsert.row_id == stable;
            index.insert(
                (upsert.table.clone(), upsert.row_id.clone()),
                MintedRow {
                    intent_id: record.intent_id.clone(),
                    table: upsert.table.clone(),
                    row_id: upsert.row_id.clone(),
                    synthetic,
                },
            );
        }
    }
    index
}

/// The predecessors one intent depends on, in outbox order.
///
/// An edge exists only where a named row id matches a row an unsettled
/// predecessor mints — refusal 1, as code.
#[must_use]
pub fn chain_dependencies(
    references: &[(String, String)],
    index: &BTreeMap<(String, String), MintedRow>,
    self_intent_id: &str,
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut order = Vec::new();
    for reference in references {
        if let Some(minted) = index.get(reference)
            && minted.intent_id != self_intent_id
            && seen.insert(minted.intent_id.clone())
        {
            order.push(minted.intent_id.clone());
        }
    }
    order
}

/// Rewrite synthetic row ids into `{"$intent": …, "table": …}`.
///
/// Only synthetic ones. A real id the member typed stays a real id, because the
/// gateway must OCC-check it against the row that exists.
pub fn substitute_predecessor_references(
    input: &serde_json::Value,
    table: &str,
    index: &BTreeMap<(String, String), MintedRow>,
) -> serde_json::Value {
    match input {
        serde_json::Value::String(text) => match index.get(&(table.to_owned(), text.clone())) {
            Some(minted) if minted.synthetic => serde_json::json!({
                "$intent": minted.intent_id,
                "table": minted.table,
            }),
            _ => input.clone(),
        },
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| substitute_predecessor_references(item, table, index))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, child)| {
                    (
                        key.clone(),
                        substitute_predecessor_references(child, table, index),
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The base versions that survive chaining.
///
/// Dropped **only** for synthetic rows: a synthetic row does not exist yet, so
/// there is no version to reference. A real row a queued predecessor also
/// touches keeps its base version, and that is the whole difference between
/// "the gateway will tell me about a conflict" and "my edit silently won".
#[must_use]
pub fn chain_base_versions(
    declared: &[BaseVersion],
    table_of: &BTreeMap<String, String>,
    index: &BTreeMap<(String, String), MintedRow>,
) -> Vec<BaseVersion> {
    declared
        .iter()
        .filter(|version| {
            let Some(table) = table_of.get(&version.entity) else {
                // An entity with no known table cannot be a minted row, so its
                // version is kept. Dropping what we cannot classify is how the
                // silent-overwrite bug happened.
                return true;
            };
            !index
                .get(&(table.clone(), version.row_id.clone()))
                .is_some_and(|minted| minted.synthetic)
        })
        .cloned()
        .collect()
}

/// One hold: this intent cannot be sent yet, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hold {
    pub intent_id: String,
    /// The predecessor being waited on.
    pub waiting_on: String,
    /// The predecessor's state, so a screen can say "denied" rather than
    /// "waiting" for a wait that will never end.
    pub because: IntentState,
}

/// Compute holds on the seat, so the badge is right while offline.
///
/// A predecessor in [`NEVER`] is still a hold — the successor cannot be sent
/// either — but its `because` says so, which is what lets the screen offer
/// "discard" rather than a spinner.
#[must_use]
pub fn chain_holds(intents: &[IntentRecord]) -> Vec<Hold> {
    let state_of: BTreeMap<&str, IntentState> = intents
        .iter()
        .map(|record| (record.intent_id.as_str(), record.state))
        .collect();
    let mut holds = Vec::new();
    for record in intents {
        if record.state.is_settled() {
            continue;
        }
        for predecessor in &record.depends_on {
            let Some(&state) = state_of.get(predecessor.as_str()) else {
                // A predecessor the outbox no longer holds has settled and been
                // journalled: nothing to wait for.
                continue;
            };
            if state.is_settled() {
                continue;
            }
            holds.push(Hold {
                intent_id: record.intent_id.clone(),
                waiting_on: predecessor.clone(),
                because: state,
            });
        }
    }
    holds
}

/// The retry delay after `attempts` failures, in milliseconds.
///
/// `min(5 min, 1s · 2^min(attempts, 9))`. **Deterministic, no jitter.** A seat
/// is one device talking to one gateway, not a thundering herd, and jitter
/// would make the failure matrix's "the next attempt succeeds" untestable
/// without a clock a test controls anyway.
#[must_use]
pub fn backoff_ms(attempts: i64) -> i64 {
    const CEILING_MS: i64 = 5 * 60 * 1_000;
    let exponent = attempts.clamp(0, 9);
    let delay = 1_000_i64.saturating_mul(1_i64 << exponent);
    delay.min(CEILING_MS)
}

/// The intent ids whose overlay clears at `cursor_commit_seq`.
///
/// `commit_seq <= cursor`. Not `<`: the commit the effect landed in IS applied
/// once the cursor reaches it.
#[must_use]
pub fn overlays_cleared_at(cursor_commit_seq: i64, intents: &[IntentRecord]) -> Vec<String> {
    intents
        .iter()
        .filter(|record| {
            record
                .commit_seq
                .is_some_and(|seq| seq <= cursor_commit_seq)
        })
        .map(|record| record.intent_id.clone())
        .collect()
}

/// Whether an intent's absence from the mirrored rows is explained.
///
/// `denied` and `expired` return true immediately: the row was never going to
/// be there, so "the row is missing" is not a reason to keep waiting.
#[must_use]
pub fn absence_reconciled(
    state: IntentState,
    applied_commit_seq: i64,
    commit_seq: Option<i64>,
) -> bool {
    if NEVER.contains(&state) {
        return true;
    }
    commit_seq.is_some_and(|seq| seq <= applied_commit_seq)
}

/// The six ordered steps of a re-bootstrap cutover.
///
/// **As data, and the order is the contract.** Swapping the file before
/// rescuing the outbox has a window in which a crash destroys work that exists
/// nowhere else — the queued intents are the only copy of what the member did
/// offline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutoverStep {
    /// Stop applying and stop sending.
    Quiesce,
    /// Read the outbox out of the old file.
    CarryOver,
    /// Put the new snapshot in place.
    Install,
    /// Write the carried-over outbox into the new file.
    Restore,
    /// Recompute the overlays against the new rows.
    Reproject,
    /// Start applying and sending again.
    Resume,
}

/// The six, in order.
pub const SEAT_REBOOTSTRAP_CUTOVER: [CutoverStep; 6] = [
    CutoverStep::Quiesce,
    CutoverStep::CarryOver,
    CutoverStep::Install,
    CutoverStep::Restore,
    CutoverStep::Reproject,
    CutoverStep::Resume,
];

/// What a seat does with a new write while a re-bootstrap is under way.
///
/// **Admit, do not send.** Refusing the write loses it; sending it against a
/// gateway that has told us to re-bootstrap gets it refused on a cursor that is
/// about to be replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Admission {
    pub admit: bool,
    pub send: bool,
}

/// The one answer.
#[must_use]
pub const fn admission_during_rebootstrap() -> Admission {
    Admission {
        admit: true,
        send: false,
    }
}

/// What a seat does with an expired outcome: mint a NEW intent.
///
/// Never a silent retry under the same id — the gateway no longer knows where
/// the first one's effect landed, so re-sending the same id asks a question
/// nobody can answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredRecovery {
    pub replaces: String,
    pub new_intent_id: String,
    pub recovery: &'static str,
}

/// Mint the replacement.
#[must_use]
pub fn chain_recovery_from_expired_outcome(
    expired_intent_id: &str,
    fresh_intent_id: &str,
) -> ExpiredRecovery {
    ExpiredRecovery {
        replaces: expired_intent_id.to_owned(),
        new_intent_id: fresh_intent_id.to_owned(),
        recovery: "resubmit-as-new-intent",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, state: IntentState, depends_on: &[&str]) -> IntentRecord {
        IntentRecord {
            intent_id: id.to_owned(),
            created_order: 0,
            app_id: "notes".to_owned(),
            action: "edit".to_owned(),
            input: serde_json::Value::Null,
            payload_hash: "a".repeat(64),
            state,
            attempts: 0,
            depends_on: depends_on.iter().map(|id| (*id).to_owned()).collect(),
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

    fn base(entity: &str, row_id: &str, version: i64) -> BaseVersion {
        BaseVersion {
            entity: entity.to_owned(),
            row_id: row_id.to_owned(),
            shape_id: None,
            version,
        }
    }

    #[test]
    fn the_unsettled_set_is_seven_and_not_the_overlay_sets_nine() {
        assert_eq!(UNSETTLED.len(), 7);
        assert_eq!(crate::intent::OVERLAY_STATES.len(), 9);
        for state in NEVER {
            assert!(
                !is_unsettled(state),
                "`{}` could never produce a row",
                state.as_str()
            );
            assert!(
                state.holds_overlay(),
                "`{}` still paints, which is why the two sets differ",
                state.as_str()
            );
        }
        assert!(!is_unsettled(IntentState::Executed));
    }

    /// REFUSAL 1. Two intents mentioning the same string are not ordered by it.
    #[test]
    fn an_edge_is_never_invented_from_a_value() {
        let index = minted_row_index(&[], &BTreeSet::new());
        assert!(
            chain_dependencies(&[("note".to_owned(), "n1".to_owned())], &index, "i-2").is_empty(),
            "nothing minted `n1`, so there is no edge"
        );
    }

    #[test]
    fn an_edge_exists_where_a_reference_matches_an_unsettled_predecessors_row() {
        let intents = vec![(
            record("i-1", IntentState::Queued, &[]),
            vec![Upsert {
                table: "note".to_owned(),
                row_id: "n1".to_owned(),
                named_by_input: false,
            }],
        )];
        let index = minted_row_index(&intents, &BTreeSet::new());
        assert_eq!(
            chain_dependencies(&[("note".to_owned(), "n1".to_owned())], &index, "i-2"),
            ["i-1"]
        );
        // And an intent never depends on itself.
        assert!(
            chain_dependencies(&[("note".to_owned(), "n1".to_owned())], &index, "i-1").is_empty()
        );
    }

    #[test]
    fn a_superseded_intents_rows_are_not_minted_by_anybody() {
        let intents = vec![(
            record("i-1", IntentState::Queued, &[]),
            vec![Upsert {
                table: "note".to_owned(),
                row_id: "n1".to_owned(),
                named_by_input: false,
            }],
        )];
        let mut superseded = BTreeSet::new();
        superseded.insert("i-1".to_owned());
        assert!(minted_row_index(&intents, &superseded).is_empty());
    }

    #[test]
    fn a_settled_predecessor_mints_nothing_because_its_row_is_real() {
        let intents = vec![(
            record("i-1", IntentState::Executed, &[]),
            vec![Upsert {
                table: "note".to_owned(),
                row_id: "n1".to_owned(),
                named_by_input: false,
            }],
        )];
        assert!(minted_row_index(&intents, &BTreeSet::new()).is_empty());
    }

    #[test]
    fn only_a_synthetic_reference_is_rewritten() {
        let intents = vec![(
            record("i-1", IntentState::Queued, &[]),
            vec![
                Upsert {
                    table: "note".to_owned(),
                    row_id: "synthetic".to_owned(),
                    named_by_input: false,
                },
                Upsert {
                    table: "note".to_owned(),
                    row_id: "typed-by-the-member".to_owned(),
                    named_by_input: true,
                },
            ],
        )];
        let index = minted_row_index(&intents, &BTreeSet::new());
        let input = serde_json::json!({
            "a": "synthetic",
            "b": "typed-by-the-member",
            "c": ["synthetic"],
        });
        let rewritten = substitute_predecessor_references(&input, "note", &index);
        assert_eq!(rewritten["a"]["$intent"], "i-1");
        assert_eq!(rewritten["a"]["table"], "note");
        assert_eq!(rewritten["b"], "typed-by-the-member");
        assert_eq!(rewritten["c"][0]["$intent"], "i-1");
    }

    #[test]
    fn a_stable_pending_row_id_is_synthetic_even_when_the_input_named_it() {
        let stable = stable_pending_row_id("i-1", "note");
        let intents = vec![(
            record("i-1", IntentState::Queued, &[]),
            vec![Upsert {
                table: "note".to_owned(),
                row_id: stable.clone(),
                // The input DID name it: a reload re-minted the same id.
                named_by_input: true,
            }],
        )];
        let index = minted_row_index(&intents, &BTreeSet::new());
        assert!(index[&("note".to_owned(), stable)].synthetic);
    }

    /// THE SILENT-OVERWRITE BUG. Base versions are dropped only for synthetic
    /// rows; for a real row the version must survive, or the gateway has no
    /// conflict to report.
    #[test]
    fn base_versions_are_dropped_only_for_synthetic_rows() {
        let intents = vec![(
            record("i-1", IntentState::Queued, &[]),
            vec![
                Upsert {
                    table: "note".to_owned(),
                    row_id: "new".to_owned(),
                    named_by_input: false,
                },
                Upsert {
                    table: "note".to_owned(),
                    row_id: "existing".to_owned(),
                    named_by_input: true,
                },
            ],
        )];
        let index = minted_row_index(&intents, &BTreeSet::new());
        let mut table_of = BTreeMap::new();
        table_of.insert("note".to_owned(), "note".to_owned());
        let kept = chain_base_versions(
            &[base("note", "new", 1), base("note", "existing", 7)],
            &table_of,
            &index,
        );
        assert_eq!(kept, [base("note", "existing", 7)]);
    }

    #[test]
    fn a_version_whose_entity_has_no_known_table_is_kept_rather_than_dropped() {
        let index = BTreeMap::new();
        let kept = chain_base_versions(&[base("mystery", "m1", 2)], &BTreeMap::new(), &index);
        assert_eq!(kept.len(), 1, "dropping what we cannot classify is the bug");
    }

    #[test]
    fn a_hold_names_the_predecessors_state_so_a_never_wait_is_not_a_spinner() {
        let intents = [
            record("i-1", IntentState::Denied, &[]),
            record("i-2", IntentState::Queued, &["i-1"]),
        ];
        let holds = chain_holds(&intents);
        assert_eq!(
            holds,
            [Hold {
                intent_id: "i-2".to_owned(),
                waiting_on: "i-1".to_owned(),
                because: IntentState::Denied,
            }]
        );
    }

    #[test]
    fn an_executed_predecessor_is_no_hold() {
        let intents = [
            record("i-1", IntentState::Executed, &[]),
            record("i-2", IntentState::Queued, &["i-1"]),
        ];
        assert!(chain_holds(&intents).is_empty());
    }

    #[test]
    fn a_predecessor_the_outbox_no_longer_holds_is_no_hold() {
        let intents = [record("i-2", IntentState::Queued, &["i-journalled"])];
        assert!(chain_holds(&intents).is_empty());
    }

    #[test]
    fn the_backoff_is_deterministic_doubles_and_stops_at_five_minutes() {
        assert_eq!(backoff_ms(0), 1_000);
        assert_eq!(backoff_ms(1), 2_000);
        assert_eq!(backoff_ms(8), 256_000);
        // 2^9 = 512s, over the five-minute ceiling.
        assert_eq!(backoff_ms(9), 300_000);
        assert_eq!(backoff_ms(9_999), 300_000);
        // Determinism: the same input, the same answer. No jitter.
        assert_eq!(backoff_ms(5), backoff_ms(5));
    }

    #[test]
    fn an_overlay_clears_at_the_commit_it_landed_in_and_not_after_it() {
        let mut executed = record("i-1", IntentState::AwaitingChange, &[]);
        executed.commit_seq = Some(12);
        assert_eq!(overlays_cleared_at(12, &[executed.clone()]), ["i-1"]);
        assert!(overlays_cleared_at(11, &[executed]).is_empty());
    }

    #[test]
    fn a_never_state_reconciles_an_absence_immediately() {
        for state in NEVER {
            assert!(absence_reconciled(state, 0, None));
        }
        assert!(!absence_reconciled(IntentState::Queued, 0, None));
        assert!(!absence_reconciled(IntentState::AwaitingChange, 5, Some(9)));
        assert!(absence_reconciled(IntentState::AwaitingChange, 9, Some(9)));
    }

    /// THE ORDER IS THE CONTRACT. Install before CarryOver is the crash window.
    #[test]
    fn the_cutover_rescues_the_outbox_before_it_swaps_the_file() {
        let steps = SEAT_REBOOTSTRAP_CUTOVER;
        assert_eq!(steps.len(), 6);
        let position = |step: CutoverStep| {
            steps
                .iter()
                .position(|entry| *entry == step)
                .expect("every step is in the list")
        };
        assert!(position(CutoverStep::CarryOver) < position(CutoverStep::Install));
        assert!(position(CutoverStep::Install) < position(CutoverStep::Restore));
        assert!(position(CutoverStep::Restore) < position(CutoverStep::Reproject));
        assert_eq!(steps[0], CutoverStep::Quiesce);
        assert_eq!(steps[5], CutoverStep::Resume);
    }

    #[test]
    fn a_write_during_a_rebootstrap_is_admitted_and_not_sent() {
        let admission = admission_during_rebootstrap();
        assert!(admission.admit, "refusing the write loses it");
        assert!(!admission.send, "the cursor it would carry is about to go");
    }

    #[test]
    fn an_expired_outcome_recovers_as_a_new_intent_and_never_as_a_retry() {
        let recovery = chain_recovery_from_expired_outcome("i-old", "i-new");
        assert_eq!(recovery.recovery, "resubmit-as-new-intent");
        assert_ne!(recovery.new_intent_id, recovery.replaces);
    }
}
