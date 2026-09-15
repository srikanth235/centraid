//! The three gates, from `contracts/applier/` (D-1020-D1-11).
//!
//! - **ORACLE** — the Rust log's rows equal the rows v0's own
//!   `withReplicaCommit` produced for the same statements.
//! - **CONVERGENCE** — a copy at seq _S_ fed rows _S..N_ equals the gateway at
//!   the watermark, every replicated table, values not bytes.
//! - **ATOMICITY** — a crash mid-batch is completed by the next attempt; a
//!   duplicate delivery lands once.
//!
//! Plus lane A's suggestion, now a test: freeze the baseline corpus FROM RUST
//! and diff against the manifest v0's freezer wrote.

mod common;

use std::collections::BTreeMap;

use centraid_vault::log::{self, LogOp, apply_log_page};
use centraid_vault::{Value, Vault};

fn fixture(name: &str) -> serde_json::Value {
    let path = centraid_ontology::golden::repo_root()
        .join("contracts/applier")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is JSON: {error}", path.display()))
}

/// Run one scripted commit, as the fixtures declare them.
fn run_commit(vault: &Vault, commit: &serde_json::Value) -> Option<i64> {
    let producer = commit["producer"].as_str().unwrap_or("script").to_owned();
    let statements: Vec<String> = commit["statements"]
        .as_array()
        .expect("a commit declares statements")
        .iter()
        .map(|statement| statement.as_str().expect("a statement is text").to_owned())
        .collect();
    vault
        .commit(|tx| {
            tx.set_producer(&producer);
            for statement in &statements {
                tx.connection().execute_batch(statement)?;
            }
            Ok(())
        })
        .unwrap_or_else(|error| panic!("`{}`: {error}", commit["label"]))
        .commit_seq
}

/// Every log row of the file, oldest first, including the local lane.
fn log_rows(vault: &Vault) -> Vec<log::LogRow> {
    vault
        .read(|connection| {
            let sql = format!(
                "SELECT {} FROM replica_log ORDER BY seq",
                centraid_vault::log::store::LOG_ROW_COLUMNS
            );
            let mut statement = connection.prepare(&sql)?;
            statement
                .query_map([], |row| Ok(centraid_vault::log::store::log_row_from(row)))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .collect::<centraid_vault::Result<Vec<_>>>()
        })
        .expect("the log reads")
}

/// A row image as comparable JSON, so the fixture's shape and ours meet.
fn image_json(image: Option<&centraid_vault::RowImage>) -> serde_json::Value {
    let Some(image) = image else {
        return serde_json::Value::Null;
    };
    let text = centraid_vault::value::row_image_to_json(image);
    serde_json::from_str(&text).expect("our own encoding is JSON")
}

fn key_json(key: &[Value]) -> serde_json::Value {
    serde_json::from_str(&centraid_vault::value::key_to_json(key)).expect("a key is JSON")
}

// ---------------------------------------------------------------- ORACLE ----

