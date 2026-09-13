//! The CONVERGENCE and ATOMICITY gates, replayed through the SEAT applier.
//!
//! `contracts/applier/{convergence,atomicity}.json` are lane D1's fixtures and
//! `crates/vault/tests/gates.rs` runs them through the gateway-side applier.
//! This file runs the same files through [`centraid_seat::apply_page`], which
//! is the applier a phone actually runs. That is the point of the fixtures
//! being data: one claim, two implementations, and a divergence is a test
//! failure rather than a member's wrong answer.
//!
//! The difference between the two runs is not the rules — they are the same
//! four — but the cursor. The gateway-side applier is handed one and hands one
//! back; the seat applier reads and writes `seat_state`, which is what makes
//! rule 2 ("the cursor rides in the transaction") a durable claim rather than a
//! return value.

mod common;

use centraid_seat::applier::ApplyHooks;
use common::Harness;

#[test]
fn convergence_a_seat_fed_the_log_equals_the_gateway_at_the_watermark() {
    let fixture = common::fixture("convergence.json");
    assert_eq!(fixture["schema"], "centraid-applier-convergence/1");

    let harness = Harness::founded("seat-convergence");
    for commit in fixture["script"]["beforeCopy"]
        .as_array()
        .expect("there is a before phase")
    {
        harness.run_commit(commit);
    }

    let seat = harness.bootstrap_seat("seat");

    for commit in fixture["script"]["afterCopy"]
        .as_array()
        .expect("there is an after phase")
    {
        harness.run_commit(commit);
    }

    let page = harness.page(seat.floor, &seat.epoch, 10_000);
    let report = centraid_seat::apply_page(
        &seat.connection,
        &seat.header(page.watermark.seq),
        &page.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the seat applies the page");

    assert_eq!(
        i64::try_from(report.commits).unwrap_or(-1),
        fixture["expect"]["appliedCommits"]
            .as_i64()
            .expect("the fixture says how many"),
        "one transaction per commit, and the count is the fixture's"
    );
    // THE CURSOR IS DURABLE, not merely returned. This is the half the
    // gateway-side applier cannot claim.
    let state = centraid_seat::seat_state(&seat.connection).expect("the state reads");
    assert_eq!(state.applied_seq, page.watermark.seq);
    assert_eq!(report.cursor, page.watermark.seq);
    assert!(
        state.applied_commit_seq > 0,
        "the seat learned which commit its cursor belongs to"
    );

    // EVERY REPLICATED TABLE, VALUES NOT BYTES.
    let gateway = harness
        .vault
        .read(|connection| Ok(common::replicated_state(connection)))
        .expect("the gateway state reads");
    let mirrored = common::replicated_state(&seat.connection);

    let mut findings: Vec<String> = Vec::new();
    let mut compared = 0_usize;
    for (table, rows) in &gateway {
        match mirrored.get(table) {
            None => findings.push(format!("`{table}` is on the gateway and not on the seat")),
            Some(theirs) => {
                compared += 1;
                if theirs != rows {
                    findings.push(format!(
                        "`{table}`: {} row(s) on the gateway, {} on the seat\n  gateway: {rows:?}\n  seat:    {theirs:?}",
                        rows.len(),
                        theirs.len()
                    ));
                }
            }
        }
    }
    assert_eq!(findings.join("\n"), "");
    assert!(
        compared > 100,
        "only {compared} table(s) were compared; the allow-list holds 109"
    );

    for named in fixture["compare"]["named"]
        .as_array()
        .expect("the fixture names tables")
    {
        let table = named.as_str().expect("a table name is text");
        assert!(
            mirrored.contains_key(table),
            "`{table}` was named and is not on the seat"
        );
    }

    // The row set the fixture states, so two equally-wrong files cannot pass.
    // `conv-b` was DELETED after the copy: a seat that only ever inserted
    // would still hold it.
    let expected: Vec<&str> = fixture["expect"]["partiesAtWatermark"]
        .as_array()
        .expect("the fixture lists them")
        .iter()
        .map(|value| value.as_str().expect("a party id is text"))
        .collect();
    let mut statement = seat
        .connection
        .prepare("SELECT party_id FROM core_party WHERE party_id LIKE 'conv-%' ORDER BY party_id")
        .expect("the query prepares");
    let actual: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read");
    assert_eq!(actual, expected);
}

/// How many commits of a page to feed: all of them, or the first _n_.
fn slice(
    rows: &[centraid_vault::log::LogRow],
    selector: &serde_json::Value,
) -> Vec<centraid_vault::log::LogRow> {
    let Some(commits) = selector.get("commits").and_then(serde_json::Value::as_i64) else {
        assert_eq!(
            selector.as_str(),
            Some("all"),
            "a selector is `all` or {{commits}}"
        );
        return rows.to_vec();
    };
    let mut seen: Vec<i64> = Vec::new();
    rows.iter()
        .filter(|row| {
            if !seen.contains(&row.commit_seq) {
                seen.push(row.commit_seq);
            }
            let position = seen
                .iter()
                .position(|seq| *seq == row.commit_seq)
                .expect("it was just pushed");
            i64::try_from(position).unwrap_or(i64::MAX) < commits
        })
        .cloned()
        .collect()
}

#[test]
fn atomicity_a_crash_mid_batch_is_completed_and_a_duplicate_lands_once() {
    let fixture = common::fixture("atomicity.json");
    assert_eq!(fixture["schema"], "centraid-applier-atomicity/1");
    let cases = fixture["cases"].as_array().expect("there are cases");
    assert_eq!(cases.len(), 3);

    for case in cases {
        let name = case["name"].as_str().expect("a case is named");
        let harness = Harness::founded("seat-atomicity");
        let seat = harness.bootstrap_seat("seat");
        for commit in fixture["script"]["commits"]
            .as_array()
            .expect("there is a script")
        {
            harness.run_commit(commit);
        }
        let page = harness.page(seat.floor, &seat.epoch, 10_000);
        let watermark = page.watermark.seq;

        let first = slice(&page.rows, &case["applyFirst"]);
        centraid_seat::apply_page(
            &seat.connection,
            &seat.header(watermark),
            &first,
            &mut ApplyHooks::default(),
        )
        .unwrap_or_else(|error| panic!("`{name}` first pass: {error}"));
        let cursor_after_first = centraid_seat::seat_state(&seat.connection)
            .expect("reads")
            .applied_seq;

        let then = slice(&page.rows, &case["thenApply"]);
        let second = centraid_seat::apply_page(
            &seat.connection,
            &seat.header(watermark),
            &then,
            &mut ApplyHooks::default(),
        )
        .unwrap_or_else(|error| panic!("`{name}` second pass: {error}"));

        let expected_parties: Vec<&str> = case["expectParties"]
            .as_array()
            .expect("the case lists parties")
            .iter()
            .map(|value| value.as_str().expect("a party id is text"))
            .collect();
        let mut statement = seat
            .connection
            .prepare(
                "SELECT party_id FROM core_party WHERE party_id LIKE 'atom-%' ORDER BY party_id",
            )
            .expect("the query prepares");
        let parties: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("runs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("reads");
        assert_eq!(parties, expected_parties, "`{name}`: the row set");

        let display: String = seat
            .connection
            .query_row(
                "SELECT display_name FROM core_party WHERE party_id = 'atom-a'",
                [],
                |row| row.get(0),
            )
            .expect("the row is there");
        let fixture_expectation = case["expectDisplayNameOfA"]
            .as_str()
            .expect("the case states it");

        if case["thenApply"].get("commits").is_some() {
            // THE ONE PLACE THE SEAT APPLIER IS STRONGER THAN THE GATEWAY'S,
            // and the fixture says why in its own `$why`: the gateway-side
            // applier is a faithful mirror of the image it was handed, so
            // re-feeding commit 1 puts `atom-a` BACK to `A`, and what makes
            // that safe is that a seat never asks for rows below its cursor.
            //
            // The seat applier makes that structural rather than procedural.
            // RULE 5 drops a row at or below `applied_seq` BEFORE it is bound,
            // so the stale image never reaches a statement at all. The fixture
            // is D1's and states D1's applier's answer; this is the seat's, and
            // it is the stronger of the two.
            assert_eq!(
                fixture_expectation, "A",
                "the fixture states the gateway applier's answer for this case"
            );
            assert_eq!(
                display, "A renamed",
                "`{name}`: rule 5 drops the stale image before binding it, so the \
                 seat does not walk backwards even when the wire does"
            );
            assert_eq!(second.applied, 0, "`{name}`: nothing was bound");
            assert_eq!(
                second.duplicate,
                then.len(),
                "`{name}`: all dropped as seen"
            );
        } else {
            assert_eq!(display, fixture_expectation, "`{name}`: the value");
        }

        let state = centraid_seat::seat_state(&seat.connection).expect("reads");
        if case["expectCursorUnchanged"].as_bool().unwrap_or(false) {
            assert_eq!(
                state.applied_seq, cursor_after_first,
                "`{name}`: the cursor did not move on the second pass"
            );
        }
        assert_eq!(
            state.applied_seq, watermark,
            "`{name}`: the cursor is at the watermark"
        );
    }
}

/// Halfway through the span, then the rest. The claim is that the two halves
/// land the same state one pass would have, which is what "a crash mid-batch is
/// completed by the next attempt" means for a seat whose cursor is durable.
#[test]
fn a_span_delivered_in_two_halves_lands_what_one_pass_would_have() {
    let fixture = common::fixture("convergence.json");
    let harness = Harness::founded("seat-halves");
    for commit in fixture["script"]["beforeCopy"]
        .as_array()
        .expect("a before phase")
    {
        harness.run_commit(commit);
    }
    let whole = harness.bootstrap_seat("whole");
    let halves = harness.bootstrap_seat("halves");
    for commit in fixture["script"]["afterCopy"]
        .as_array()
        .expect("an after phase")
    {
        harness.run_commit(commit);
    }

    let page = harness.page(whole.floor, &whole.epoch, 10_000);
    centraid_seat::apply_page(
        &whole.connection,
        &whole.header(page.watermark.seq),
        &page.rows,
        &mut ApplyHooks::default(),
    )
    .expect("one pass");

    // Two pages, each ending on a commit edge because the door says so.
    let first = harness.page(halves.floor, &halves.epoch, 2);
    centraid_seat::apply_page(
        &halves.connection,
        &halves.header(first.watermark.seq),
        &first.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the first half");
    let cursor = centraid_seat::seat_state(&halves.connection)
        .expect("reads")
        .applied_seq;
    assert!(cursor > halves.floor, "the first half moved the cursor");
    let second = harness.page(cursor, &halves.epoch, 10_000);
    centraid_seat::apply_page(
        &halves.connection,
        &halves.header(second.watermark.seq),
        &second.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the second half");

    assert_eq!(
        common::replicated_state(&halves.connection),
        common::replicated_state(&whole.connection),
        "two halves and one pass land the same file"
    );
}
