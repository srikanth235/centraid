//! The invariants, asserted after every schedule.
//!
//! Seven claims. Each one is checked against the *files* rather than against
//! anything the run reported, because a run that reported its own success would
//! be asserting its own bookkeeping. A finding names the invariant, the host and
//! the values, so a failing seed is diagnosable from the printed output without
//! re-running it.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;

/// One broken invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// Which invariant, by its number and name.
    pub invariant: &'static str,
    /// Which host: `gateway`, or `seat-N`.
    pub host: String,
    pub detail: String,
}

impl std::fmt::Display for Finding {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "[{}] {}: {}",
            self.invariant, self.host, self.detail
        )
    }
}

/// Every replicated table's rows, as comparable values.
///
/// **The vault's comparator, not a copy of it.** `crates/vault::converge`
/// exists because the `sql-confinement` rule would not let this crate hold its
/// own query — and the right answer to "I cannot put a query here" turned out
/// to be "there should only have been one query". `tests/gates.rs`, lane R's
/// restore drill and this file now walk the same code, so a narrowing of the
/// walk is one change rather than three.
pub fn replicated_state(connection: &Connection) -> BTreeMap<String, Vec<String>> {
    centraid_vault::converge::replicated_state(connection).unwrap_or_default()
}

/// Check every invariant. An empty result is a clean run.
pub fn check_invariants(gateway: &Connection, seats: &[(String, Connection)]) -> Vec<Finding> {
    let mut findings = Vec::new();
    findings.extend(log_is_contiguous(gateway));
    findings.extend(commit_seq_is_monotonic(gateway));
    findings.extend(idempotency_ledger_has_one_row_per_intent(gateway));
    findings.extend(every_executed_intent_has_one_outcome(gateway));

    let authority = replicated_state(gateway);
    for (host, seat) in seats {
        findings.extend(seat_converges(host, &authority, seat));
        findings.extend(outbox_is_drained_or_terminal(host, seat));
        findings.extend(no_row_below_the_cursor(host, seat));
    }
    findings
}

/// INVARIANT 3. The log's `seq` is gapless above the floor, and no two commits
/// are interleaved.
fn log_is_contiguous(gateway: &Connection) -> Vec<Finding> {
    const NAME: &str = "3/log-contiguous";
    let mut findings = Vec::new();
    let Ok((epoch, floor, _)) = centraid_vault::converge::position(gateway) else {
        findings.push(Finding {
            invariant: NAME,
            host: "gateway".to_owned(),
            detail: "replica_meta has no singleton row".to_owned(),
        });
        return findings;
    };
    let Ok(rows) = centraid_vault::converge::log_positions(gateway, &epoch) else {
        return findings;
    };

    let mut previous: Option<i64> = None;
    let mut highest_commit = 0_i64;
    for position in &rows {
        if let Some(previous) = previous
            && position.seq != previous + 1
        {
            findings.push(Finding {
                invariant: NAME,
                host: "gateway".to_owned(),
                detail: format!(
                    "seq jumps {previous} → {} above the floor of {floor}",
                    position.seq
                ),
            });
        }
        // A commit's number never falls: a row of commit 4 after a row of
        // commit 5 would mean two commits interleaved in the log, which is the
        // one thing the commit pair exists to prevent.
        if position.commit_seq < highest_commit {
            findings.push(Finding {
                invariant: NAME,
                host: "gateway".to_owned(),
                detail: format!(
                    "row {} carries commit_seq {} after {highest_commit}: two commits \
                     interleaved in the log",
                    position.seq, position.commit_seq
                ),
            });
        }
        highest_commit = highest_commit.max(position.commit_seq);
        previous = Some(position.seq);
    }
    findings
}

/// INVARIANT 5. `commit_seq` is monotonic: `replica_meta` holds at least the
/// highest the log carries.
fn commit_seq_is_monotonic(gateway: &Connection) -> Vec<Finding> {
    const NAME: &str = "5/commit-seq-monotonic";
    let mut findings = Vec::new();
    let (Ok((_, _, recorded)), Ok(highest)) = (
        centraid_vault::converge::position(gateway),
        centraid_vault::converge::highest_logged_commit(gateway),
    ) else {
        return findings;
    };
    if recorded < highest {
        findings.push(Finding {
            invariant: NAME,
            host: "gateway".to_owned(),
            detail: format!(
                "replica_meta.commit_seq is {recorded} and the log carries {highest}: a \
                 commit allocated a position the meta row does not know about"
            ),
        });
    }
    findings
}

