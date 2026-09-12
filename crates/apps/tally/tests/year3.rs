//! THE YEAR-3 TALLY CEILING, measured.
//!
//! Tally's stated window is 2,000 expenses and its stated fan-out 8,000 split
//! rows (`queries/dashboard.ts:52-61`). Until this file, nothing in either tree
//! could seed that volume: v0's year-3 generator writes one `tally_group` and
//! **no expense, split or settlement rows at all** (#1020 apps §5.2), and the
//! one number on record — 188 ms — came from an ad-hoc seeding in the #922
//! spike on a Node host over node-sqlite, which #1020 says establishes nothing
//! about a phone.
//!
//! So this test does two things a ceiling needs: it **reaches** the volume, and
//! it **times** the read. The number it prints is a projected provenance note,
//! not a budget — `ci-linux-x64-4c` is a container, and the absolute targets in
//! the journey ledger are for the reference devices. What the number is for is
//! stating an order of magnitude before wave 3 measures the real one, and
//! catching the day the read stops being linear.
//!
//! Run it on its own, because it seeds 2,000 expenses:
//!
//! ```text
//! cargo test -p centraid-apps-tally --test year3 -- --nocapture
//! ```

use std::time::Instant;

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{
    YEAR3_DEFAULT_SEED, YEAR3_TALLY, Year3TallyCounts, Year3TallyShape, year3_tally,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_tally::balance::{group_net, group_pair_nets};
use centraid_apps_tally::queries::{LEDGER_FAN_OUT, load_dashboard_extras, load_tally};
use rusqlite::Connection;

/// Seed the profile into a vault built from the COMMITTED schema, and hand
/// back the connection. The generator creates no tables; see its module note.
fn seeded(shape: Year3TallyShape) -> (Connection, Year3TallyCounts) {
    let ddl = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../contracts/schema/vault-ddl.sql"),
    )
    .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("the model is created");
    let counts = year3_tally(&connection, shape, YEAR3_DEFAULT_SEED).expect("the ledger seeds");
    println!(
        "seeded: {} expenses ({} live), {} splits, {} payers, {} settlements, {} groups, {} parties",
        counts.expenses,
        counts.live_expenses,
        counts.splits,
        counts.payers,
        counts.settlements,
        counts.groups,
        counts.parties
    );
    (connection, counts)
}

/// The measurement, and the two facts that make it mean something: the volume
/// was reached, and the answer reconciles.
#[test]
fn load_tally_at_the_year3_tally_volume() {
    let (connection, counts) = seeded(YEAR3_TALLY);
    let door = TestDoor::new(&connection);

    // The fan-out has to be able to reach the split rows this volume makes, or
    // the measurement is of a read that refused. 2,000 × 4 sharers is exactly
    // `LEDGER_FAN_OUT`'s reachable cap (D-1020-D3-12).
    assert_eq!(
        YEAR3_TALLY.expenses * YEAR3_TALLY.sharers_per_expense,
        LEDGER_FAN_OUT.cap(),
        "the profile must sit ON the stated ceiling, not under it"
    );

    let started = Instant::now();
    let data = load_tally(&door).expect("loadTally reads the year-3 ledger");
    let (trash, recurring, exceptions) =
        load_dashboard_extras(&door).expect("the dashboard's three extra pages read");
    let read = started.elapsed();

    let folded = Instant::now();
    let balances = data.balance_data();
    let mut pairs = 0usize;
    for group in &data.groups {
        let net = group_net(&balances, &group.group_id);
        let pair = group_pair_nets(&balances, &group.group_id);
        pairs += pair.len();
        for (party, row) in &pair {
            assert_eq!(
                row.values().sum::<i64>(),
                -net.get(party).copied().unwrap_or(0),
                "{}: the pair row of {party} does not reconcile at year-3 volume",
                group.name
            );
        }
    }
    let fold = folded.elapsed();

    // The volume was actually reached, rather than a short read being timed.
    // Against the generator's OWN count, not a formula restated here: two
    // statements of how many rows were trashed is one too many.
    assert_eq!(
        data.expenses.len(),
        counts.live_expenses,
        "the live window must hold every live expense"
    );
    assert_eq!(
        trash.len(),
        counts.expenses - counts.live_expenses,
        "and the trash shelf must hold the rest"
    );
    assert_eq!(data.groups.len(), YEAR3_TALLY.groups);
    assert_eq!(
        data.splits
            .values()
            .map(std::collections::BTreeMap::len)
            .sum::<usize>(),
        YEAR3_TALLY.expenses * YEAR3_TALLY.sharers_per_expense
    );
    assert_eq!(recurring.len(), YEAR3_TALLY.recurring);
    assert!(
        exceptions.is_empty(),
        "the generator writes no exceptions yet"
    );

    // PROJECTED PROVENANCE, not a budget. The journey ledger's row is the
    // root's and its hardware cell is a reference device; this is a container.
    println!(
        "tally/loadTally/year3-tally/ci-linux-x64-4c: read {} ms, fold {} ms over {} pair rows \
         ({} live expenses, {} split rows)",
        read.as_millis(),
        fold.as_millis(),
        pairs,
        data.expenses.len(),
        YEAR3_TALLY.expenses * YEAR3_TALLY.sharers_per_expense,
    );
    // A soft tripwire, two orders of magnitude over the measured number, so it
    // catches the day the read stops being linear and never flakes on a busy
    // container. The real budget is wave 3's, on a device.
    assert!(
        read.as_millis() < 10_000,
        "loadTally took {} ms at year-3 volume; something stopped being linear",
        read.as_millis()
    );
}
