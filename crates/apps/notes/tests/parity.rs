//! PARITY WITH v0, CASE BY CASE (#1020, D-1020-D3-6).
//!
//! `contracts/apps/notes/` is generated from the v0 tree by
//! `contracts/tools/export-notes-parity.ts`: a fresh vault, the app's own demo
//! seed and a scripted command set through the REAL typed commands, then all six
//! Notes queries through the real handler path. This suite rebuilds that vault
//! from `rows.json` — a database created from `contracts/schema/vault-ddl.sql`,
//! the committed schema of the #929 golden corpus — reads the same queries
//! through the ported statements, and compares the answers to `queries.json`.
//!
//! ## Ids are COMPARED here, not masked
//!
//! Nothing in this suite mints an id: the rows come from the fixture with their
//! canonical `id-0007` tokens already in them, so a ported query's answer
//! carries the same ids v0's did and **page order is part of the comparison**. A
//! port that returned the right rows in the wrong order fails.
//!
//! ## The three deliberate divergences, stated as mappings
//!
//! 1. **A target carries its app's ID, not its NAME.** v0's `LinkTarget.app` is
//!    `"Notes"`, looked up in `@centraid/design`'s catalogue; the port's
//!    [`centraid_search::Target::app_id`] is `"notes"`, because the product
//!    catalogue owns the name (#883, ruling O-label) and `crates/design` is
//!    where it is lowered. The mapping below applies the same catalogue.
//! 2. **A note target's SUBTITLE is its body preview here and the app's name in
//!    v0.** `link-targets-table.ts:30` declares `subtitles: ["preview"]` for
//!    notes — and `ctx.vault.search` returns the base row, which has no
//!    `preview` column, so `first(row, subtitles)` is empty and every note
//!    target falls back to the app's name. The declared subtitle has never been
//!    served. The port reads the decoded body out of `core_content_text`, which
//!    is the same text the index was built from. **A finding, not a reproduced
//!    blank** (this lane's receipt); the mapping states it so the rest of the
//!    target is still compared exactly.
//! 3. **A library row's `selector` is `null` in v0 and absent here** when a link
//!    has no anchor. v0 writes `selectorByLink.get(id) ?? null`; the port's
//!    `Option` serialises to the same `null` through the mapping.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::cards::{OwnerCards, RefCard};
use centraid_apps_notes::queries::{
    Attachment, BacklinkEntry, JournalData, LibraryData, LibraryRow, NoteData, ReferenceEntry,
    SearchData, load_history, load_journal, load_library, load_link_targets, load_note,
    load_search,
};
use centraid_search::{Principal, SqliteDoor};
use serde_json::{Value, json};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn fixture(name: &str) -> Value {
    let path = root().join("contracts/apps/notes").join(name);
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
    let rows = fs::read_to_string(root().join("contracts/apps/notes/rows.json"))
        .expect("the committed rows are readable");
    open_contract_vault(&ddl, &rows).expect("the fixture vault is built")
}

// ---------------------------------------------------------------------------
// The mapping onto v0's wire shape. One place, so a field name that moved is one
// edit and a comparison that silently stopped comparing is impossible.
// ---------------------------------------------------------------------------

fn card_json(card: &RefCard) -> Value {
    json!({
        "type": card.entity,
        "id": card.id,
        "status": card.status.as_str(),
        "title": card.title,
        "subtitle": card.subtitle,
        "thumbnail_content_id": card.thumbnail_content_id,
    })
}

fn attachment_json(attachment: &Attachment) -> Value {
    json!({
        "attachment_id": attachment.attachment_id,
        "content_id": attachment.content_id,
        "role": attachment.role,
        "is_primary": attachment.is_primary,
        "media_type": attachment.media_type,
        "content_uri": attachment.content_uri,
        "byte_size": attachment.byte_size,
    })
}

fn reference_json(entry: &ReferenceEntry) -> Value {
    json!({
        "link_id": entry.link_id,
        // v0 writes `?? null`, so an unanchored reference is an explicit null.
        "selector": entry.selector.clone().unwrap_or(Value::Null),
        "card": card_json(&entry.card),
    })
}

fn backlink_json(entry: &BacklinkEntry) -> Value {
    json!({ "link_id": entry.link_id, "card": card_json(&entry.card) })
}

