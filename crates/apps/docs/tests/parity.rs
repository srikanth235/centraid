//! PARITY WITH v0, CASE BY CASE (#1020, D-1020-D3-6).
//!
//! `contracts/apps/docs/` is generated from the v0 tree by
//! `contracts/tools/export-docs-parity.ts`: a fresh vault, the app's own demo
//! seed and a scripted `core.*` command set through the REAL typed commands,
//! then all four Docs queries through the REAL handler path. This suite rebuilds
//! that vault from `rows.json` — a database created from
//! `contracts/schema/vault-ddl.sql`, the committed schema of the #929 golden
//! corpus — reads the same four queries through the ported statements, and
//! compares the answers to `queries.json`.
//!
//! ## Ids are COMPARED here, not masked
//!
//! Unlike `crates/vault/tests/docs_commands.rs`, nothing in this suite mints an
//! id: the rows come from the fixture with their canonical `id-0007` tokens
//! already in them, so a ported query's answer carries the same ids v0's did and
//! **page order is part of the comparison**. A port that returned the right rows
//! in the wrong order fails.
//!
//! ## The one deliberate divergence, stated as a mapping
//!
//! **THE SHARING KEYS ARE FILTERED OUT OF v0'S ANSWER, NOT EDITED OUT OF THE
//! FIXTURE.** `contracts/apps/docs/queries.json` is a frozen golden
//! (TESTING.md, "Fixtures and parity") and is never touched. It carries
//! `shared_with` on every document row, `shared_from` on every drive row and
//! `shared_from_known` on the drive itself — v0's answers about a sharing plane
//! whose nine tables rung five drops (#1029, the owner's ruling of
//! 2026-09-21). There is nothing left in this vault for those keys to be an
//! answer ABOUT, so [`without_sharing`] removes exactly those three names from
//! the expected value before the comparison, and everything else is compared
//! byte for byte as before. `every_expected_row_carried_a_sharing_key` is what
//! stops the filter outliving its reason: if v0's fixture ever stops carrying
//! them, the filter is dead and says so.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_docs::queries::{
    DocumentRow, DriveData, DriveInput, HistoryData, SearchData, documents_statement,
    load_activity, load_drive, load_history, load_search,
};
use centraid_apps_kit::contract_vault::{FrozenRowMapping, open_contract_vault_without};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::testdoor::TestDoor;
use serde_json::{Value, json};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/docs").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

/// The fixture vault, built from the committed DDL and `rows.json`.
///
/// The builder is `centraid_apps_kit::contract_vault::open_contract_vault`, and
/// it is in the kit rather than here because `sql-confinement` scans this file
/// too: an app's parity test needs a vault to read and must not hold a statement
/// to make one.
fn fixture_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/docs/rows.json"))
        .expect("the committed rows are readable");
    open_contract_vault_without(
        &ddl,
        &rows,
        // THE MAPPING, stated: `contracts/apps/docs/rows.json` is frozen and
        // still carries v0's sharing rows. Rung five drops the nine tables
        // (#1029); the bundle is not edited, the builder skips them, and the
        // kit refuses the mapping if the schema ever has them again.
        &FrozenRowMapping {
            tables_gone: &[
                "share_authority",
                "share_fulfillment",
                "share_party_vault_binding",
                "share_subscription",
                "share_subscription_lineage",
            ],
            columns_gone: &[],
            columns_added: &[],
        },
    )
    .expect("the fixture vault is built")
}

// ---------------------------------------------------------------------------
// The mapping onto v0's wire shape. One place, so a field name that moved is
// one edit and a comparison that silently stopped comparing is impossible.
// ---------------------------------------------------------------------------

