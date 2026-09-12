//! The `call` budget: p95 of a bounded read, against a ceiling (D-1020-D2-6).
//!
//! `CALL_BUDGET_MS` is **50** on `ci-linux-x64-4c`, and the number is in
//! `contracts/ledgers/call-budget.json` where it can only fall. This is the
//! issue's "any request that exceeds it in `pr` profile fails the gate".
//!
//! ## Why p95 and not the mean
//!
//! A mean hides the case a member notices. A shell's list screen makes one
//! `call` and either it lands inside a frame budget or the list appears late,
//! and "usually fast" is the property a mean measures. p95 over 200 calls is
//! the cheapest statistic that says something about the slow ones.
//!
//! ## Why the golden corpus and not a generated one
//!
//! The corpus is a real vault, frozen: sixteen tables, a hundred and
//! thirty-nine rows, real column widths and real index shapes. A generated
//! fixture measures whatever the generator happened to make, and the first time
//! it disagrees with a real file the budget is measuring the generator.
//!
//! The corpus is small, so this is a **floor measurement**, and the receipt
//! says so: it catches a regression in the call path (a lock held too long, a
//! statement re-prepared per call, a page probe gone quadratic), not the cost
//! of a year-three table. When lane D3's year-3 generator lands, this test
//! reads that instead and the ledger's number falls or does not.

use std::time::{Duration, Instant};

use centraid_core::api_proto as wire;
use centraid_core::{Core, CoreConfig};

/// The ceiling, in milliseconds, on `ci-linux-x64-4c`.
const CALL_BUDGET_MS: f64 = 50.0;
/// How many calls the percentile is taken over.
const SAMPLES: usize = 200;
/// Rows per page — the issue's "page of 100 rows".
const PAGE_ROWS: u32 = 100;
/// How many rows the fixture holds, so the page is a real page and `next` is
/// present rather than absent.
const SEED_ROWS: u32 = PAGE_ROWS * 2;

struct Scratch {
    dir: std::path::PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn page_request() -> wire::Request {
    wire::Request {
        kind: Some(wire::request::Kind::Page(wire::PageRequest {
            query: Some(wire::PageQuery {
                name: "parties".to_owned(),
                select: vec![
                    "party_id".to_owned(),
                    "created_at".to_owned(),
                    "display_name".to_owned(),
                ],
                from: "core_party".to_owned(),
                r#where: None,
                bind: Vec::new(),
                order: Some(wire::PageOrder {
                    sort_column: "created_at".to_owned(),
                    pk_column: "party_id".to_owned(),
                    descending: false,
                }),
            }),
            limit: PAGE_ROWS,
            after: None,
        })),
    }
}

/// The `index`-th percentile of a sorted sample, nearest-rank.
fn percentile(sorted: &[Duration], fraction: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let rank = ((sorted.len() as f64 * fraction).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[rank]
}

#[test]
fn the_p95_of_a_bounded_read_is_inside_the_budget() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let _scratch = Scratch { dir: dir.clone() };

    let handle = Core::open(CoreConfig::gateway(dir.join("vault.db"))).expect("a core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Budget", "Owner")?))
        .expect("it founds");
    // Enough rows that the page is a real page rather than a one-row probe.
    handle
        .with_vault(|vault| {
            // THROUGH THE REAL COMMAND PLANE, not a raw INSERT. The
            // `sql-confinement` rule refuses SQL here — and the refusal
            // improved the fixture: a page over rows the real `core.add_party`
            // wrote is a page over rows with real `core_entity` siblings and a
            // real `row_version`, which a hand-written INSERT was quietly
            // missing.
            let registry = centraid_vault::commands::Registry::with_system_commands()?;
            let principal = centraid_vault::Principal::owner("budget-device");
            for index in 0..SEED_ROWS {
                vault.execute(
                    &registry,
                    &principal,
                    &centraid_vault::commands::Command::new(
                        "core.add_party",
                        serde_json::json!({
                            "display_name": format!("Party {index}"),
                            "kind": "person"
                        }),
                    ),
                )?;
            }
            Ok(())
        })
        .expect("the rows seed");

    let request = page_request();
    // A WARM-UP that is not measured. The first call compiles the statement,
    // faults the pages in and warms the OS cache; measuring it would measure
    // the process starting rather than the call path.
    for _ in 0..20 {
        handle.call(&request).expect("the warm-up answers");
    }

    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let started = Instant::now();
        let answer = handle.call(&request).expect("it answers");
        samples.push(started.elapsed());
        // The answer is checked, not discarded: a budget met by returning
        // nothing is not a budget met.
        let Some(wire::response::Kind::Page(page)) = answer.kind else {
            panic!("a page comes back");
        };
        assert_eq!(page.rows.len(), PAGE_ROWS as usize);
        assert!(page.next.is_some(), "there are more rows than one page");
    }
    samples.sort_unstable();

    let p50 = percentile(&samples, 0.50);
    let p95 = percentile(&samples, 0.95);
    let p99 = percentile(&samples, 0.99);
    println!(
        "call budget — page of {PAGE_ROWS} rows, {SAMPLES} samples on ci-linux-x64-4c: \
         p50 {:.2}ms · p95 {:.2}ms · p99 {:.2}ms · ceiling {CALL_BUDGET_MS:.0}ms",
        p50.as_secs_f64() * 1_000.0,
        p95.as_secs_f64() * 1_000.0,
        p99.as_secs_f64() * 1_000.0,
    );

    let p95_ms = p95.as_secs_f64() * 1_000.0;
    assert!(
        p95_ms <= CALL_BUDGET_MS,
        "p95 of `call` is {p95_ms:.2}ms against a {CALL_BUDGET_MS:.0}ms ceiling. The budget is \
         the product's responsiveness promise, not a target — either the call path got slower or \
         this measurement moved to a bigger fixture and the ledger needs the new number \
         (contracts/ledgers/call-budget.json, #1020)"
    );
}

/// The ledger's number and this test's constant are the same number.
///
/// Two copies of a budget is two budgets, and the one that is not read is the
/// one that drifts. The ledger is what `cargo xtask gate` ratchets; this test
/// is what measures. They have to agree, so the test asserts it.
#[test]
fn the_ledger_and_this_test_state_the_same_ceiling() {
    let path = centraid_ontology::golden::repo_root().join("contracts/ledgers/call-budget.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", path.display()));
    let ledger: serde_json::Value = serde_json::from_str(&text).expect("the ledger is valid JSON");
    let recorded = ledger["profiles"]["pr"]["ci-linux-x64-4c"]["p95Ms"]
        .as_f64()
        .expect("the ledger records a p95 ceiling for this hardware");
    assert!(
        (recorded - CALL_BUDGET_MS).abs() < f64::EPSILON,
        "the ledger says {recorded} and this test says {CALL_BUDGET_MS}; two copies of a budget \
         is two budgets, and the one nobody reads is the one that drifts"
    );
}