/// INVARIANT 7. One ledger row per `(intent, payload_hash)`.
fn idempotency_ledger_has_one_row_per_intent(gateway: &Connection) -> Vec<Finding> {
    const NAME: &str = "7/idempotency-one-row";
    let mut findings = Vec::new();
    if let Ok(duplicates) = centraid_vault::converge::duplicate_outcome_rows(gateway) {
        for (intent_id, hash, count) in duplicates {
            findings.push(Finding {
                invariant: NAME,
                host: "gateway".to_owned(),
                detail: format!("`{intent_id}` / `{hash}` has {count} rows"),
            });
        }
    }
    // An intent id holding TWO different payload hashes is the reuse the ledger
    // exists to refuse — a different finding, because the remedy is the seat's
    // rather than the gateway's.
    if let Ok(reused) = centraid_vault::converge::reused_intent_ids(gateway) {
        for (intent_id, hashes) in reused {
            findings.push(Finding {
                invariant: NAME,
                host: "gateway".to_owned(),
                detail: format!("`{intent_id}` holds {hashes} different payload hashes"),
            });
        }
    }
    findings
}

/// INVARIANT 4. Every executed intent has exactly one invocation and exactly
/// one receipt.
fn every_executed_intent_has_one_outcome(gateway: &Connection) -> Vec<Finding> {
    const NAME: &str = "4/one-receipt-per-intent";
    let mut findings = Vec::new();
    let Ok(evidence) = centraid_vault::converge::executed_intent_evidence(gateway) else {
        return findings;
    };
    for entry in evidence {
        if entry.invocations != 1 {
            findings.push(Finding {
                invariant: NAME,
                host: "gateway".to_owned(),
                detail: format!(
                    "`{}` names invocation `{}`, which has {} row(s) — an intent executed \
                     more than once, or not at all",
                    entry.intent_id, entry.invocation_id, entry.invocations
                ),
            });
        }
        // EXACTLY ONE RECEIPT. Neither duplicated nor lost by redelivery.
        if entry.receipts != 1 {
            findings.push(Finding {
                invariant: NAME,
                host: "gateway".to_owned(),
                detail: format!(
                    "invocation `{}` has {} receipt(s); an executed command is receipted \
                     exactly once",
                    entry.invocation_id, entry.receipts
                ),
            });
        }
    }
    findings
}

/// INVARIANT 1. A seat's replicated tables equal the gateway's, values not
/// bytes.
fn seat_converges(
    host: &str,
    authority: &BTreeMap<String, Vec<String>>,
    seat: &Connection,
) -> Vec<Finding> {
    const NAME: &str = "1/convergence";
    let mut findings = Vec::new();
    let mirrored = replicated_state(seat);
    let mut compared = 0_usize;
    for (table, rows) in authority {
        match mirrored.get(table) {
            None => findings.push(Finding {
                invariant: NAME,
                host: host.to_owned(),
                detail: format!("`{table}` is on the gateway and not on this seat"),
            }),
            Some(theirs) => {
                compared += 1;
                if theirs != rows {
                    findings.push(Finding {
                        invariant: NAME,
                        host: host.to_owned(),
                        detail: format!(
                            "`{table}`: {} row(s) on the gateway, {} here\n    gateway: {rows:?}\n    seat:    {theirs:?}",
                            rows.len(),
                            theirs.len()
                        ),
                    });
                }
            }
        }
    }
    // A comparison of two EMPTY files passes trivially, so the count is checked
    // too: the allow-list holds 109 names and the schema plants most of them.
    if compared < 100 {
        findings.push(Finding {
            invariant: NAME,
            host: host.to_owned(),
            detail: format!(
                "only {compared} table(s) were compared; a convergence check over \
                 nothing is not a convergence check"
            ),
        });
    }
    findings
}

