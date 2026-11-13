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

/// Every `.sql` ladder these rules watch: the vault's, the phone's device state's and the gateway's.
const LADDER_DIRS: [&str; 3] = [
    "contracts/migrations",
    "crates/vault/src/backup/state_ladder",
    "crates/gateway/src/server/sql/ladder",
];

/// Where each ladder's file is founded, and the constant that stamps its `application_id`: a
/// database the code opens says which program's file it is and how far up the ladder it stands
/// (#1191, L2).
const LADDERS: [(&str, &[&str], &str); 3] = [
    (
        "contracts/migrations",
        &["crates/vault/src/format.rs", "crates/vault/src/file.rs"],
        "APPLICATION_ID",
    ),
    (
        "crates/vault/src/backup/state_ladder",
        &["crates/vault/src/backup/state.rs"],
        "STATE_APPLICATION_ID",
    ),
    (
        "crates/gateway/src/server/sql/ladder",
        &["crates/gateway/src/server/state.rs"],
        "APPLICATION_ID",
    ),
];

/// A table of a key and a value and nothing else is state no one can check: each fact of a ladder
/// is a column of its own, with its type and its CHECK (#1191, L2).
const KEY_VALUE_NAMES: [&str; 4] = ["meta", "kv", "settings", "key_value"];

/// Every DDL rule.
pub fn all(root: &Path) -> Vec<RuleReport> {
    vec![
        no_host_clock_in_ddl(root),
        every_database_has_an_application_id_and_ladder(root),
        no_key_value_state_table(root),
        phone_authority_needs_verify(root),
    ]
}

/// THE PHONE ACTS ONLY ON SIGNED ANSWERS (#1191, L2). A gateway answers a head, an epoch and a
/// `MOVED`; each must be proved under the vault key before the phone records it. The proof sits in
/// two places and this rule holds them there: the client verifies every head it hands up
/// (`verify_head` inside `head_state`, so every `state.head` a phone reads is already proved), and
/// a `MOVED` is believed only where a claim is verified (`verify_claim`).
pub fn phone_authority_needs_verify(root: &Path) -> RuleReport {
    const NAME: &str = "phone-authority-needs-verify";
    const CLIENT: &str = "crates/gateway/src/client/mod.rs";
    const PHONE: &str = "crates/core/src/phone";
    let mut findings = Vec::new();
    let mut scanned = 0;
    match fs::read_to_string(root.join(CLIENT)) {
        Ok(source) => {
            scanned += 1;
            let body = source
                .split_once("pub async fn head_state")
                .map(|(_, rest)| rest.split("\n    pub ").next().unwrap_or(rest).to_owned());
            match body {
                Some(body) if body.contains("verify_head") => {}
                Some(_) => findings.push(format!(
                    "{CLIENT}: `head_state` hands a head up without `verify_head`: a phone would act on a gateway's word"
                )),
                None => findings.push(format!("{CLIENT} has no `head_state`: this rule watches the wrong place")),
            }
        }
        Err(_) => findings.push(format!(
            "{CLIENT} does not exist: this rule watches the wrong place"
        )),
    }
    for file in source_files(&root.join(PHONE), "rs") {
        let Ok(source) = fs::read_to_string(&file) else {
            continue;
        };
        scanned += 1;
        let code: String = source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // The wire answer, not the phone's own `StoreError::Moved`: every consumer of that one is
        // downstream of the single site that proves the claim.
        if code.contains("WireRefusal::Moved") && !code.contains("verify_claim") {
            findings.push(format!(
                "{}: reads a gateway's `MOVED` without verifying its claim (`verify_claim`): a takeover is believed only with proof",
                file.strip_prefix(root).unwrap_or(&file).display()
            ));
        }
    }
    RuleReport::applied(NAME, scanned, findings)
}