fn library_row_json(row: &LibraryRow) -> Value {
    json!({
        "note_id": row.note_id,
        "title": row.title,
        "format": row.format,
        "pinned": row.pinned,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "deleted_at": row.deleted_at,
        "purge_at": row.purge_at,
        "preview": row.preview,
        "check": { "total": row.check.total, "done": row.check.done },
        "notebook_ids": row.notebook_ids,
        "notebook_names": row.notebook_names,
        "attachments": row.attachments.iter().map(attachment_json).collect::<Vec<Value>>(),
        "references": row.references.iter().map(reference_json).collect::<Vec<Value>>(),
        "backlinks": row.backlinks.iter().map(backlink_json).collect::<Vec<Value>>(),
        "tags": row.tags.iter().map(|tag| json!({
            "tag_id": tag.tag_id,
            "concept_id": tag.concept_id,
            "label": tag.label,
        })).collect::<Vec<Value>>(),
    })
}

fn library_json(data: &LibraryData) -> Value {
    json!({
        "notes": data.notes.iter().map(library_row_json).collect::<Vec<Value>>(),
        "trash": data.trash.iter().map(library_row_json).collect::<Vec<Value>>(),
        "notebooks": data.notebooks.iter().map(|notebook| json!({
            "notebook_id": notebook.notebook_id,
            "name": notebook.name,
            "sort_order": notebook.sort_order,
        })).collect::<Vec<Value>>(),
        "tags": data.tags.iter().map(|facet| json!({
            "concept_id": facet.concept_id,
            "label": facet.label,
        })).collect::<Vec<Value>>(),
        "truncated": data.truncated,
        "window": data.window,
    })
}

fn journal_json(data: &JournalData) -> Value {
    json!({
        "entries": data.entries.iter().map(|entry| json!({
            "note_id": entry.note_id,
            "title": entry.title,
            "format": entry.format,
            "created_at": entry.created_at,
            "updated_at": entry.updated_at,
            "deleted_at": entry.deleted_at,
            "preview": entry.preview,
            "check": { "total": entry.check.total, "done": entry.check.done },
        })).collect::<Vec<Value>>(),
        "truncated": data.truncated,
        "window": data.window,
    })
}

fn search_json(data: &SearchData) -> Value {
    json!({
        "notes": data.notes.iter().map(|row| json!({
            "note_id": row.note_id,
            "title": row.title,
            "format": row.format,
            "pinned": row.pinned,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
            "preview": row.preview,
            "check": { "total": row.check.total, "done": row.check.done },
            "notebook_ids": row.notebook_ids,
            "notebook_names": row.notebook_names,
            "attachments": row.attachments.iter().map(attachment_json).collect::<Vec<Value>>(),
            "snippet": row.snippet,
        })).collect::<Vec<Value>>(),
    })
}

/// v0's `note` answer, whose SHAPE depends on the case: an empty id
/// short-circuits before `format` exists at all (`note.ts:15`).
fn note_json(data: &NoteData, asked: &str) -> Value {
    if asked.trim().is_empty() {
        return json!({ "note_id": data.note_id, "body": data.body });
    }
    json!({ "note_id": data.note_id, "body": data.body, "format": data.format })
}

/// The app NAME v0's `linkTargetAppLabel` looks up, for the one divergence a
/// mapping can close. `crates/design` is where this lowering lands; until it
/// carries the catalogue, the four labels this corpus can produce are here.
fn app_label(app_id: &str) -> &'static str {
    match app_id {
        "notes" => "Notes",
        "people" => "People",
        "agenda" => "Agenda",
        "tasks" => "Tasks",
        "tally" => "Tally",
        "photos" => "Photos",
        "docs" => "Docs",
        other => panic!("{other} is not one of the seven domains"),
    }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/// Every case in the fixture, by query, with its input and v0's answer.
fn cases() -> Vec<(String, Value, Value)> {
    fixture("queries.json")
        .as_array()
        .expect("the fixture is a list of cases")
        .iter()
        .map(|case| {
            (
                case["query"].as_str().expect("a query name").to_owned(),
                case["input"].clone(),
                case["output"].clone(),
            )
        })
        .collect()
}

fn limit_of(input: &Value) -> Option<i64> {
    input.get("limit").and_then(Value::as_i64)
}

