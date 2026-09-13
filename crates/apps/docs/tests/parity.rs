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
//! ## The two deliberate divergences, stated as mappings
//!
//! 1. **`shared_with: null` is [`Reading::Denied`]** here, and `[]` is
//!    `Data(vec![])`. v0 collapses "we cannot see" and "shared with nobody" onto
//!    one `null`/`[]` pair that a caller can mistake for each other; the port
//!    models the third state (census §A seam 5). The mapping below emits v0's
//!    shape so the comparison is exact, and `a_denied_share_plane_is_null_not_empty`
//!    is what proves the two are still distinguishable on this side.
//! 2. **`shared_from.at` is an INSTANT here and epoch milliseconds in v0.** v0
//!    writes `Date.parse(subscribed_at ?? "") || 0`, which turns an absent or
//!    unparseable instant into `0` — "arrived on 1 January 1970" on the shelf.
//!    The mapping parses the port's text to the same number, and the divergence
//!    is a finding in the lane's receipt rather than a reproduced `0`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_docs::queries::{
    DocumentRow, DriveData, DriveInput, HistoryData, SearchData, documents_statement,
    load_activity, load_drive, load_history, load_search,
};
use centraid_apps_docs::{Reading, shares};
use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::testdoor::TestDoor;
use serde_json::{Value, json};

/// The instant the generator stamped the whole run at.
const PARITY_EPOCH: &str = "2099-06-01T09:00:00.000Z";

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
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

// ---------------------------------------------------------------------------
// The mapping onto v0's wire shape. One place, so a field name that moved is
// one edit and a comparison that silently stopped comparing is impossible.
// ---------------------------------------------------------------------------

fn shared_with_json(reading: &Reading<Vec<shares::SharedWithEntry>>) -> Value {
    match reading {
        // v0's `null` is BOTH of these on its side; the port keeps them apart
        // and emits v0's shape here.
        Reading::Denied(_) | Reading::Loading => Value::Null,
        Reading::Data(entries) => Value::Array(
            entries
                .iter()
                .map(|entry| {
                    json!({
                        "grant_id": entry.grant_id,
                        "circle_id": entry.circle_id,
                        "audience": entry.audience.as_str(),
                        "label": entry.label,
                        "via": entry.via.as_str(),
                        "container_id": entry.container_id,
                        "member_count": entry.member_count,
                        "pending_count": entry.pending_count,
                        "members": entry
                            .members
                            .iter()
                            .map(|member| json!({
                                "party_id": member.party_id,
                                "label": member.label,
                                "capability": member.capability.as_str(),
                                "status": member.status.as_str(),
                            }))
                            .collect::<Vec<Value>>(),
                    })
                })
                .collect(),
        ),
    }
}