#[test]
fn oracle_the_rust_log_produces_the_rows_v0_produced() {
    let fixture = fixture("oracle.json");
    assert_eq!(fixture["schema"], "centraid-applier-oracle/1");
    let script = fixture["script"].as_array().expect("there is a script");
    let expected = fixture["rows"].as_array().expect("there are rows");
    assert!(!expected.is_empty(), "the fixture has no rows to compare");

    let scratch = common::Scratch::founded("oracle").expect("a vault is founded");
    let before = log_rows(&scratch.vault).len();
    let mut commit_order: Vec<i64> = Vec::new();
    for commit in script {
        if let Some(seq) = run_commit(&scratch.vault, commit) {
            commit_order.push(seq);
        }
    }
    let ours = &log_rows(&scratch.vault)[before..];

    // The fixture renumbers commits from 0 in the order they appear, because
    // the absolute `commit_seq` depends on how many commits each tree's
    // founding path took — v0's `bootstrapVault` and v1's `Vault::found` are
    // not the same script and do not claim to be.
    let renumber = |seq: i64| {
        commit_order
            .iter()
            .position(|candidate| *candidate == seq)
            .map_or(-1, |index| i64::try_from(index).unwrap_or(-1))
    };

    let mut findings: Vec<String> = Vec::new();
    assert_eq!(
        ours.len(),
        expected.len(),
        "v0 produced {} rows and we produced {}:\nv0: {:#?}\nus: {:#?}",
        expected.len(),
        ours.len(),
        expected
            .iter()
            .map(|row| format!("{}/{}/{}", row["commitLabel"], row["table"], row["op"]))
            .collect::<Vec<_>>(),
        ours.iter()
            .map(|row| format!("{}/{}", row.table, row.op.as_str()))
            .collect::<Vec<_>>()
    );
    for (index, (theirs, mine)) in expected.iter().zip(ours.iter()).enumerate() {
        let label = theirs["commitLabel"].as_str().unwrap_or("?");
        let mut differ = |what: &str, left: String, right: String| {
            findings.push(format!(
                "row {index} (`{label}`) {what}: v0 {left}, us {right}"
            ));
        };
        if theirs["commitIndex"].as_i64() != Some(renumber(mine.commit_seq)) {
            differ(
                "commit",
                theirs["commitIndex"].to_string(),
                renumber(mine.commit_seq).to_string(),
            );
        }
        if theirs["table"].as_str() != Some(mine.table.as_str()) {
            differ("table", theirs["table"].to_string(), mine.table.clone());
        }
        if theirs["op"].as_str() != Some(mine.op.as_str()) {
            differ("op", theirs["op"].to_string(), mine.op.as_str().to_owned());
        }
        if theirs["pk"] != key_json(&mine.primary_key) {
            differ(
                "pk",
                theirs["pk"].to_string(),
                key_json(&mine.primary_key).to_string(),
            );
        }
        if theirs["row"] != image_json(mine.row.as_ref()) {
            differ(
                "row",
                theirs["row"].to_string(),
                image_json(mine.row.as_ref()).to_string(),
            );
        }
        if theirs["prior"] != image_json(mine.prior.as_ref()) {
            differ(
                "prior",
                theirs["prior"].to_string(),
                image_json(mine.prior.as_ref()).to_string(),
            );
        }
        for (what, theirs_flag, ours_flag) in [
            ("indirect", theirs["indirect"].as_bool(), mine.indirect),
            ("local", theirs["local"].as_bool(), mine.local),
            ("deferred", theirs["deferred"].as_bool(), mine.deferred),
        ] {
            if theirs_flag != Some(ours_flag) {
                differ(what, format!("{theirs_flag:?}"), ours_flag.to_string());
            }
        }
        if theirs["producer"].as_str() != Some(mine.producer.as_str()) {
            differ(
                "producer",
                theirs["producer"].to_string(),
                mine.producer.clone(),
            );
        }
    }
    assert_eq!(findings.join("\n"), "");

    // NOT VACUOUS. The fixture has to carry the distinctions it was built for,
    // or an all-inserts fixture would pass while the prior delta was broken.
    assert!(
        ours.iter()
            .any(|row| row.op == LogOp::Update && row.prior.is_some()),
        "no update with a prior was compared"
    );
    assert!(ours.iter().any(|row| row.op == LogOp::Delete));
    assert!(ours.iter().any(|row| row.local));
    assert!(ours.iter().any(|row| row.indirect));
}

// ----------------------------------------------------------- CONVERGENCE ----

