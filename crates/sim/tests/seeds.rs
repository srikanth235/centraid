//! `SIM_SEEDS` schedules, every invariant after each one.
//!
//! This is the test the exit criterion names: *"deterministic simulation (one
//! gateway, N seats, scripted network, fixed seed) asserts convergence and
//! receipt invariants after every schedule, runs on every PR"*.
//!
//! `SIM_SEEDS=250 cargo test -p centraid-sim` for the nightly count;
//! `SIM_SEED=<n>` to run one seed alone, which is what a failure's own output
//! tells you to do.

use centraid_sim::{Schedule, check_invariants, run_schedule};

/// A scratch directory removed on drop, so a run does not leave a vault behind.
struct Scratch(std::path::PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run one seed, returning the findings and the report lines.
fn run_seed(seed: u64) -> (Vec<String>, Vec<Vec<String>>) {
    let schedule = Schedule::from_seed(seed);
    let dir = centraid_ontology::golden::scratch_dir();
    let scratch = Scratch(dir.clone());
    let outcome = run_schedule(&schedule, &dir);

    let mut findings: Vec<String> = Vec::new();
    if let Some(error) = &outcome.turmoil {
        findings.push(format!("[0/turmoil] the world itself: {error}"));
    }
    {
        let (gateway, seats) = outcome.open();
        findings.extend(
            check_invariants(&gateway, &seats)
                .into_iter()
                .map(|finding| finding.to_string()),
        );
    }
    let reports = outcome.reports.clone();
    drop(scratch);
    (findings, reports)
}

/// The report a failure prints: the seed, the schedule as JSON, and the passes.
fn failure_report(seed: u64, findings: &[String], reports: &[Vec<String>]) -> String {
    let schedule = Schedule::from_seed(seed);
    let mut out = String::new();
    out.push_str(&format!(
        "\n\nSIM_SEED={seed}\n\nReproduce with:\n  \
         SIM_SEED={seed} cargo test -p centraid-sim --test seeds\n\nSchedule:\n{}\n",
        serde_json::to_string_pretty(&schedule.to_json()).unwrap_or_default()
    ));
    out.push_str("\nPasses:\n");
    for (index, lines) in reports.iter().enumerate() {
        out.push_str(&format!("  seat-{index}:\n"));
        for line in lines {
            out.push_str(&format!("    {line}\n"));
        }
    }
    out.push_str(&format!("\n{} finding(s):\n", findings.len()));
    for finding in findings {
        out.push_str(&format!("  {finding}\n"));
    }
    out.push_str(
        "\nIf this seed found a real bug, record it in contracts/sim/failing-seeds.json \
         with the bug and the commit that fixed it, so tests/recorded_seeds.rs replays \
         it forever (#1020).\n",
    );
    out
}

#[test]
fn every_seed_converges_and_every_invariant_holds() {
    // One seed alone, when a developer is reproducing a failure.
    if let Some(seed) = centraid_sim::single_seed() {
        let (findings, reports) = run_seed(seed);
        assert!(
            findings.is_empty(),
            "{}",
            failure_report(seed, &findings, &reports)
        );
        println!("SIM_SEED={seed}: clean");
        return;
    }

    let count = centraid_sim::seed_count();
    let started = std::time::Instant::now();
    let mut failed: Vec<u64> = Vec::new();
    for seed in 0..count {
        let (findings, reports) = run_seed(seed);
        if !findings.is_empty() {
            // Print every failing seed rather than stopping at the first: a
            // change that breaks twenty seeds and a change that breaks one are
            // different changes, and a fail-fast run cannot tell them apart.
            println!("{}", failure_report(seed, &findings, &reports));
            failed.push(seed);
        }
    }
    println!(
        "sim: {count} seed(s) in {:.1}s, {} failing",
        started.elapsed().as_secs_f64(),
        failed.len()
    );
    assert!(
        failed.is_empty(),
        "{} of {count} seed(s) failed: {failed:?}. Each one's schedule is printed above.",
        failed.len()
    );
}

/// A seed run twice lands the same state.
///
/// The determinism claim is what makes a recorded seed worth recording, and it
/// is a claim about the WHOLE RUN rather than about the schedule — which
/// `schedule.rs`'s own test already covers. Two runs of one seed must converge
/// to the same gateway state, or a failing seed would be a coin toss.
#[test]
fn a_seed_run_twice_reaches_the_same_state() {
    let seed = 3;
    let schedule = Schedule::from_seed(seed);

    let mut states = Vec::new();
    for _ in 0..2 {
        let dir = centraid_ontology::golden::scratch_dir();
        let scratch = Scratch(dir.clone());
        let outcome = run_schedule(&schedule, &dir);
        let (gateway, _) = outcome.open();
        states.push(centraid_sim::invariants::replicated_state(&gateway));
        drop(gateway);
        drop(scratch);
    }
    assert_eq!(
        states[0], states[1],
        "seed {seed} did not reach the same state twice; a failing seed would be a coin toss"
    );
}

/// The simulation must actually do something.
///
/// The guard against the whole suite passing because nothing happened: a run
/// whose gateway executed no command converges trivially, and so would a run
/// against a stub.
#[test]
fn a_run_actually_writes_through_the_real_command_plane() {
    let schedule = Schedule::from_seed(1);
    let dir = centraid_ontology::golden::scratch_dir();
    let scratch = Scratch(dir.clone());
    let outcome = run_schedule(&schedule, &dir);
    let (gateway, seats) = outcome.open();

    let invocations =
        centraid_vault::converge::executed_invocations(&gateway).expect("the audit band reads");
    assert!(
        invocations >= 1,
        "seed 1 executed no command; the run converged because nothing happened\n{}",
        failure_report(1, &[], &outcome.reports)
    );

    // And the parties the workload asked for are on the gateway AND mirrored.
    let on_gateway =
        centraid_vault::converge::row_count(&gateway, "core_party").expect("the parties read");
    assert!(on_gateway > 1, "only the owner party exists");
    for (host, seat) in &seats {
        let mirrored =
            centraid_vault::converge::row_count(seat, "core_party").expect("the mirror reads");
        assert_eq!(
            mirrored, on_gateway,
            "{host} holds {mirrored} parties and the gateway holds {on_gateway}"
        );
    }
    drop(gateway);
    drop(seats);
    drop(scratch);
}
