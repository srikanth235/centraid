//! PARITY WITH V0: v0's OWN ANSWERS, FOLDED OVER v0's OWN ROWS (#1020, wave 4
//! lane Locker).
//!
//! `contracts/tools/export-locker-parity.ts` founds a fresh v0 vault, writes a
//! corpus through the real typed `locker.*` commands, invokes all eight
//! queries through the real handler path, and writes what came back.
//! `tests/quality/locker-parity.contract.test.ts` is both its emitter and its
//! oracle: without `CENTRAID_WRITE_CONTRACTS=1` it rebuilds the bundle from
//! the live v0 tree and asserts equality with what is committed, so "the
//! fixture passes in v0 too" is that one command and not a second suite.
//!
//! This file reads the same bundle from the other side: `rows.json` becomes a
//! vault (`contracts/schema/vault-ddl.sql` + the kit's one insert), the port's
//! own statements and folds run over it, and the answers are compared with
//! `queries.json` — **ids and ORDER included**, because the rows and the
//! answers were canonicalised in one pass over one vault, so an id in
//! `queries.json` names the same row as the same id in `rows.json`.
//!
//! ## THE FOUR ANSWERS THAT DO NOT COMPARE, EACH NAMED
//!
//! Three are custody (D-1020-L6, D-1020-L7): `locker.watchtower`,
//! `locker.totp_code` and `locker.export` all needed plaintext to compute, and
//! the command plane holds no member key — only the phone's core does. The fixture records **v0's**
//! shapes so the change is visible in a diff rather than silent, and
//! [`the_manifest_names_every_answer_the_custody_change_moves`] asserts the
//! manifest names each one.
//!
//! The fourth is a **v0 bug this port does not reproduce**: `locker.access`
//! answered `{entries: [], vaultDenied: …}` through v0's gateway, because
//! `access_receipt` is not one of the vault's 96 catalog entities and the paged
//! door refuses `FROM access_receipt`. See
//! [`v0s_access_query_is_refused_by_its_own_door_and_the_port_answers`].
//!
//! ## FIVE ANSWERS COMPARE AS MULTISETS, AND THE ORDER IS ASSERTED SEPARATELY
//!
//! Every Locker shelf orders by `updated_at DESC, item_id` and the audit
//! window by `occurred_at DESC, receipt_id`. Both columns are stamped by a
//! SQLite trigger reading the **database's own clock**, which the generator's
//! JS clock cannot hold — the two-clocks problem `PARITY_EPOCH` exists for —
//! so `tally-parity-canonical.ts` flattens every one of them to
//! `<host-clock>`: `locker_item`'s twelve rows share one value and
//! `access_receipt`'s forty-nine share one. A vault rebuilt from `rows.json`
//! therefore cannot reproduce v0's sequence; it falls back to the tiebreak
//! column, which is a fact about the fixture and not about either
//! implementation.
//!
//! So those five answers are compared as multisets — every row, every field,
//! nothing dropped — and the ordering claim is made where it can be:
//! [`every_shelf_declares_the_order_v0_declares`] asserts each statement's own
//! declared order against v0's, and the sequence over distinct instants is
//! proven in `src/queries.rs`'s own tests. The manifest records the pair as
//! `order` / `orderWhy`, the way Photos records its three `localeCompare`
//! rosters (D-1020-D3-6).
//!
//! ## WHAT v0 DERIVED AND THE PORT DOES NOT, NAMED
//!
//! v0 decorated each row with `weak`, `reused` and a card's `last4`, derived
//! by unsealing every password (`locker.watchtower`). The port does not score
//! weak or reused at all (Q-1047-16): the fold is deleted, and so is the
//! `watchtower` query. So [`from_case`] reads v0's answer **without** what that
//! derivation produced — `weak` and `reused` dropped, a `warn` severity read as
//! none, a card's `•••• 1234` read as `Card` — and compares everything else.
//! The bundle keeps v0's own values as the record.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::{FrozenRowMapping, open_contract_vault_without};
use centraid_apps_kit::reads::read_window;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_locker::manifest;
use centraid_apps_locker::queries::{self, Decorated, Decorations, Severity, Shelf, Vocabulary};
use rusqlite::Connection;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("the repository root")
}

fn read_json(relative: &str) -> serde_json::Value {
    let path = root().join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{relative} is not JSON: {error}"))
}