/// Every ladder is a numbered series of `.sql` rungs, and the code that founds its file stamps an
/// `application_id` and a `user_version`.
pub fn every_database_has_an_application_id_and_ladder(root: &Path) -> RuleReport {
    const NAME: &str = "every-database-has-an-id-and-a-ladder";
    let mut findings = Vec::new();
    for (ladder, founders, id) in LADDERS {
        let rungs = source_files(&root.join(ladder), "sql");
        if rungs.is_empty() {
            findings.push(format!("{ladder} holds no rung: a database without a ladder cannot say how far up it stands"));
        }
        for rung in &rungs {
            let name = rung.file_name().unwrap_or_default().to_string_lossy();
            if !name[..3.min(name.len())]
                .chars()
                .all(|c| c.is_ascii_digit())
            {
                findings.push(format!(
                    "{ladder}/{name} is not a numbered rung (`001_founding.sql`)"
                ));
            }
        }
        let mut sources = String::new();
        for founder in founders {
            match fs::read_to_string(root.join(founder)) {
                Ok(source) => sources.push_str(&source),
                Err(_) => findings.push(format!(
                    "{founder} does not exist: {ladder}'s file is founded somewhere this rule cannot see"
                )),
            }
        }
        for wanted in [id, "user_version"] {
            if !sources.contains(wanted) {
                findings.push(format!(
                    "{}: never names `{wanted}`: the file {ladder} founds must stamp its application id and its rung count",
                    founders.join(", ")
                ));
            }
        }
    }
    RuleReport::applied(NAME, LADDERS.len(), findings)
}

/// No ladder holds a key-value state table.
pub fn no_key_value_state_table(root: &Path) -> RuleReport {
    const NAME: &str = "no-key-value-state-table";
    let mut findings = Vec::new();
    let mut scanned = 0;
    for dir in LADDER_DIRS {
        for file in source_files(&root.join(dir), "sql") {
            let Ok(source) = fs::read_to_string(&file) else {
                continue;
            };
            scanned += 1;
            let shown = file
                .strip_prefix(root)
                .unwrap_or(&file)
                .display()
                .to_string();
            for (table, columns) in tables_in(&source) {
                if KEY_VALUE_NAMES.contains(&table.as_str()) {
                    findings.push(format!(
                        "{shown}: `{table}` is a key-value state table by name: every fact of a ladder is a column of its own, with its type and its CHECK"
                    ));
                } else if columns.len() == 2
                    && columns.iter().any(|column| column == "key")
                    && columns.iter().any(|column| column == "value")
                {
                    findings.push(format!(
                        "{shown}: `{table}` has exactly a key and a value: every fact of a ladder is a column of its own, with its type and its CHECK"
                    ));
                }
            }
        }
    }
    RuleReport::applied(NAME, scanned, findings)
}