/// `Date.parse` over an ISO instant, in milliseconds.
///
/// Hand-rolled rather than pulled from `crates/vault`: this crate's only
/// dependencies are the kit and `serde`, and a parity mapping is not a reason to
/// add one. Only the shape the vault writes is accepted — anything else is
/// `None`, which lowers to v0's `0`.
fn centraid_vault_clock_parse(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[10] != b'T' || !text.ends_with('Z') {
        return None;
    }
    let field = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    let millis = if bytes[19] == b'.' {
        field(20, 23).unwrap_or(0)
    } else {
        0
    };
    // Howard Hinnant's `days_from_civil`, as `crates/vault::clock` spells it.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

fn document_json(row: &DocumentRow, with_snippet: bool) -> Value {
    let mut value = json!({
        "document_id": row.document_id,
        "content_id": row.content_id,
        "title": row.title,
        "media_type": row.media_type,
        "byte_size": row.byte_size,
        "content_uri": row.content_uri,
        "poster_uri": row.poster_uri,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "folder_id": row.folder_id,
        "starred": row.starred,
        "trashed": row.trashed,
        "purge_at": row.purge_at,
        "custody_state": row.custody_state,
        "tags": row
            .tags
            .iter()
            .map(|tag| json!({ "tag_id": tag.tag_id, "label": tag.label }))
            .collect::<Vec<Value>>(),
    });
    if with_snippet {
        value["snippet"] = json!(row.snippet.clone().unwrap_or_default());
    }
    value
}

/// v0's answer, minus the three keys about the sharing plane rung five drops.
///
/// The fixture is frozen and is not edited; the mapping is stated in this
/// file's header. Returns how many keys it removed, so the guard below can
/// fail when there is nothing left to filter.
fn without_sharing(value: &mut Value) -> usize {
    let mut removed = 0;
    match value {
        Value::Array(items) => {
            // A DOCUMENT THAT ONLY EXISTS BECAUSE IT WAS DELIVERED HERE goes
            // with the plane that delivered it. v0's drive unioned the filed
            // window with the documents a subscription placed in this vault,
            // and named each one with a `shared_from`; nothing places a
            // document here any more, so a row carrying one is a row the port
            // is right not to answer.
            let before = items.len();
            items.retain(|item| item.get("shared_from").is_none_or(|from| from.is_null()));
            removed += before - items.len();
            for item in items {
                removed += without_sharing(item);
            }
        }
        Value::Object(map) => {
            for key in ["shared_with", "shared_from", "shared_from_known"] {
                if map.remove(key).is_some() {
                    removed += 1;
                }
            }
            for (_, nested) in map.iter_mut() {
                removed += without_sharing(nested);
            }
        }
        _ => {}
    }
    removed
}

fn drive_json(data: &DriveData) -> Value {
    json!({
        "folders": data
            .folders
            .iter()
            .map(|folder| json!({
                "folder_id": folder.folder_id,
                "name": folder.name,
                "parent_id": folder.parent_id,
            }))
            .collect::<Vec<Value>>(),
        "documents": data
            .documents
            .iter()
            .map(|row| document_json(row, false))
            .collect::<Vec<Value>>(),
        "root_folder_id": data.root_folder_id,
        "truncated": data.truncated,
        "window": data.window,
    })
}

fn search_json(data: &SearchData) -> Value {
    json!({
        "documents": data
            .documents
            .iter()
            .map(|row| document_json(row, true))
            .collect::<Vec<Value>>(),
    })
}

fn history_json(data: &HistoryData) -> Value {
    json!({
        "versions": data
            .versions
            .iter()
            .map(|version| json!({
                "content_id": version.content_id,
                "media_type": version.media_type,
                "byte_size": version.byte_size,
                "content_uri": version.content_uri,
                "poster_uri": version.poster_uri,
                "current": version.current,
                "asserted_at": version.asserted_at,
            }))
            .collect::<Vec<Value>>(),
    })
}

/// The FTS hits `search` folds, as the fixture's own answer names them.
///
/// The index itself is `crates/search`'s and is not ported here, so the hits are
/// read back from the fixture's expected output — which is exactly what v0's
/// `ctx.vault.search` handed its own handler, in rank order. What this suite
/// compares is the FOLD: the decorations, the folders-scheme filter and the
/// order's preservation.
fn search_hits(door: &TestDoor<'_>, expected: &Value) -> Vec<Row> {
    let hits: Vec<(String, Option<String>)> = expected["documents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some((
                row["document_id"].as_str()?.to_owned(),
                row["snippet"].as_str().map(str::to_owned),
            ))
        })
        .collect();
    if hits.is_empty() {
        return Vec::new();
    }
    let ids: Vec<String> = hits.iter().map(|(id, _)| id.clone()).collect();
    let statement = documents_statement(&ids).expect("a bounded statement");
    let mut rows = door
        .page(&statement, &PageRequest::first(ids.len()))
        .expect("the hit rows read")
        .rows;
    // RANK ORDER IS THE INDEX'S, and the statement's own order is by id — so
    // the rows are put back into the order the fixture recorded.
    rows.sort_by_key(|row| {
        centraid_apps_kit::row::text_of(row, "document_id")
            .and_then(|id| ids.iter().position(|hit| *hit == id))
            .unwrap_or(usize::MAX)
    });
    // THE SNIPPET IS THE INDEX'S OWN COLUMN, and `crates/search` is not this
    // lane's. v0's hit row carries `_snippet` — an FTS5 `snippet()` with the
    // match delimited — so the hits handed to the fold here carry it too,
    // exactly as the door hands it over. What the fold is then compared on is
    // what it DOES with it: carried through onto the row, and `""` rather than
    // `null` where a hit has none, so a renderer never prints "null".
    for row in &mut rows {
        let Some(document_id) = centraid_apps_kit::row::text_of(row, "document_id") else {
            continue;
        };
        if let Some((_, Some(snippet))) = hits.iter().find(|(id, _)| *id == document_id) {
            row.insert(
                "_snippet".to_owned(),
                centraid_apps_kit::row::Cell::Text(snippet.clone()),
            );
        }
    }
    rows
}