fn term_of(input: &Value) -> String {
    input
        .get("term")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn note_id_of(input: &Value) -> String {
    input
        .get("note_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// THE WHOLE FIXTURE, case by case. Ids, page order and every decoration.
#[test]
fn every_case_in_the_fixture_is_what_the_port_answers() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let search = SqliteDoor::open(&connection).expect("the FTS door opens");
    let mut compared: BTreeMap<String, usize> = BTreeMap::new();

    for (query, input, expected) in cases() {
        let answered = match query.as_str() {
            "library" => {
                let (data, denial) =
                    load_library(&door, &cards, limit_of(&input)).expect("the library folds");
                assert!(denial.is_none(), "the owner is not denied: {denial:?}");
                library_json(&data)
            }
            "journal" => {
                let (data, denial) =
                    load_journal(&door, limit_of(&input)).expect("the journal folds");
                assert!(denial.is_none(), "the owner is not denied: {denial:?}");
                journal_json(&data)
            }
            "note" => {
                let asked = note_id_of(&input);
                let (data, denial) = load_note(&door, &asked).expect("the note reads");
                assert!(denial.is_none(), "the owner is not denied: {denial:?}");
                note_json(&data, &asked)
            }
            "history" => {
                let (data, denial) =
                    load_history(&door, &note_id_of(&input)).expect("history folds");
                assert!(denial.is_none(), "the owner is not denied: {denial:?}");
                json!({
                    "versions": data.versions.iter().map(|version| json!({
                        "content_id": version.content_id,
                        "body": version.body,
                        "media_type": version.media_type,
                        "current": version.current,
                        "asserted_at": version.asserted_at,
                    })).collect::<Vec<Value>>(),
                })
            }
            "search" => {
                let (data, denial) =
                    load_search(&door, &search, &Principal::Owner, &term_of(&input))
                        .expect("search folds");
                assert!(denial.is_none(), "the owner is not denied: {denial:?}");
                search_json(&data)
            }
            // THE ONE CASE COMPARED THROUGH A NARROWER PROJECTION — see the
            // module note's divergence (2). Every field but the subtitle is
            // compared exactly, and the subtitle has its own test below.
            "link-targets" => {
                let (data, denial) =
                    load_link_targets(&door, &search, &Principal::Owner, &term_of(&input))
                        .expect("the powerbox folds");
                assert!(denial.is_none(), "the owner is not denied: {denial:?}");
                json!({
                    "targets": data.targets.iter().map(|target| json!({
                        "type": target.entity,
                        "id": target.id,
                        "title": target.title,
                        "app": app_label(&target.app_id),
                    })).collect::<Vec<Value>>(),
                })
            }
            other => panic!("{other} is not one of the six queries"),
        };
        let expected = if query == "link-targets" {
            json!({
                "targets": expected["targets"]
                    .as_array()
                    .expect("the targets are a list")
                    .iter()
                    .map(|target| json!({
                        "type": target["type"],
                        "id": target["id"],
                        "title": target["title"],
                        "app": target["app"],
                    }))
                    .collect::<Vec<Value>>(),
            })
        } else {
            expected
        };
        assert_eq!(answered, expected, "`{query}` at {input} disagrees with v0");
        *compared.entry(query).or_default() += 1;
    }

    // A SILENTLY EMPTY RUN WOULD PASS EVERY ASSERTION ABOVE. This is the floor.
    assert_eq!(
        compared,
        BTreeMap::from([
            ("history".to_owned(), 8),
            ("journal".to_owned(), 2),
            ("library".to_owned(), 5),
            ("link-targets".to_owned(), 3),
            ("note".to_owned(), 8),
            ("search".to_owned(), 4),
        ])
    );
}

/// **THE SUBTITLE DIVERGENCE, ASSERTED RATHER THAN HIDDEN** (divergence 2).
///
/// v0 answers every note target's subtitle as the app's name, because the
/// declared `preview` column is not on the row the search returns. The port
/// answers the body preview. A test that only skipped the field would let the
/// port quietly regress to v0's blank; this one states both answers.
#[test]
fn a_note_targets_subtitle_is_the_preview_here_and_the_app_name_in_v0() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    let search = SqliteDoor::open(&connection).expect("the FTS door opens");
    let (data, _) =
        load_link_targets(&door, &search, &Principal::Owner, "cabin").expect("the powerbox folds");
    assert!(!data.targets.is_empty());
    for target in &data.targets {
        assert_eq!(target.entity, "knowledge.note");
        assert_ne!(
            target.subtitle, "notes",
            "the port serves the declared preview rather than falling back to the app"
        );
        assert!(target.subtitle.chars().count() <= 200);
    }

    let v0 = cases()
        .into_iter()
        .find(|(query, input, _)| query == "link-targets" && term_of(input) == "cabin")
        .map(|(_, _, output)| output)
        .expect("the fixture has the case");
    for target in v0["targets"].as_array().expect("a list") {
        assert_eq!(
            target["subtitle"],
            json!("Notes"),
            "v0's declared `subtitles: [\"preview\"]` has never been served"
        );
    }
}

/// THE COMMAND SCRIPT IS REPLAYABLE, and the one step this build cannot run
/// names the schema that owes it.
///
/// The replay itself is `crates/vault/tests/knowledge_commands.rs`' business —
/// it holds the vault and the registry. What this asserts is that the fixture's
/// script is well-formed for a replay: every `$from` reference points at a step
/// that declares the key it names, and every step that is not `pending` invokes
/// a command this build carries.
#[test]
fn every_step_of_the_script_is_replayable_by_this_build() {
    let script = fixture("commands.json");
    let steps = script.as_array().expect("the script is a list");
    assert!(steps.len() >= 35, "{} steps", steps.len());
    let mut pending = 0usize;
    let mut refusals = 0usize;
    for (index, step) in steps.iter().enumerate() {
        let command = step["command"].as_str().expect("a command name");
        if step["status"].as_str() != Some("executed") {
            refusals += 1;
        }
        if step.get("pending").is_some() {
            pending += 1;
            assert_eq!(step["pending"], json!("schedule"));
            assert_eq!(command, "schedule.add_task");
            continue;
        }
        assert!(
            command.starts_with("knowledge.") || command.starts_with("core."),
            "step {index} invokes {command}, which is no schema this lane holds"
        );
        for value in step["input"].as_object().expect("an input object").values() {
            let Some(reference) = value.get("$from").and_then(Value::as_str) else {
                continue;
            };
            let (at, field) = reference.split_once('.').expect("a <step>.<key> reference");
            let at: usize = at.parse().expect("a step ordinal");
            assert!(
                at < index,
                "step {index} references step {at}, which is later"
            );
            let keys = steps[at]["output_keys"]
                .as_array()
                .expect("a key list")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<&str>>();
            assert!(
                keys.contains(&field),
                "step {index} wants `{field}` and step {at} declares {keys:?}"
            );
        }
    }
    assert_eq!(pending, 1, "exactly one step is owed by another lane");
    assert!(refusals >= 12, "only {refusals} refusals in the script");
}

/// THE ROWS THE FIXTURE CARRIES ARE THE ROWS THE STATEMENTS READ. A table the
/// port reads and the fixture does not export is a comparison that would pass
/// over an empty set.
#[test]
fn the_fixture_vault_answers_every_statement_this_app_makes() {
    let connection = fixture_vault();
    let door = TestDoor::new(&connection);
    for (name, select, from) in [
        (
            "notes.library.recent",
            "note_id, updated_at",
            "knowledge_note",
        ),
        (
            "notes.library.notebooks",
            "collection_id, name",
            "core_collection",
        ),
        (
            "notes.library.attachments",
            "attachment_id",
            "core_attachment",
        ),
        ("notes.library.links", "link_id", "core_link"),
        ("notes.library.anchors", "anchor_id", "core_link_anchor"),
        ("notes.library.tags", "tag_id", "core_tag"),
        ("notes.library.concepts", "concept_id", "core_concept"),
        (
            "notes.history.revisions",
            "revision_id",
            "core_entity_revision",
        ),
        ("notes.library.contents", "content_id", "core_content_item"),
    ] {
        let column = select.split(',').next().expect("a first column").trim();
        let statement = centraid_apps_kit::statement::PageQuery::new(
            name,
            select,
            from,
            centraid_apps_kit::statement::PageOrder::asc(column, column),
        );
        let page = door
            .page(&statement, &centraid_apps_kit::page::PageRequest::first(10))
            .unwrap_or_else(|error| panic!("{name} over {from}: {error}"));
        assert!(!page.rows.is_empty(), "{from} is empty in the fixture");
    }
}