/// Every row of every replicated table the file carries, as comparable values.
fn replicated_state(connection: &rusqlite::Connection) -> BTreeMap<String, Vec<String>> {
    let mut statement = connection
        .prepare(
            r"SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
                ORDER BY name",
        )
        .expect("the query prepares");
    let tables: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the names read");

    let mut state = BTreeMap::new();
    for table in tables {
        if !centraid_ontology::registries::is_replicated_table(&table) {
            continue;
        }
        let columns = centraid_vault::log::table_columns(connection, &table).expect("columns read");
        let projection = columns
            .iter()
            .map(|column| centraid_vault::log::quoted(column))
            .collect::<Vec<_>>()
            .join(", ");
        // Ordered by the whole projection, so two files holding the same rows
        // in a different physical order compare equal — the claim is about
        // VALUES, not about page layout.
        let sql = format!(
            "SELECT {projection} FROM {} ORDER BY {projection}",
            centraid_vault::log::quoted(&table)
        );
        let mut statement = connection.prepare(&sql).expect("the query prepares");
        let rows: Vec<String> = statement
            .query_map([], |row| {
                let mut image = centraid_vault::RowImage::new();
                for (index, column) in columns.iter().enumerate() {
                    image.insert(
                        column.clone(),
                        Value::from_ref(row.get_ref(index)?).expect("a value reads"),
                    );
                }
                Ok(centraid_vault::value::row_image_to_json(&image))
            })
            .expect("the query runs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("the rows read");
        state.insert(table, rows);
    }
    state
}

#[test]
fn convergence_a_copy_fed_the_log_equals_the_gateway_at_the_watermark() {
    let fixture = fixture("convergence.json");
    assert_eq!(fixture["schema"], "centraid-applier-convergence/1");

    let scratch = common::Scratch::founded("convergence").expect("a vault is founded");
    for commit in fixture["script"]["beforeCopy"]
        .as_array()
        .expect("there is a before phase")
    {
        run_commit(&scratch.vault, commit);
    }

    // THE COPY AT SEQ S. Taken with the snapshot builder, because that is the
    // artifact a real seat bootstraps from — a hand-rolled file copy would
    // prove convergence for a file no seat ever holds.
    let head = centraid_vault::build_snapshot(&scratch.vault, &scratch.join("snap"))
        .expect("the snapshot builds");
    let copy_path = scratch.join("copy.db");
    inflate_gz(&scratch.join("snap").join(&head.name), &copy_path);
    let copy = rusqlite::Connection::open(&copy_path).expect("the copy opens");
    let copy_epoch: String = copy
        .query_row(
            "SELECT epoch FROM replica_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .expect("the epoch reads");
    let copy_floor: i64 = copy
        .query_row(
            "SELECT floor_seq FROM replica_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .expect("the floor reads");
    assert_eq!(copy_floor, head.seq, "the log went, the cursor stayed");

    for commit in fixture["script"]["afterCopy"]
        .as_array()
        .expect("there is an after phase")
    {
        run_commit(&scratch.vault, commit);
    }

    // Feed the copy every row above its cursor, through the real applier.
    let page = log::read_log_page(
        &scratch.vault,
        &log::Cursor {
            epoch: copy_epoch.clone(),
            seq: copy_floor,
        },
        10_000,
    )
    .expect("the page serves");
    let outcome =
        apply_log_page(&copy, &page.rows, Some(&copy_epoch), copy_floor).expect("the apply runs");
    assert_eq!(
        i64::try_from(outcome.commits).unwrap_or(-1),
        fixture["expect"]["appliedCommits"]
            .as_i64()
            .expect("the fixture says how many"),
        "one transaction per commit, and the count is the fixture's"
    );
    assert_eq!(outcome.cursor, page.watermark.seq);

    // EVERY REPLICATED TABLE, VALUES NOT BYTES.
    let gateway = scratch
        .vault
        .read(|connection| Ok(replicated_state(connection)))
        .expect("the gateway state reads");
    let seat = replicated_state(&copy);

    let mut findings: Vec<String> = Vec::new();
    let mut compared = 0_usize;
    for (table, rows) in &gateway {
        // A private table is not in the copy at all, by construction: the
        // snapshot dropped it. Those are not replicated so they are not here.
        match seat.get(table) {
            None => findings.push(format!("`{table}` is on the gateway and not on the seat")),
            Some(mirrored) => {
                compared += 1;
                if mirrored != rows {
                    findings.push(format!(
                        "`{table}`: {} row(s) on the gateway, {} on the seat\n  gateway: {:?}\n  seat:    {:?}",
                        rows.len(),
                        mirrored.len(),
                        rows,
                        mirrored
                    ));
                }
            }
        }
    }
    assert_eq!(findings.join("\n"), "");
    // The named minimum the fixture declares, and the count the receipt quotes.
    for named in fixture["compare"]["named"]
        .as_array()
        .expect("the fixture names tables")
    {
        let table = named.as_str().expect("a table name is text");
        assert!(
            gateway.contains_key(table),
            "`{table}` was named and is not replicated"
        );
    }
    assert!(
        compared > 100,
        "only {compared} table(s) were compared; the allow-list holds 109"
    );

    // And the row set is the one the fixture states, so a comparison of two
    // equally-wrong files cannot pass.
    let expected_parties: Vec<&str> = fixture["expect"]["partiesAtWatermark"]
        .as_array()
        .expect("the fixture lists them")
        .iter()
        .map(|value| value.as_str().expect("a party id is text"))
        .collect();
    let mut statement = copy
        .prepare("SELECT party_id FROM core_party WHERE party_id LIKE 'conv-%' ORDER BY party_id")
        .expect("the query prepares");
    let actual: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read");
    assert_eq!(actual, expected_parties);
}

// ------------------------------------------------------------- ATOMICITY ----

#[test]
fn atomicity_a_crash_mid_batch_is_completed_and_a_duplicate_lands_once() {
    let fixture = fixture("atomicity.json");
    assert_eq!(fixture["schema"], "centraid-applier-atomicity/1");
    let cases = fixture["cases"].as_array().expect("there are cases");
    assert_eq!(cases.len(), 3);

    for case in cases {
        let name = case["name"].as_str().expect("a case is named");
        let scratch = common::Scratch::founded("atomicity").expect("a vault is founded");

        let head = centraid_vault::build_snapshot(&scratch.vault, &scratch.join("snap"))
            .expect("the snapshot builds");
        let copy_path = scratch.join("copy.db");
        inflate_gz(&scratch.join("snap").join(&head.name), &copy_path);
        let copy = rusqlite::Connection::open(&copy_path).expect("the copy opens");
        let epoch: String = copy
            .query_row(
                "SELECT epoch FROM replica_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .expect("the epoch reads");
        let floor: i64 = copy
            .query_row(
                "SELECT floor_seq FROM replica_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .expect("the floor reads");

        for commit in fixture["script"]["commits"]
            .as_array()
            .expect("there is a script")
        {
            run_commit(&scratch.vault, commit);
        }
        let page = log::read_log_page(
            &scratch.vault,
            &log::Cursor {
                epoch: epoch.clone(),
                seq: floor,
            },
            10_000,
        )
        .expect("the page serves");

        let slice = |spec: &serde_json::Value| -> Vec<log::LogRow> {
            if spec == "all" {
                return page.rows.clone();
            }
            let commits = spec["commits"].as_i64().expect("a case says how many");
            let keep: Vec<i64> = {
                let mut seen: Vec<i64> = Vec::new();
                for row in &page.rows {
                    if !seen.contains(&row.commit_seq) {
                        seen.push(row.commit_seq);
                    }
                }
                seen.into_iter()
                    .take(usize::try_from(commits).unwrap_or(0))
                    .collect()
            };
            page.rows
                .iter()
                .filter(|row| keep.contains(&row.commit_seq))
                .cloned()
                .collect()
        };

        let first = apply_log_page(&copy, &slice(&case["applyFirst"]), Some(&epoch), floor)
            .expect("the first apply runs");
        let second = apply_log_page(
            &copy,
            &slice(&case["thenApply"]),
            Some(&epoch),
            first.cursor,
        )
        .expect("the second apply runs");

        // THE CURSOR NEVER MOVES BACKWARDS, which is what makes redelivery
        // safe and which is the applier's only ordering guarantee.
        assert!(
            second.cursor >= first.cursor,
            "{name}: the cursor went back from {} to {}",
            first.cursor,
            second.cursor
        );
        if case["expectCursorUnchanged"] == serde_json::Value::Bool(true) {
            assert_eq!(second.cursor, first.cursor, "{name}: the cursor moved");
        }

        let expected: Vec<&str> = case["expectParties"]
            .as_array()
            .expect("the case lists them")
            .iter()
            .map(|value| value.as_str().expect("an id is text"))
            .collect();
        let mut statement = copy
            .prepare(
                "SELECT party_id FROM core_party WHERE party_id LIKE 'atom-%' ORDER BY party_id",
            )
            .expect("the query prepares");
        let actual: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("the query runs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("the rows read");
        assert_eq!(actual, expected, "{name}: the row set");

        let name_of_a: String = copy
            .query_row(
                "SELECT display_name FROM core_party WHERE party_id = 'atom-a'",
                [],
                |row| row.get(0),
            )
            .expect("the row reads");
        assert_eq!(
            name_of_a,
            case["expectDisplayNameOfA"].as_str().expect("a name"),
            "{name}: the value"
        );
    }
}

// ------------------------------------------- lane A's suggestion, as a test --

#[test]
fn freezing_the_baseline_corpus_from_rust_reproduces_v0s_manifest() {
    // Lane A suggested it; it is a test now. `snapshot_vault` walks the corpus
    // and digests every row the way v0's freezer did, so reproducing the
    // manifest proves the two read the file the same way — which is the only
    // claim that makes the Rust side a candidate to replace the oracle.
    let golden = centraid_ontology::golden::open_golden().expect("the corpus inflates");
    let vault = centraid_ontology::Vault::open(golden.db_path()).expect("the corpus opens");
    let refrozen = centraid_ontology::snapshot_vault(vault.connection()).expect("the freeze runs");
    let frozen = &golden.manifest().tables;

    let mut findings: Vec<String> = Vec::new();
    for (table, expected) in frozen {
        match refrozen.get(table) {
            None => findings.push(format!(
                "`{table}` is in the manifest and not in the freeze"
            )),
            Some(actual) => {
                if actual.columns != expected.columns {
                    findings.push(format!("`{table}`: columns differ"));
                }
                if actual.rows != expected.rows {
                    findings.push(format!(
                        "`{table}`: {} row(s) frozen, {} now",
                        expected.rows, actual.rows
                    ));
                }
                for (key, digest) in &expected.digests {
                    if actual.digests.get(key) != Some(digest) {
                        findings.push(format!("`{table}` row `{key}`: digest moved"));
                    }
                }
            }
        }
    }
    for table in refrozen.keys() {
        if !frozen.contains_key(table) {
            findings.push(format!(
                "`{table}` is in the freeze and not in the manifest"
            ));
        }
    }
    assert_eq!(findings.join("\n"), "");
    assert_eq!(frozen.len(), 16, "the corpus's own table count");
}

/// Inflate a gzipped snapshot beside itself.
fn inflate_gz(gz: &std::path::Path, to: &std::path::Path) {
    use flate2::read::GzDecoder;
    use std::io::Read as _;
    let mut decoder = GzDecoder::new(std::fs::File::open(gz).expect("the artifact opens"));
    let mut plain = Vec::new();
    decoder.read_to_end(&mut plain).expect("it inflates");
    std::fs::write(to, plain).expect("the copy writes");
}