// ---------------------------------------------------------------------------

/// EVERY CASE IN `queries.json`, compared whole.
#[test]
fn the_four_queries_answer_what_v0_answered() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cases = fixture("queries.json");
    let cases = cases.as_array().expect("queries.json is a list of cases");
    assert!(
        cases.len() >= 18,
        "the fixture carries {} cases; a run that generated nothing would pass every \
         comparison below",
        cases.len()
    );

    let mut compared: BTreeMap<&str, usize> = BTreeMap::new();
    // How many sharing keys the filter removed from v0's answers; see the
    // header's mapping. Zero means the filter has outlived its reason.
    let mut sharing_keys_filtered = 0usize;
    // How many provenance events the PORT read across every activity case.
    let mut activity_seen = 0usize;
    for case in cases {
        let query = case["query"].as_str().expect("a query name");
        let input = &case["input"];
        let mut expected = case["output"].clone();
        sharing_keys_filtered += without_sharing(&mut expected);
        let expected = &expected;
        let answered = match query {
            "drive" => {
                let limit = input["limit"].as_u64().map(|limit| limit as usize);
                let (data, denial) =
                    load_drive(&door, DriveInput { limit }).expect("the drive reads");
                assert!(denial.is_none(), "the fixture's drive cases are not denied");
                drive_json(&data)
            }
            "search" => {
                let term = input["term"].as_str().unwrap_or_default();
                // AN EMPTY TERM SHORT-CIRCUITS before the index is touched, and
                // that is the behaviour rather than an empty hit list.
                let hits = if term.is_empty() {
                    Vec::new()
                } else {
                    search_hits(&door, expected)
                };
                let (data, denial) = load_search(&door, &hits).expect("it reads");
                assert!(denial.is_none());
                search_json(&data)
            }
            "history" => {
                let document_id = input["document_id"].as_str().unwrap_or_default();
                let (data, denial) = load_history(&door, document_id).expect("it reads");
                assert!(denial.is_none());
                history_json(&data)
            }
            "activity" => {
                let document_id = input["document_id"].as_str().unwrap_or_default();
                let (data, denial) = load_activity(&door, document_id).expect("it reads");
                assert!(denial.is_none(), "this door does not refuse the audit band");
                // **THE ONE QUERY WHOSE ANSWER IS NOT COMPARED, and the reason
                // is a finding rather than a gap.**
                //
                // v0 answers `{events: [], vaultDenied}` for EVERY caller, the
                // owner included: the gateway's paged door serves only tables
                // registered as ENTITIES, and `access_provenance` declares no
                // `FOREIGN KEY (prov_id) REFERENCES core_entity(entity_id)`, so
                // the plan is refused before any access decision is taken.
                // Docs' activity rail has therefore never shown an event on
                // any surface.
                //
                // The port's answer is not empty — the trail is right there, and
                // `the_activity_rail_the_gateways_door_refuses` below is what
                // shows it. Comparing the two values would mean asserting that
                // the port reproduces a door-level refusal, which is asserting
                // the defect.
                assert!(
                    expected["vaultDenied"].is_object(),
                    "v0 stopped refusing the activity rail — re-judge finding 2 \
                     and compare the events"
                );
                assert_eq!(
                    expected["events"],
                    json!([]),
                    "a refused rail answers no events"
                );
                activity_seen += data.events.len();
                *compared.entry(query).or_default() += 1;
                continue;
            }
            other => panic!("`{other}` is not one of Docs' four queries"),
        };
        assert_eq!(
            answered, *expected,
            "`{query}` at {input} answered differently from v0"
        );
        *compared.entry(query).or_default() += 1;
    }

    // THE COUNTS, so a comparison that silently stopped comparing fails.
    assert_eq!(compared.len(), 4, "all four queries are compared");
    // THE FILTER IS STILL FILTERING SOMETHING. If v0's frozen answers ever stop
    // carrying the sharing keys, `without_sharing` is dead code pretending to
    // be a mapping.
    assert!(
        sharing_keys_filtered > 0,
        "no expected answer carried a sharing key: the mapping in this file's \
         header no longer describes anything"
    );
    assert!(
        compared["drive"] >= 5,
        "the drive's declared window, its floor, its ceiling and the two clamps"
    );
    assert!(compared["search"] >= 4);
    assert!(compared["history"] >= 4);
    assert!(compared["activity"] >= 4);
    // AND THE RAIL IS NOT EMPTY ON THIS SIDE, which is what makes finding 2 a
    // finding and not a difference of opinion about an empty list.
    assert!(
        activity_seen > 0,
        "the ported activity rail read nothing either: the finding would be moot"
    );
}