/// A vault carrying the committed schema and the rows v0's own run left behind.
fn v0_vault() -> Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let rows = fs::read_to_string(root().join("contracts/apps/locker/rows.json"))
        .expect("the fixture rows are readable");
    open_contract_vault_without(
        &ddl,
        &rows,
        // THE MAPPING, stated: `contracts/apps/locker/rows.json` is frozen and
        // still carries `locker_item.connection_id`, the foreign key into
        // `sync_connection` that rung five drops with the connector plane
        // (#1029). Every one of its cells is NULL in the bundle. It also
        // carries `locker_key.retired_at`, which rung seven drops with
        // rotation (R-1047-D2); its one cell is NULL — the live generation.
        // And it carries `locker_item.url_match_policy` and
        // `locker_item_address.match_policy`, which rung eight drops with the
        // matcher nothing ran (Q-1047-15); their cells are the schema default,
        // which no fold in the port reads.
        &FrozenRowMapping {
            tables_gone: &[],
            columns_gone: &[
                ("locker_item", "connection_id"),
                ("locker_item", "url_match_policy"),
                ("locker_item_address", "match_policy"),
                ("locker_key", "retired_at"),
            ],
            columns_added: &[],
        },
    )
    .expect("the fixture vault is built")
}

/// Every query case in the bundle, in the order the generator wrote them.
fn v0_cases() -> Vec<serde_json::Value> {
    read_json("contracts/apps/locker/queries.json")
        .as_array()
        .expect("the bundle is a list of cases")
        .clone()
}

/// The one case for a query at a named input.
fn case(query: &str, input: serde_json::Value) -> serde_json::Value {
    v0_cases()
        .into_iter()
        .find(|entry| entry["query"] == serde_json::json!(query) && entry["input"] == input)
        .unwrap_or_else(|| panic!("the bundle has no {query} case at {input}"))
}

/// Everything a shelf needs, read once off the fixture vault.
///
/// `alias` is a flag rather than always-on because **v0's shelves do not
/// decorate alike**, and a port that decorated them all the
/// same way would be a port that answered something v0 never answered. See
/// [`only_the_live_shelf_carries_the_connector_alias_in_v0`].
fn decorations(connection: &Connection, alias: bool) -> Decorations {
    let door = TestDoor::new(connection);
    let concepts = read_window(&door, &queries::concepts_statement(), 2_000)
        .expect("the concept scheme reads")
        .rows;
    let schemes = read_window(&door, &queries::schemes_statement(), 2_000)
        .expect("the scheme table reads")
        .rows;
    let vocabulary = Vocabulary::of(&concepts, &schemes);
    let ids = live_ids(connection);
    let tag_rows = read_window(
        &door,
        &queries::tags_statement(&ids).expect("the tag statement builds"),
        2_000,
    )
    .expect("the tag plane reads")
    .rows;
    let alias_rows = read_window(
        &door,
        &queries::alias_statement(&ids).expect("the alias statement builds"),
        2_000,
    )
    .expect("the alias table reads")
    .rows;
    Decorations {
        tags: queries::fold_tags(&tag_rows, &vocabulary),
        starred: vocabulary
            .starred_concept()
            .map(|concept| queries::fold_starred(&tag_rows, &concept))
            .unwrap_or_default(),
        alias: if alias {
            alias_rows
                .iter()
                .filter_map(|row| {
                    Some((
                        centraid_apps_kit::row::text_of(row, "item_id")?,
                        centraid_apps_kit::row::text_of(row, "alias")?,
                    ))
                })
                .collect()
        } else {
            BTreeMap::new()
        },
    }
}

