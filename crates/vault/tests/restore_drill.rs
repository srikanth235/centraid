//! The snapshot plane's drill, end to end against `MemoryStore` (#1080).
//!
//! `backup2::drill::run` asserts every step itself and refuses with the step
//! that failed; this test runs it and holds the numbers it reports to the
//! claims #1080's acceptance makes of them.

use centraid_vault::backup2::drill;

#[test]
fn back_up_lose_everything_restore_and_prove_it() {
    let dir = tempfile::tempdir().expect("a directory");
    let report = drill::run(dir.path()).unwrap_or_else(|error| panic!("the drill: {error}"));
    eprintln!("{report:#?}");

    assert!(
        report.ranges_second > 2,
        "the drill's vault is several ranges: {} of them",
        report.ranges_second
    );
    assert!(
        report.sealed_second < report.ranges_second,
        "a second snapshot after 50 commits sealed {} of {} ranges",
        report.sealed_second,
        report.ranges_second
    );
    assert!(report.content_files > 0 && report.content_parts >= report.content_files);
    let checks: Vec<&str> = report.checks.iter().map(|check| check.name).collect();
    assert_eq!(
        checks,
        [
            "manifest",
            "ranges",
            "db_hash",
            "integrity_check",
            "header",
            "census"
        ]
    );
    assert!(report.rows > 0 && report.tables > 0);
}