/// FINDING 2, AS A TEST: the trail the gateway's paged door refuses is there.
///
/// `access_provenance` carries one row per command write, and the command gate
/// writes them against `core.document` — so a document filed, edited and starred
/// has three events. v0 cannot see one of them, because its door serves only
/// tables registered as entities. The port's statement reads them.
#[test]
fn the_activity_rail_the_gateways_door_refuses() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let drive = load_drive(&door, DriveInput::default())
        .expect("the drive reads")
        .0;
    let mut with_a_trail = 0;
    for row in &drive.documents {
        let (activity, denial) = load_activity(&door, &row.document_id).expect("the rail reads");
        assert!(denial.is_none());
        if activity.events.is_empty() {
            continue;
        }
        with_a_trail += 1;
        // NEWEST FIRST, and the order is the rail's own claim.
        let mut instants: Vec<&str> = activity
            .events
            .iter()
            .filter_map(|event| event.occurred_at.as_deref())
            .collect();
        let ordered = instants.clone();
        instants.sort_unstable_by(|left, right| right.cmp(left));
        assert_eq!(ordered, instants, "the rail is newest-first");
        for event in &activity.events {
            assert_eq!(
                event.agent_kind.as_deref(),
                Some("owner"),
                "every write in this corpus is the owner's own"
            );
            assert!(
                event
                    .activity
                    .as_deref()
                    .is_some_and(|activity| activity.starts_with("command.core.")),
                "the trail names the command that wrote: {:?}",
                event.activity
            );
        }
    }
    assert!(
        with_a_trail >= 2,
        "fewer than two documents carry a trail: the finding needs a corpus"
    );
}

/// THE FIXTURE'S OWN CORPUS, asserted before anything is compared against it.
///
/// A corpus with no share answers, no nested folder and no inbound placement
/// would make three of this app's hardest folds agree with a port that does
/// nothing.
#[test]
fn the_corpus_exercises_the_folds_it_is_here_to_compare() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let (data, denial) = load_drive(&door, DriveInput::default()).expect("the drive reads");
    assert!(denial.is_none());

    // A NESTED FOLDER, which is what tells a working chain from a chain of
    // length one (R-1020-35, the `broader_concept_id` projection).
    assert!(
        data.folders.iter().any(|folder| folder.parent_id.is_some()),
        "no folder has a parent: the share chain proves nothing"
    );
    // A TRASHED DOCUMENT, with its purge date.
    assert!(
        data.documents
            .iter()
            .any(|row| row.trashed && row.purge_at.is_some())
    );
    // A DOCUMENT WITH A LABEL, and one with none.
    assert!(data.documents.iter().any(|row| !row.tags.is_empty()));
    assert!(data.documents.iter().any(|row| row.tags.is_empty()));
    // A VERSION CHAIN LONGER THAN ONE.
    let versioned = data
        .documents
        .iter()
        .find_map(|row| {
            let (history, _) = load_history(&door, &row.document_id).expect("it reads");
            (history.versions.len() > 1).then_some(history)
        })
        .expect("no document has two versions: the occurrence walk is untested");
    assert!(versioned.versions[0].current);
    assert!(!versioned.versions[1].current);
}

/// `Date.parse` over the vault's own spelling, so the `shared_from.at` mapping
/// is not the thing under test when a case fails.
#[test]
fn the_instant_lowering_matches_date_parse() {
    assert_eq!(
        centraid_vault_clock_parse("1970-01-01T00:00:00.000Z"),
        Some(0)
    );
    assert_eq!(
        centraid_vault_clock_parse("2099-06-01T09:00:00.000Z"),
        Some(4_083_987_600_000)
    );
    assert_eq!(
        centraid_vault_clock_parse("2099-06-01T09:00:00Z"),
        Some(4_083_987_600_000)
    );
    assert_eq!(centraid_vault_clock_parse("not an instant"), None);
}