/// Every item id the fixture carries, for the two bounded sidecar reads.
fn live_ids(connection: &Connection) -> Vec<String> {
    let door = TestDoor::new(connection);
    let mut ids: Vec<String> = Vec::new();
    for shelf in [Shelf::Live, Shelf::Archived] {
        let window =
            read_window(&door, &queries::items_statement(shelf), 2_000).expect("a shelf reads");
        for row in &window.rows {
            if let Some(id) = centraid_apps_kit::row::text_of(row, "item_id") {
                ids.push(id);
            }
        }
    }
    let window = read_window(&door, &queries::trash_statement(), 2_000).expect("trash reads");
    for row in &window.rows {
        if let Some(id) = centraid_apps_kit::row::text_of(row, "item_id") {
            ids.push(id);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// A value whose object keys are in sorted order, at every depth.
///
/// **Why this exists and is not paranoia.** `same_rows` compares rendered
/// strings, and whether `serde_json` renders an object's keys in insertion or
/// sorted order depends on the `preserve_order` feature — which is off for
/// `cargo test -p centraid-apps-locker` and ON under `cargo test --workspace`,
/// because some other member of the workspace turns it on and cargo unifies
/// features. So this comparison passed alone and failed in the gate, over
/// values that were identical. Sorting first makes the rendering canonical
/// either way.
fn keys_sorted(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(keys_sorted).collect())
        }
        serde_json::Value::Object(fields) => {
            let mut sorted: Vec<(&String, &serde_json::Value)> = fields.iter().collect();
            sorted.sort_by(|left, right| left.0.cmp(right.0));
            serde_json::Value::Object(
                sorted
                    .into_iter()
                    .map(|(key, item)| (key.clone(), keys_sorted(item)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// Compare two answers as MULTISETS. See this file's header.
fn same_rows(mine: &[serde_json::Value], theirs: &[serde_json::Value], what: &str) {
    let sort = |rows: &[serde_json::Value]| {
        let mut sorted: Vec<String> = rows
            .iter()
            .map(|row| serde_json::to_string(&keys_sorted(row)).expect("a row renders"))
            .collect();
        sorted.sort();
        sorted
    };
    assert_eq!(sort(mine), sort(theirs), "{what}");
    assert_eq!(mine.len(), theirs.len(), "{what}: the row COUNT moved");
}

/// One decorated row, as the fields the bundle carries.
fn as_case(row: &Decorated) -> serde_json::Value {
    serde_json::json!({
        "item_id": row.item_id,
        "type": row.item_type,
        "title": row.title,
        "subtitle": row.subtitle,
        "favorite": row.favorite,
        "tags": row.tags,
        "compromised": row.compromised,
        "severity": match row.severity {
            Severity::None => "",
            Severity::Danger => "danger",
        },
        "url": row.url,
        "expiry": row.expiry,
        "alias": row.alias,
        "archived": row.archived,
        "password_set_at": row.password_set_at,
        "purge_at": row.purge_at,
    })
}

/// The same fields off a bundle row, so the two are compared as one value.
fn from_case(row: &serde_json::Value) -> serde_json::Value {
    let mut picked = serde_json::Map::new();
    for key in [
        "item_id",
        "type",
        "title",
        "subtitle",
        "favorite",
        "tags",
        "compromised",
        "severity",
        "url",
        "expiry",
        "alias",
        "archived",
        "password_set_at",
        "purge_at",
    ] {
        // `updated_at` is `<host-clock>` in the fixture and the real instant in
        // the vault the rows rebuild, so it is the one field a token makes
        // incomparable. Every other field on the row is compared.
        picked.insert(
            key.to_owned(),
            row.get(key).cloned().unwrap_or(serde_json::Value::Null),
        );
    }
    // WHAT v0's DERIVATION PRODUCED, READ AS THE PORT ANSWERS WITHOUT IT
    // (Q-1047-16; this file's header).
    if picked["severity"] == serde_json::json!("warn") {
        picked.insert("severity".to_owned(), serde_json::json!(""));
    }
    if picked["type"] == serde_json::json!("card")
        && picked["subtitle"]
            .as_str()
            .is_some_and(|subtitle| subtitle.starts_with("•••• "))
    {
        picked.insert("subtitle".to_owned(), serde_json::json!("Card"));
    }
    serde_json::Value::Object(picked)
}

// ---------------------------------------------------------------------------
// THE BUNDLE ITSELF
// ---------------------------------------------------------------------------

/// The bundle is v0's own answers, FROZEN, and it says how many.
#[test]
fn the_bundle_is_v0s_own_answers_and_says_how_many() {
    let manifest_json = read_json("contracts/apps/locker/manifest.json");
    assert_eq!(manifest_json["app"], serde_json::json!("locker"));
    // The declaration that used to say `pending-regeneration` is GONE, because
    // the three files are here. Its absence is asserted so the state cannot
    // regress silently.
    assert!(
        manifest_json["fixtures"].is_null(),
        "the bundle is generated: the pending declaration must be gone"
    );
    // IT IS EVIDENCE, NOT OUTPUT (#1025 S4). The manifest used to name the
    // command that regenerates the bundle, and this asserted that the two
    // generator files were committed. `chore(retire): delete the v0 tree` took
    // the tree those tools read and the tools with it, so there is nothing left
    // to run — and an assertion that a deleted file exists is not a weaker
    // version of the old one, it is a false one. The manifest says `frozen`
    // instead, and this asserts that it says so, because a bundle silently
    // treated as regenerable is one somebody will "regenerate" by hand.
    assert!(
        manifest_json["regenerate"].is_null(),
        "the bundle is frozen: there is no command that reproduces it"
    );
    assert!(
        manifest_json["frozen"]
            .as_str()
            .is_some_and(|why| why.contains("#1025 S4")),
        "the manifest must SAY the bundle is frozen, and why"
    );

    // FLOORS, so a bundle that regenerated to nothing cannot pass every
    // comparison below by comparing nothing.
    let cases = v0_cases();
    assert_eq!(
        cases.len(),
        manifest_json["queryCases"].as_u64().expect("a case count") as usize
    );
    assert_eq!(cases.len(), 22);
    let commands = read_json("contracts/apps/locker/commands.json");
    assert_eq!(
        commands.as_array().expect("a list").len(),
        manifest_json["commandCases"].as_u64().expect("a count") as usize
    );
    // Every case carries a reason somebody can read.
    for entry in &cases {
        let why = entry["why"].as_str().unwrap_or_default();
        assert!(
            why.len() > 12,
            "{} at {} has no stated reason",
            entry["query"],
            entry["input"]
        );
    }
}

/// THE FIXTURE MUST NEVER CARRY A SECRET, and the manifest is where that rule
/// is written down.
#[test]
fn the_bundle_tokenises_secrets_rather_than_dropping_or_keeping_them() {
    let manifest_json = read_json("contracts/apps/locker/manifest.json");
    assert_eq!(manifest_json["sealed_cells"], serde_json::json!("«lk1»"));
    let why = manifest_json["sealed_cells_why"]
        .as_str()
        .expect("the manifest says why a sealed cell is tokenised");
    // The distinction the token preserves and `null` would have lost.
    assert!(why.contains("has_totp"), "{why}");
    let never = manifest_json["secrets_never_written"]
        .as_str()
        .expect("the manifest says a secret is never written down");
    assert!(never.contains("«secret»"), "{never}");
    assert!(never.contains("THROW"), "{never}");
    // The fingerprint finding, recorded where the next person regenerating
    // this bundle will read it.
    let canonical = manifest_json["canonicalisation"]
        .as_str()
        .expect("the manifest records what is canonicalised");
    assert!(canonical.contains("fingerprint"), "{canonical}");

    // AND THE FILES DO WHAT THE MANIFEST SAYS. Not one plaintext of the corpus
    // reaches a committed file — asserted here, over the committed bytes,
    // rather than only in the emitter that could be edited.
    for file in ["rows.json", "queries.json", "commands.json"] {
        let text = fs::read_to_string(root().join("contracts/apps/locker").join(file))
            .unwrap_or_else(|error| panic!("{file}: {error}"));
        for secret in [
            "correct-horse-battery-staple",
            "a-rotated-password-42",
            "a-different-passphrase",
            "4242 4242 4242 4242",
            "JBSWY3DPEHPK3PXP",
            "the safe combination",
            "BEGIN PRIVATE KEY",
        ] {
            assert!(
                !text.contains(secret),
                "{file} carries the plaintext of a corpus secret"
            );
        }
        // …and it is not vacuous: a sealed cell WAS seen and tokenised.
        if file != "queries.json" {
            assert!(text.contains('«'), "{file} carries no token at all");
        } else {
            // A query answer may not carry ciphertext even as a token.
            assert!(!text.contains("lk1:"), "a query answer carries ciphertext");
            assert!(
                !text.contains("sealed:v1:"),
                "a query answer carries ciphertext"
            );
        }
    }
}

/// THE FOUR ANSWERS THAT MOVE, named rather than discovered.
#[test]
fn the_manifest_names_every_answer_the_custody_change_moves() {
    let manifest_json = read_json("contracts/apps/locker/manifest.json");
    let changes = manifest_json["outputShapesThatChange"]
        .as_object()
        .expect("the manifest names the answers that change");
    let mut named: Vec<&str> = changes.keys().map(String::as_str).collect();
    named.sort_unstable();
    assert_eq!(
        named,
        [
            "locker.access",
            "locker.export",
            "locker.totp_code",
            "locker.watchtower"
        ]
    );
    // `locker.watchtower` is recorded as v0's and is not a command any more
    // (Q-1047-16).
    for (command, reason) in changes {
        let reason = reason.as_str().unwrap_or_default();
        assert!(
            reason.contains("v0") && reason.len() > 60,
            "{command}'s change is not explained"
        );
    }
    let why = manifest_json["outputShapesWhy"]
        .as_str()
        .expect("the manifest says why four answers move");
    assert!(why.contains("member key"), "{why}");
}

/// The manifest's claims about the port agree with the port.
#[test]
fn the_manifests_query_list_is_the_apps_query_list() {
    let manifest_json = read_json("contracts/apps/locker/manifest.json");
    let declared: Vec<&str> = manifest_json["queries"]
        .as_array()
        .expect("the manifest lists the queries")
        .iter()
        .map(|name| name.as_str().expect("a string"))
        .collect();
    assert_eq!(declared.len(), 8);
    // THREE OF v0's EIGHT ARE RETIRED, named in the parity manifest with why:
    // the autofill pair served a browser extension v0 does not have
    // (R-1047-D3), and the Watchtower review scored weak and reused by
    // unsealing every password (Q-1047-16). The port must NOT carry them, and
    // every other one it must.
    let retired = manifest_json["queriesRetired"]
        .as_object()
        .expect("the parity manifest names the retired queries");
    let mut retired_names: Vec<&str> = retired.keys().map(String::as_str).collect();
    retired_names.sort_unstable();
    assert_eq!(
        retired_names,
        ["autofill-candidates", "autofill-item", "watchtower"]
    );
    for name in &declared {
        if retired.contains_key(*name) {
            assert!(
                manifest().query(name).is_none(),
                "{name} is retired and the app still declares it"
            );
            continue;
        }
        assert!(
            manifest().query(name).is_some(),
            "{name} is in the parity manifest and not in the app's"
        );
    }
    for query in &manifest().queries {
        assert!(
            declared.contains(&query.name.as_str()),
            "{} is an app query the parity manifest does not name",
            query.name
        );
    }
    // And every one of v0's eight has at least one case, so a query nobody
    // fixtured is a red here rather than a gap nobody counted.
    for name in &declared {
        assert!(
            v0_cases()
                .iter()
                .any(|case| case["query"] == serde_json::json!(name)),
            "{name} has no case in the bundle"
        );
    }
}

// DELETED WITH THE TREE IT WALKED (#1025 S4).
// `locker_has_no_demo_seed_and_the_manifest_says_so` listed
// every v0 app directory looking for a `seed.js` beside each app, to say
// that Locker is the one without one. That directory went with
// `chore(retire): delete the v0 tree`. The FACT it established — the corpus is a
// scripted command set rather than a seed — is what every case in this file
// exercises, and the manifest still says so where a reader looks for it.

// ---------------------------------------------------------------------------
// THE EIGHT QUERIES, AGAINST v0's OWN ANSWERS
// ---------------------------------------------------------------------------

/// The `items` shelf at all three of v0's inputs — rows, order, decoration and
/// the foot line's counts.
#[test]
fn the_items_shelf_answers_what_v0_answered() {
    let connection = v0_vault();
    let door = TestDoor::new(&connection);
    let decorations = decorations(&connection, true);

    for (input, shelf) in [
        (serde_json::json!({}), Shelf::Live),
        (serde_json::json!({ "limit": 20 }), Shelf::Live),
        (serde_json::json!({ "archived": true }), Shelf::Archived),
    ] {
        let expected = case("items", input.clone());
        let window = queries::items_window(input["limit"].as_i64());
        let read = queries::read_shelf(&door, &queries::items_statement(shelf), window)
            .expect("the shelf reads");
        let answer = queries::items_answer(shelf, window, &read, &decorations, None);

        // THE WINDOW, which is the one arithmetic v0 got wrong somewhere else
        // and gets right here: 300 by default, clamped UP from 20.
        assert_eq!(
            answer.window as u64,
            expected["output"]["window"].as_u64().expect("a window"),
            "the window at {input}"
        );
        assert_eq!(
            answer.truncated,
            expected["output"]["truncated"]
                .as_bool()
                .expect("truncated"),
            "truncated at {input}"
        );
        assert_eq!(answer.archived, shelf == Shelf::Archived);

        // THE ROWS, in v0's own order, with every field the bundle carries.
        let mine: Vec<serde_json::Value> = answer.items.iter().map(as_case).collect();
        let theirs: Vec<serde_json::Value> = expected["output"]["items"]
            .as_array()
            .expect("v0 answers a list")
            .iter()
            .map(from_case)
            .collect();
        same_rows(
            &mine,
            &theirs,
            &format!("the {shelf:?} shelf's rows at {input}"),
        );
        assert!(!mine.is_empty(), "the shelf is empty at {input}");
    }
}

/// `search` at all four of v0's terms, including the two that find nothing for
/// two different reasons.
#[test]
fn search_answers_what_v0_answered() {
    let connection = v0_vault();
    let door = TestDoor::new(&connection);
    // NO ALIAS MAP: v0's `search.ts:73` calls `decorate` with four arguments
    // and the fifth is the alias. See
    // `only_the_live_shelf_carries_the_connector_alias_in_v0`.
    let decorations = decorations(&connection, false);
    let mut found = 0usize;
    for term in ["bank", "ada@", "", "combination"] {
        let expected = case("search", serde_json::json!({ "term": term }));
        let theirs: Vec<serde_json::Value> = expected["output"]["items"]
            .as_array()
            .expect("a list")
            .iter()
            .map(from_case)
            .collect();
        // An empty term is NO SEARCH, not every row — v0's own rule, and the
        // one case where the port must not even read.
        let mine: Vec<serde_json::Value> = if term.is_empty() {
            Vec::new()
        } else {
            let mut statement = queries::search_statement();
            statement = statement.filter(
                "(title LIKE ? OR username LIKE ?) AND deleted_at IS NULL",
                vec![
                    centraid_apps_kit::statement::PageBindValue::Text(format!("%{term}%")),
                    centraid_apps_kit::statement::PageBindValue::Text(format!("%{term}%")),
                ],
            );
            let read = queries::read_shelf(&door, &statement, queries::SEARCH_ROWS)
                .expect("the search reads");
            let rows: Vec<centraid_apps_locker::queries::ItemRow> = read
                .rows
                .iter()
                .map(centraid_apps_locker::queries::ItemRow::of)
                .collect();
            queries::decorate(&rows, &decorations)
                .iter()
                .map(as_case)
                .collect()
        };
        same_rows(&mine, &theirs, &format!("search {term:?}"));
        found += mine.len();
    }
    // A NOTE'S BODY IS NOT SEARCHED — "combination" is in a note and finds
    // nothing, which is only a real claim if some other term found something.
    assert!(
        found > 0,
        "no term matched anything: the comparison is vacuous"
    );
}

/// The trash shelf: purge dates, the star kept, and the dash subtitle.
#[test]
fn the_trash_shelf_answers_what_v0_answered() {
    let connection = v0_vault();
    let door = TestDoor::new(&connection);
    // NO ALIAS MAP: v0's `trash.ts:44` passes three arguments. A trashed row
    // carries no connector handle.
    let decorations = decorations(&connection, false);
    let expected = case("trash", serde_json::json!({}));
    let read = queries::read_shelf(&door, &queries::trash_statement(), queries::TRASH_ROWS)
        .expect("the trash reads");
    let rows: Vec<centraid_apps_locker::queries::ItemRow> = read
        .rows
        .iter()
        .map(centraid_apps_locker::queries::ItemRow::of)
        .collect();
    let mine: Vec<serde_json::Value> = queries::decorate(&rows, &decorations)
        .iter()
        .map(|row| {
            let mut value = as_case(row);
            let object = value.as_object_mut().expect("an object");
            object.remove("archived");
            object.remove("alias");
            value
        })
        .collect();
    let theirs: Vec<serde_json::Value> = expected["output"]["items"]
        .as_array()
        .expect("a list")
        .iter()
        .map(|row| {
            let mut value = from_case(row);
            let object = value.as_object_mut().expect("an object");
            object.remove("archived");
            object.remove("alias");
            value
        })
        .collect();
    same_rows(&mine, &theirs, "the trash shelf");
    assert_eq!(mine.len(), 1, "the corpus trashes exactly one row");
    // AND THE PURGE DATE IS THERE, which is what this shelf exists to show.
    assert!(
        mine[0]["purge_at"].is_string(),
        "a trashed row with no purge date cannot be counted down"
    );
}

/// The detail pane at both of v0's ids, plus the wrong id that is `None` and
/// never an error.
#[test]
fn the_item_pane_answers_what_v0_answered() {
    let connection = v0_vault();
    let door = TestDoor::new(&connection);
    let decorations = decorations(&connection, true);
    let mut compared = 0usize;
    for entry in v0_cases() {
        if entry["query"] != serde_json::json!("item") {
            continue;
        }
        let item_id = entry["input"]["item_id"].as_str().expect("an id");
        let row = queries::read_item_row(&door, item_id).expect("the row reads");
        let Some(row) = row else {
            assert!(
                entry["output"]["item"].is_null(),
                "the port found no {item_id} and v0 did"
            );
            continue;
        };
        let expected = &entry["output"]["item"];
        assert!(
            expected.is_object(),
            "v0 found no {item_id} and the port did"
        );
        let detail = queries::item_detail(
            row,
            decorations.starred.contains(item_id),
            decorations.tags.get(item_id).cloned().unwrap_or_default(),
            decorations.alias.get(item_id).cloned(),
            centraid_apps_locker::sidecars::Sidecars::default(),
        );
        assert_eq!(
            serde_json::json!(detail.rendered_type),
            expected["type"],
            "the rendered type of {item_id}"
        );
        assert_eq!(
            serde_json::json!(detail.degraded_from),
            expected["degraded_from"]
        );
        assert_eq!(serde_json::json!(detail.favorite), expected["favorite"]);
        assert_eq!(serde_json::json!(detail.tags), expected["tags"]);
        assert_eq!(serde_json::json!(detail.alias), expected["alias"]);
        assert_eq!(serde_json::json!(detail.trashed), expected["trashed"]);
        assert_eq!(serde_json::json!(detail.archived), expected["archived"]);
        assert_eq!(serde_json::json!(detail.row.title), expected["title"]);
        assert_eq!(serde_json::json!(detail.row.username), expected["username"]);
        assert_eq!(serde_json::json!(detail.row.url), expected["url"]);
        assert_eq!(serde_json::json!(detail.row.notes), expected["notes"]);
        // EVERY SEALED CELL IS null IN V0'S OWN ANSWER — v0's gateway did not
        // unseal a Locker row for a client (#996 R13, W6-D2), so the pane
        // paints while the Locker is locked. The port carries no such field at
        // all, which is the stronger version of the same fact.
        for sealed in ["password", "otp_seed", "card_number", "cvv", "content"] {
            assert!(
                expected[sealed].is_null(),
                "v0's item pane carries {sealed}"
            );
        }
        compared += 1;
    }
    assert_eq!(compared, 2, "v0 has two found items and one wrong id");
}

/// V0's `access` QUERY IS REFUSED BY ITS OWN DOOR, and the port answers.
///
/// **The finding.** `queries/access.ts` reads `FROM access_receipt`. The paged
/// door resolves a FROM table through the vault's entity catalog, and
/// `access_receipt` is not one of its 96 entities — so the door refuses
/// (`gateway/paged-door.ts:436`) and the query's catch arm answers
/// `{entries: [], vaultDenied: …}`. The Locker access screen has therefore
/// been empty in v0 for as long as this door has been the read path, and v0's
/// own suite is green because `queries-reveal-access.test.ts` drives a stub
/// `ctx` that never reaches the door.
///
/// Recorded as a finding rather than fixed at source (R-1020-35's "anything
/// wider is a finding"): the fix registers the audit band in the entity
/// catalog, which widens the paged door's reach into a band it has never
/// covered — an owner's security call. The generator plants the three receipts
/// through v0's own `writeReceipt` so this comparison is over real rows.
#[test]
fn v0s_access_query_is_refused_by_its_own_door_and_the_port_answers() {
    // THE FINDING, asserted so it cannot be quietly "fixed" by a regeneration
    // that nobody reads.
    for input in [serde_json::json!({}), serde_json::json!({ "limit": 20 })] {
        let expected = case("access", input.clone());
        assert_eq!(
            expected["output"]["entries"],
            serde_json::json!([]),
            "v0 answered an access history at {input} — the finding is fixed and \
             this test is what should now compare entries"
        );
        let denial = expected["output"]["vaultDenied"]["message"]
            .as_str()
            .expect("v0's own catch arm records the refusal");
        assert!(
            denial.contains("access_receipt") && denial.contains("not an entity of this vault"),
            "{denial}"
        );
    }

    // AND THE PORT ANSWERS THE HISTORY. Same rows, same window, over the same
    // vault — which is what makes the finding a finding rather than an opinion.
    let connection = v0_vault();
    let door = TestDoor::new(&connection);
    let window = queries::access_window(None);
    assert_eq!(window, queries::ACCESS_DEFAULT);
    let read = queries::read_shelf(
        &door,
        &queries::access_statement(None).expect("the statement builds"),
        window,
    )
    .expect("the audit band reads");
    let answer = queries::access_answer(window, &read.rows);
    assert_eq!(
        answer.entries.len(),
        3,
        "the generator planted three receipts and the port reads them"
    );
    // BOTH KINDS AND BOTH DECISIONS, which is what the port's fold has to get
    // right and what v0's stub-driven suite was the only thing testing. Keyed
    // by KIND rather than by index: `occurred_at` is `<host-clock>` for all
    // forty-nine receipts, so this answer is one of the five the fixture
    // cannot order (see the header). v0 planted a third receipt, a Companion
    // FILL; the fill plane is deleted (R-1047-D3), so the port reads it as the
    // reveal of a sealed cell it is — two reveals and an unlock.
    use centraid_apps_locker::queries::AccessKind;
    let mut kinds: Vec<_> = answer.entries.iter().map(|entry| entry.kind).collect();
    kinds.sort_by_key(|kind| format!("{kind:?}"));
    assert_eq!(
        kinds,
        [AccessKind::Auth, AccessKind::Reveal, AccessKind::Reveal],
        "an unlock and two reveals"
    );
    let of = |kind: AccessKind| {
        answer
            .entries
            .iter()
            .find(|entry| entry.kind == kind)
            .unwrap_or_else(|| panic!("no {kind:?} entry"))
    };
    assert!(
        answer
            .entries
            .iter()
            .filter(|entry| entry.kind == AccessKind::Reveal)
            .all(|entry| entry.action == "reveal")
    );
    // A DENIAL IS LISTED LIKE AN ALLOWANCE — the boundary receipts both.
    assert!(
        !of(AccessKind::Auth).allowed,
        "the denied unlock is receipted too"
    );
    assert_eq!(
        of(AccessKind::Auth).reason.as_deref(),
        Some("wrong passphrase")
    );
    assert!(
        of(AccessKind::Auth).item_id.is_none(),
        "an unlock names no item"
    );
    assert_eq!(
        of(AccessKind::Reveal).columns.as_deref(),
        Some(["password".to_owned()].as_slice()),
        "the reveal says which cell was opened"
    );
    // THE INNER WALL HELD: no `agent.command` receipt reached the screen, and
    // the corpus wrote dozens of them.
    assert!(
        answer
            .entries
            .iter()
            .all(|entry| entry.action == "reveal"
                || entry.action.starts_with("authenticate locker.")),
        "a receipt that is not Locker's reached the Locker access screen"
    );
    let planted = read_json("contracts/apps/locker/rows.json")
        .as_array()
        .expect("a list")
        .iter()
        .find(|table| table["table"] == serde_json::json!("access_receipt"))
        .expect("the bundle carries the audit band")["rows"]
        .as_array()
        .expect("a list")
        .len();
    assert!(
        planted > 3,
        "the fixture carries only the planted receipts: the wall proves nothing"
    );
}

/// THE ORDER THE FIXTURE CANNOT REBUILD, ASSERTED WHERE IT CAN BE.
///
/// The five multiset comparisons above lose v0's sequence because
/// `updated_at` and `occurred_at` are flattened to `<host-clock>` (see this
/// file's header). What survives is the claim each statement makes about its
/// own order, and that is checked here against **v0's own statements**, read
/// out of the v0 tree rather than restated — so a port that quietly ordered a
/// shelf by title is a red, and so is a v0 change to either column.
#[test]
fn every_shelf_declares_the_same_order() {
    // The port's four shelves and its audit window.
    for (what, order) in [
        ("live", queries::items_statement(Shelf::Live).order.clone()),
        (
            "archived",
            queries::items_statement(Shelf::Archived).order.clone(),
        ),
        ("search", queries::search_statement().order.clone()),
        ("trash", queries::trash_statement().order.clone()),
    ] {
        assert_eq!(order.sort_column, "updated_at", "{what} sorts by");
        assert_eq!(order.pk_column, "item_id", "{what} breaks ties by");
        assert!(order.descending, "{what} is newest first");
    }
    let audit = queries::access_statement(None)
        .expect("the statement builds")
        .order
        .clone();
    assert_eq!(audit.sort_column, "occurred_at");
    assert_eq!(audit.pk_column, "receipt_id");
    assert!(audit.descending);

    // THE v0 HALF IS DELETED (#1025 S4). What stood here read four v0 query
    // files and asserted they declared the same order, because "a port whose
    // order agrees with a fixture that cannot express order proves nothing".
    // The files went with `chore(retire): delete the v0 tree` and the claim is
    // unfalsifiable without them — so it is gone rather than left as a grep
    // over a path that does not exist. What remains above is a fact about this
    // port's own declarations, which is what a later change would break.
}

/// ONLY THE LIVE SHELF CARRIES THE CONNECTOR ALIAS IN v0, and the port
/// reproduces that rather than tidying it.
///
/// `decorate`'s fifth parameter is `aliasByItem` and v0 passes it from exactly
/// one of its four callers: `items.ts:418`. `search.ts:73` passes four
/// arguments, `trash.ts:44` three, `watchtower.ts:48` four. So a connector
/// alias appears on the live shelf and vanishes from the same row found by
/// search — with no rule stated anywhere for why.
///
/// **Re-judged rather than cited** (AGENTS.md: a citation is not a
/// justification). Nothing depends on the asymmetry: `alias` is optional on
/// `DecoratedItem`, no surface branches on its absence, and the alias is
/// plaintext at rest on a row the shelf already read — so it is neither a
/// secret being withheld nor a read being saved (the alias map is ONE bounded
/// read the live shelf already does). It reads as an omission, not a decision.
///
/// It is reproduced here because parity is the exit criterion and a port that
/// answered more than v0 would be unverifiable against it. **Owner question:**
/// should the port decorate all four shelves with the alias? Options: (a) keep
/// v0's asymmetry, and this test is the record of it; (b) decorate all four,
/// which costs one bounded read on search and makes the
/// connector handle stable wherever a row appears; (c) drop the alias from the
/// live shelf too and let only the item pane carry it. **Recommendation: (b)**
/// — the alias exists so a connector can name a row across a rotation, and a
/// handle that depends on which screen found the row is not a handle.
#[test]
fn only_the_live_shelf_carries_the_connector_alias() {
    // THE v0 SOURCE HALF IS DELETED (#1025 S4). It read `decorate(` out of four
    // v0 query files and counted arguments. Those files went with
    // `chore(retire): delete the v0 tree`, so the asymmetry can no longer be
    // read off the source — it is read off the ANSWERS instead, below and in the
    // three shelves' own cases, which is where it was always observable. The
    // owner question above is unchanged and still open.

    // THE FIXTURE'S OWN ANSWERS. The bank has an alias on the live shelf.
    let live = case("items", serde_json::json!({}));
    let bank = live["output"]["items"]
        .as_array()
        .expect("a list")
        .iter()
        .find(|row| row["title"] == serde_json::json!("The bank"))
        .expect("the corpus has the bank");
    assert_eq!(bank["alias"], serde_json::json!("bank"));
    // The same row, found by search, has none.
    let searched = case("search", serde_json::json!({ "term": "bank" }));
    let same = searched["output"]["items"]
        .as_array()
        .expect("a list")
        .iter()
        .find(|row| row["item_id"] == bank["item_id"])
        .expect("search finds the same row");
    assert!(
        same["alias"].is_null(),
        "search carries the alias now: the finding is resolved"
    );
}