/// `shared_from`, with the port's instant lowered to v0's epoch milliseconds.
fn shared_from_json(row: &DocumentRow) -> Value {
    let Some(from) = row.shared_from.as_ref() else {
        return Value::Null;
    };
    json!({
        "vault_id": from.vault_id,
        "party_id": from.party_id,
        "name": from.name,
        // `Date.parse(…) || 0`: the port's `None` becomes v0's `0`, which is
        // the finding rather than the design.
        "at": from
            .at
            .as_deref()
            .and_then(centraid_vault_clock_parse)
            .unwrap_or(0),
    })
}

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
        "shared_with": shared_with_json(&row.shared_with),
    });
    if with_snippet {
        value["snippet"] = json!(row.snippet.clone().unwrap_or_default());
    } else {
        // The drive row carries `shared_from`; a search row does not, because
        // `search`'s hits are already the drive's own documents.
        value["shared_from"] = shared_from_json(row);
    }
    value
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
        "shared_from_known": data.shared_from_known,
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
    // How many provenance events the PORT read across every activity case.
    let mut activity_seen = 0usize;
    for case in cases {
        let query = case["query"].as_str().expect("a query name");
        let input = &case["input"];
        let expected = &case["output"];
        let answered = match query {
            "drive" => {
                let limit = input["limit"].as_u64().map(|limit| limit as usize);
                let (data, denial) =
                    load_drive(&door, DriveInput { limit }, PARITY_EPOCH).expect("the drive reads");
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
                let (data, denial) = load_search(&door, &hits, PARITY_EPOCH).expect("it reads");
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
                // the plan is refused at
                // `packages/vault/src/gateway/paged-door.ts:436` before any
                // access decision is taken. Docs' activity rail has therefore
                // never shown an event on any surface.
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
    let drive = load_drive(&door, DriveInput::default(), PARITY_EPOCH)
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
    let (data, denial) =
        load_drive(&door, DriveInput::default(), PARITY_EPOCH).expect("the drive reads");
    assert!(denial.is_none());

    // A NESTED FOLDER, which is what tells a working chain from a chain of
    // length one (R-1020-35, the `broader_concept_id` projection).
    assert!(
        data.folders.iter().any(|folder| folder.parent_id.is_some()),
        "no folder has a parent: the share chain proves nothing"
    );
    // A SHARE THAT CAME THROUGH A FOLDER, and one that came through the
    // document — the two `via` values, in one corpus.
    let vias: Vec<shares::Via> = data
        .documents
        .iter()
        .filter_map(|row| row.shared_with.data())
        .flatten()
        .map(|entry| entry.via)
        .collect();
    assert!(vias.contains(&shares::Via::Folder), "no folder share");
    assert!(vias.contains(&shares::Via::Document), "no document share");
    // A CIRCLE AUDIENCE AND A PERSON AUDIENCE.
    let audiences: Vec<shares::Audience> = data
        .documents
        .iter()
        .filter_map(|row| row.shared_with.data())
        .flatten()
        .map(|entry| entry.audience)
        .collect();
    assert!(audiences.contains(&shares::Audience::Circle));
    assert!(audiences.contains(&shares::Audience::Person));
    // A PASS THAT LANDED AND A PASS THAT HAS NOT, so `pending_count` is a
    // number the fold computed rather than a zero.
    assert!(
        data.documents
            .iter()
            .filter_map(|row| row.shared_with.data())
            .flatten()
            .any(|entry| entry.pending_count > 0),
        "every member is current: the delivered/syncing split is not in the corpus"
    );
    // AN INBOUND PLACEMENT, which the drive's tag window cannot see on its own.
    assert!(
        data.documents.iter().any(|row| row.shared_from.is_some()),
        "nothing arrived from elsewhere: the origin plane's second door is untested"
    );
    assert!(data.shared_from_known);
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

/// THE THIRD STATE IS STILL THERE ON THIS SIDE.
///
/// The mapping above emits v0's `null` for a denial, which is the whole reason
/// this test exists: a reader of the mapping could conclude the port collapsed
/// the states too. It did not — a denied share plane and an empty one are two
/// different values, and only one of them is `Reading::Data`.
#[test]
fn a_denied_share_plane_is_null_not_empty() {
    let empty = Reading::Data(Vec::new());
    let denied = Reading::Denied(centraid_apps_docs::Denial {
        code: None,
        message: Some("ask the owner".to_owned()),
        revoked_at: None,
    });
    // Both lower to v0's shape, and they lower DIFFERENTLY.
    assert_eq!(shared_with_json(&empty), json!([]));
    assert_eq!(shared_with_json(&denied), Value::Null);
    // And they are not equal on this side, which v0's pair cannot say.
    assert_ne!(empty, denied);
    assert!(denied.denied());
    assert!(!empty.denied());
    assert!(empty.data().is_some());
    assert!(denied.data().is_none());
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

/// THE NINE BOUNDED WINDOWS, AND WHAT EACH ONE READS ON THIS CORPUS.
///
/// The lane's receipt quotes these numbers, so they are measured rather than
/// counted by hand — and a window that reads NOTHING on the fixture is a window
/// the parity comparison is not exercising, which is the failure this test is
/// for.
#[test]
fn the_nine_share_windows_are_all_exercised_by_the_corpus() {
    use centraid_apps_docs::origins::{origin_bindings_statement, origin_parties_statement};
    use centraid_apps_docs::shares::{
        SHARE_WINDOWS, answers_statement, bindings_statement, circle_members_statement,
        circles_statement, fulfillments_statement, parties_statement,
    };
    use centraid_apps_kit::reads::read_pages;

    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    // The ids the fold would hand each window, read off the fixture's own answer
    // rather than typed: a window fed ids nobody holds reads nothing for the
    // wrong reason.
    let (drive, _) = load_drive(&door, DriveInput::default(), PARITY_EPOCH).expect("it reads");
    let documents: Vec<String> = drive
        .documents
        .iter()
        .map(|row| row.document_id.clone())
        .collect();
    let folders: Vec<String> = drive
        .folders
        .iter()
        .map(|folder| folder.folder_id.clone())
        .collect();
    let entries: Vec<_> = drive
        .documents
        .iter()
        .filter_map(|row| row.shared_with.data())
        .flatten()
        .collect();
    let grants: Vec<String> = entries.iter().map(|entry| entry.grant_id.clone()).collect();
    let circles: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.circle_id.clone())
        .collect();
    let parties: Vec<String> = entries
        .iter()
        .flat_map(|entry| entry.members.iter().map(|member| member.party_id.clone()))
        .collect();
    let vaults: Vec<String> = drive
        .documents
        .iter()
        .filter_map(|row| row.shared_from.as_ref().map(|from| from.vault_id.clone()))
        .collect();

    let mut measured: BTreeMap<String, usize> = BTreeMap::new();
    let mut walk = |statement: centraid_apps_kit::statement::PageQuery| {
        let rows = read_pages(&door, &statement, centraid_apps_docs::SHARE_FAN_OUT)
            .expect("a bounded window walks");
        measured.insert(statement.name.clone(), rows.len());
    };
    walk(answers_statement("core.document", &documents).expect("a statement"));
    walk(answers_statement("docs.folder", &folders).expect("a statement"));
    walk(circles_statement(&circles).expect("a statement"));
    walk(circle_members_statement(&circles).expect("a statement"));
    walk(fulfillments_statement(&grants).expect("a statement"));
    walk(parties_statement(&parties).expect("a statement"));
    walk(bindings_statement(&parties).expect("a statement"));
    walk(origin_bindings_statement(&vaults).expect("a statement"));
    walk(origin_parties_statement(&parties).expect("a statement"));

    for window in SHARE_WINDOWS {
        let rows = measured
            .get(window)
            .copied()
            .unwrap_or_else(|| panic!("{window} was not walked"));
        assert!(
            rows > 0,
            "{window} read nothing: the corpus is not exercising it"
        );
        println!("window {window}: {rows} rows");
    }
    assert_eq!(measured.len(), SHARE_WINDOWS.len());
}