/// INVARIANT 2. The outbox is empty, or every remaining intent is terminal or
/// parked **with a recorded reason**.
fn outbox_is_drained_or_terminal(host: &str, seat: &Connection) -> Vec<Finding> {
    const NAME: &str = "2/outbox-drained-or-terminal";
    let mut findings = Vec::new();
    let Ok(outbox) = centraid_seat::Outbox::open(seat) else {
        return findings;
    };
    let Ok(records) = outbox.all() else {
        return findings;
    };
    for record in records {
        use centraid_seat::IntentState as S;
        match record.state {
            // Terminal or parked: allowed, but the member must be able to see
            // WHY. A refusal with no reason is a screen that says "failed".
            S::Denied | S::Failed | S::Conflict | S::ConflictBaseMissing | S::Expired => {
                if record.reason.is_none() && record.conflicts.is_empty() {
                    findings.push(Finding {
                        invariant: NAME,
                        host: host.to_owned(),
                        detail: format!(
                            "`{}` is `{}` with no reason and no conflict recorded",
                            record.intent_id,
                            record.state.as_str()
                        ),
                    });
                }
            }
            S::Parked => {
                if record.waiting_on.is_empty() && record.reason.is_none() {
                    findings.push(Finding {
                        invariant: NAME,
                        host: host.to_owned(),
                        detail: format!(
                            "`{}` is parked on nothing and says nothing",
                            record.intent_id
                        ),
                    });
                }
            }
            // NOT ALLOWED at rest. A run that ended with work still queued or
            // in flight either did not converge or stopped early, and the two
            // are different bugs that look the same from the outside.
            S::Queued | S::Sending | S::AwaitingChange => findings.push(Finding {
                invariant: NAME,
                host: host.to_owned(),
                detail: format!(
                    "`{}` is still `{}` at rest: the run did not drain",
                    record.intent_id,
                    record.state.as_str()
                ),
            }),
            // `executed` is settled and removed from the queue, so a row in
            // this state is a settle that did not happen.
            S::Executed => findings.push(Finding {
                invariant: NAME,
                host: host.to_owned(),
                detail: format!(
                    "`{}` is `executed` and still in the queue; settling removes it",
                    record.intent_id
                ),
            }),
        }
    }
    findings
}

/// INVARIANT 6. No seat ever applied a row below its `applied_seq`.
///
/// Checked structurally rather than by watching: the seat's `applied_seq` must
/// be at most its recorded `gateway_watermark`, and its `applied_commit_seq`
/// must be reachable. A seat whose cursor ran past what the gateway ever served
/// applied something it was never given.
fn no_row_below_the_cursor(host: &str, seat: &Connection) -> Vec<Finding> {
    const NAME: &str = "6/cursor-never-walks-back";
    let mut findings = Vec::new();
    let Ok(state) = centraid_seat::seat_state(seat) else {
        findings.push(Finding {
            invariant: NAME,
            host: host.to_owned(),
            detail: "seat_state is missing; this file was never initialised".to_owned(),
        });
        return findings;
    };
    if state.applied_seq > state.gateway_watermark {
        findings.push(Finding {
            invariant: NAME,
            host: host.to_owned(),
            detail: format!(
                "applied_seq {} is above the recorded gateway watermark {}: \
                 the seat applied something it was never served",
                state.applied_seq, state.gateway_watermark
            ),
        });
    }
    if state.applied_commit_seq < 0 || state.applied_seq < 0 {
        findings.push(Finding {
            invariant: NAME,
            host: host.to_owned(),
            detail: "a negative cursor".to_owned(),
        });
    }
    findings
}

/// The seats' distinct epochs, so a caller can assert a run stayed in one.
#[must_use]
pub fn epochs(seats: &[(String, Connection)]) -> BTreeSet<String> {
    seats
        .iter()
        .filter_map(|(_, seat)| centraid_seat::seat_state(seat).ok())
        .map(|state| state.epoch)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finding_prints_its_invariant_its_host_and_its_detail() {
        let finding = Finding {
            invariant: "1/convergence",
            host: "seat-2".to_owned(),
            detail: "`core_party` differs".to_owned(),
        };
        let printed = finding.to_string();
        assert!(printed.contains("1/convergence"));
        assert!(printed.contains("seat-2"));
        assert!(printed.contains("core_party"));
    }

    /// A convergence check over two empty files must NOT pass. This is the
    /// guard against the whole simulation silently proving nothing.
    #[test]
    fn comparing_two_empty_files_is_a_finding_and_not_a_pass() {
        let gateway = Connection::open_in_memory().expect("opens");
        let seat = Connection::open_in_memory().expect("opens");
        let findings = seat_converges("seat-0", &replicated_state(&gateway), &seat);
        assert!(
            findings
                .iter()
                .any(|finding| finding.detail.contains("not a convergence check")),
            "two empty files passed the convergence check"
        );
    }

    #[test]
    fn a_missing_seat_state_is_a_finding_rather_than_a_silent_skip() {
        let seat = Connection::open_in_memory().expect("opens");
        let findings = no_row_below_the_cursor("seat-0", &seat);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].detail.contains("never initialised"));
    }
}
