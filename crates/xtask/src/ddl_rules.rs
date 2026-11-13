//! Rules over the vault's DDL (#1191, V3): `no-host-clock-in-ddl`.
//!
//! A column default or a trigger that reads the host clock makes the file's stamps the machine's
//! and not the injected clock's: a restore, a test and a replay all stamp differently. The commands
//! stamp the clock they were handed. `strftime(<format>, <column>)` is not a clock read (the
//! baseline uses it to check a time column's shape), so what is refused is the clock itself:
//! `'now'` in any date function, `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME`, and
//! `unixepoch()` or `julianday()` with no argument.

use std::fs;
use std::path::Path;

use crate::rules::{RuleReport, source_files};

const NAME: &str = "no-host-clock-in-ddl";

/// Every `.sql` ladder this rule watches. The gateway's and device state's ladders join when they
/// have one.
const LADDER_DIRS: [&str; 1] = ["contracts/migrations"];

/// Every DDL rule.
pub fn all(root: &Path) -> Vec<RuleReport> {
    vec![no_host_clock_in_ddl(root)]
}

pub fn no_host_clock_in_ddl(root: &Path) -> RuleReport {
    let mut findings = Vec::new();
    let mut scanned = 0;
    for dir in LADDER_DIRS {
        for file in source_files(&root.join(dir), "sql") {
            let Ok(source) = fs::read_to_string(&file) else {
                continue;
            };
            scanned += 1;
            for (line, token) in host_clock_reads(&source) {
                findings.push(format!(
                    "{}:{line} reads the host clock (`{token}`): a column default or a trigger never does; the command stamps the injected clock",
                    file.strip_prefix(root).unwrap_or(&file).display()
                ));
            }
        }
    }
    RuleReport::applied(NAME, scanned, findings)
}

/// `(line, token)` for every host-clock read in a SQL source, comments excluded.
pub fn host_clock_reads(source: &str) -> Vec<(usize, &'static str)> {
    let mut hits = Vec::new();
    for (index, raw) in source.lines().enumerate() {
        let line = raw.split("--").next().unwrap_or("").to_ascii_lowercase();
        for token in [
            "'now'",
            "current_timestamp",
            "current_date",
            "current_time",
            "unixepoch()",
            "julianday()",
        ] {
            if line.contains(token) {
                // One finding per line: `current_time` is inside `current_timestamp`.
                hits.push((index + 1, token));
                break;
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::fixture_dir;

    fn ladder(name: &str, sql: &str) -> std::path::PathBuf {
        let root = fixture_dir(name);
        let dir = root.join("contracts/migrations");
        fs::create_dir_all(&dir).expect("a ladder directory");
        fs::write(dir.join("001_baseline.sql"), sql).expect("a rung");
        root
    }

    #[test]
    fn a_default_that_reads_now_is_a_finding() {
        let root = ladder(
            "ddl-now",
            "CREATE TABLE t (at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));\n\
             CREATE TABLE u (at TEXT DEFAULT CURRENT_TIMESTAMP);\n",
        );
        let report = no_host_clock_in_ddl(&root);
        assert_eq!(report.findings.len(), 2, "{:?}", report.findings);
    }

    #[test]
    fn a_shape_check_a_comment_and_a_clean_ladder_are_not() {
        let root = ladder(
            "ddl-clean",
            "-- never DEFAULT CURRENT_TIMESTAMP\n\
             CREATE TABLE t (at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at));\n",
        );
        assert!(no_host_clock_in_ddl(&root).findings.is_empty());
    }

    #[test]
    fn the_committed_baseline_reads_no_host_clock() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let report = no_host_clock_in_ddl(&root);
        assert!(report.findings.is_empty(), "{:?}", report.findings);
    }
}