/// `(table, its column names)` for every `CREATE TABLE` of a SQL source, comments excluded. A line
/// that opens a constraint rather than a column (`PRIMARY KEY (…)`, `CHECK (…)`) is not a column.
fn tables_in(source: &str) -> Vec<(String, Vec<String>)> {
    let mut found = Vec::new();
    let mut open: Option<(String, Vec<String>)> = None;
    for raw in source.lines() {
        let line = raw.split("--").next().unwrap_or("").trim();
        if let Some(rest) = line.strip_prefix("CREATE TABLE ") {
            let name = rest
                .split(|c: char| c.is_whitespace() || c == '(')
                .next()
                .unwrap_or("")
                .trim_matches('"');
            open = Some((name.to_owned(), Vec::new()));
            continue;
        }
        let Some((_, columns)) = open.as_mut() else {
            continue;
        };
        if line.starts_with(')') {
            found.push(open.take().expect("a table is open"));
            continue;
        }
        let word = line
            .split(|c: char| c.is_whitespace() || c == '(')
            .next()
            .unwrap_or("")
            .trim_matches('"');
        if word.is_empty()
            || [
                "PRIMARY",
                "UNIQUE",
                "CHECK",
                "FOREIGN",
                "CONSTRAINT",
                "WITHOUT",
            ]
            .contains(&word)
        {
            continue;
        }
        columns.push(word.to_ascii_lowercase());
    }
    found
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
    fn a_key_value_table_is_a_finding_and_columns_of_their_own_are_not() {
        let root = ladder(
            "ddl-kv",
            "CREATE TABLE meta (\n  a TEXT,\n  b TEXT\n) STRICT;\n\
             CREATE TABLE state (\n  key TEXT PRIMARY KEY,\n  value TEXT\n) STRICT;\n\
             CREATE TABLE gateway (\n  id TEXT PRIMARY KEY,\n  head TEXT,\n  epoch INTEGER,\n  CHECK (epoch >= 0)\n) STRICT;\n",
        );
        let findings = no_key_value_state_table(&root).findings;
        assert_eq!(findings.len(), 2, "{findings:?}");
        assert!(
            findings.iter().any(|f| f.contains("`meta`")),
            "{findings:?}"
        );
        assert!(
            findings.iter().any(|f| f.contains("`state`")),
            "{findings:?}"
        );
    }

    #[test]
    fn a_ladder_with_no_rung_or_a_founder_that_stamps_nothing_is_a_finding() {
        let root = fixture_dir("ddl-ladder");
        let report = every_database_has_an_application_id_and_ladder(&root);
        assert!(
            report.findings.iter().any(|f| f.contains("holds no rung")),
            "{:?}",
            report.findings
        );
        assert!(
            report.findings.iter().any(|f| f.contains("does not exist")),
            "{:?}",
            report.findings
        );
    }

    /// The rule is about the wire answer: a file that reads a gateway's `MOVED` and proves nothing
    /// is a finding, and the phone's own already-proved error is not.
    #[test]
    fn a_wire_moved_with_no_proof_is_a_finding_and_a_proved_one_is_not() {
        let root = fixture_dir("ddl-authority");
        let phone = root.join("crates/core/src/phone");
        fs::create_dir_all(&phone).expect("the phone directory");
        fs::create_dir_all(root.join("crates/gateway/src/client")).expect("the client directory");
        fs::write(
            root.join("crates/gateway/src/client/mod.rs"),
            "impl X {\n    pub async fn head_state(&self) -> u8 {\n        verify_head(x);\n        0\n    }\n}\n",
        )
        .expect("a client");
        fs::write(
            phone.join("link.rs"),
            "fn f(e: E) { match e { ClientError::Refused(WireRefusal::Moved { claim, .. }) => verify_claim(claim), _ => () } }\n",
        )
        .expect("a proved reader");
        fs::write(
            phone.join("mod.rs"),
            "fn g(e: StoreError) { match e { StoreError::Moved { epoch } => take(epoch), _ => () } }\n",
        )
        .expect("a downstream reader");
        assert!(
            phone_authority_needs_verify(&root).findings.is_empty(),
            "{:?}",
            phone_authority_needs_verify(&root).findings
        );
        fs::write(
            phone.join("rogue.rs"),
            "fn h(e: E) { match e { ClientError::Refused(WireRefusal::Moved { claim, .. }) => take(claim), _ => () } }\n",
        )
        .expect("an unproved reader");
        let findings = phone_authority_needs_verify(&root).findings;
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(findings[0].contains("rogue.rs"), "{findings:?}");
        fs::write(
            root.join("crates/gateway/src/client/mod.rs"),
            "impl X {\n    pub async fn head_state(&self) -> u8 {\n        0\n    }\n}\n",
        )
        .expect("a client that proves nothing");
        assert!(
            phone_authority_needs_verify(&root)
                .findings
                .iter()
                .any(|finding| finding.contains("without `verify_head`")),
            "a client that hands up an unproved head is a finding"
        );
    }

    #[test]
    fn the_committed_tree_passes_every_ddl_rule() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for report in all(&root) {
            assert!(report.findings.is_empty(), "{:?}", report.findings);
        }
    }

    #[test]
    fn the_committed_baseline_reads_no_host_clock() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let report = no_host_clock_in_ddl(&root);
        assert!(report.findings.is_empty(), "{:?}", report.findings);
    }
}
