//! THE EXAMPLE, through the door a phone uses.
//!
//! "See an example" opens a SEPARATE, EPHEMERAL core over a temporary
//! directory (`CoreConfig::example`), founds it with `FOUND_CONTENT_EXAMPLE`,
//! renders from it, then closes it and deletes the directory (docs/decisions.md,
//! "Onboarding without sample data"). These cases hold what the shell relies on
//! without being able to check for itself:
//!
//! - an example core founds the Tahoe scenario across seven apps, with no
//!   Locker and no keys;
//! - only an example core founds the example, an example founds nothing else
//!   and nothing twice, it is never keyed, and every write and every backup
//!   door is refused with `CoreError::Example`;
//! - **AN EXAMPLE LEAVES NOTHING BEHIND**: a member's vault beside it is byte
//!   for byte what it was, and the example's directory is gone;
//! - the scenario's sources name no words, no seed and no Locker;
//! - a member's first vault gets exactly the starter rows `starters` declares.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use centraid_core::api_proto as wire;
use centraid_core::{Core, CoreConfig, CoreError, Handle, Seed};

/// A core over `dir/vault.db`, created, with its own byte store beside it as
/// `centraid_open` makes one: photographs need a store to land in.
fn open(dir: &Path, config: impl FnOnce(CoreConfig) -> CoreConfig) -> Handle {
    std::fs::create_dir_all(dir).expect("the directory is made");
    let path = dir.join("vault.db");
    let handle = Core::open(config(CoreConfig::new(&path))).expect("a core opens with create");
    handle
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    handle
}

/// An EXAMPLE core over `dir`, unfounded.
fn example_at(dir: &Path) -> Handle {
    open(dir, CoreConfig::as_example)
}

/// A member's seed: freshly generated, so it is nobody's but this test's.
fn members_seed() -> Seed {
    centraid_identity::RecoveryPhrase::generate()
        .expect("a phrase is minted")
        .seed()
}

fn call(handle: &Handle, kind: wire::request::Kind) -> Result<wire::Response, CoreError> {
    handle.call(&wire::Request { kind: Some(kind) })
}

fn found(handle: &Handle, content: wire::FoundContent) -> Result<wire::FoundResponse, CoreError> {
    let answer = call(
        handle,
        wire::request::Kind::Found(wire::FoundRequest {
            display_name: "Tahoe".to_owned(),
            owner_name: "Me".to_owned(),
            content: content as i32,
            tz: String::new(),
        }),
    )?;
    match answer.kind {
        Some(wire::response::Kind::Found(found)) => Ok(found),
        other => panic!("a found answered {other:?}"),
    }
}

fn page(handle: &Handle, from: &str, select: &[&str], pk: &str) -> Vec<wire::Row> {
    let answer = call(
        handle,
        wire::request::Kind::Page(wire::PageRequest {
            query: Some(wire::PageQuery {
                name: "example.test".to_owned(),
                select: select.iter().map(|column| (*column).to_owned()).collect(),
                from: from.to_owned(),
                r#where: None,
                bind: Vec::new(),
                order: Some(wire::PageOrder {
                    sort_column: pk.to_owned(),
                    pk_column: pk.to_owned(),
                    descending: false,
                }),
                with_held_thumbnail: false,
                with_note_body: false,
                with_document_size: false,
                with_minor_units: false,
                local_day_columns: Vec::new(),
                tz: String::new(),
            }),
            limit: 500,
            after: None,
        }),
    )
    .unwrap_or_else(|refusal| panic!("paging {from} was refused: {refusal}"));
    match answer.kind {
        Some(wire::response::Kind::Page(page)) => page.rows,
        other => panic!("a page answered {other:?}"),
    }
}

fn count(handle: &Handle, from: &str, pk: &str) -> usize {
    page(handle, from, &[pk], pk).len()
}

fn texts(handle: &Handle, from: &str, column: &str, pk: &str) -> Vec<String> {
    page(handle, from, &[pk, column], pk)
        .iter()
        .filter_map(|row| match row.values.get(1)?.kind.as_ref()? {
            wire::value::Kind::Text(text) => Some(text.clone()),
            _ => None,
        })
        .collect()
}

/// A notes search through the app's own query: the FTS index, read.
fn notes_search(handle: &Handle, term: &str) -> usize {
    let answer = call(
        handle,
        wire::request::Kind::AppQuery(wire::AppQueryRequest {
            query: Some(wire::app_query_request::Query::NotesSearch(
                wire::NotesSearchRequest {
                    term: term.to_owned(),
                    tz: "UTC".to_owned(),
                },
            )),
        }),
    )
    .unwrap_or_else(|refusal| panic!("searching notes was refused: {refusal}"));
    match answer.kind {
        Some(wire::response::Kind::AppQuery(query)) => match query.answer {
            Some(wire::app_query_response::Answer::NotesSearch(search)) => search.hits.len(),
            other => panic!("a notes search answered {other:?}"),
        },
        other => panic!("an app query answered {other:?}"),
    }
}

/// Whether the file this core holds has been founded.
fn founded(handle: &Handle) -> bool {
    handle
        .with_vault(|vault| Ok(vault.vault_id()?))
        .expect("the vault id reads")
        .is_some()
}

/// THE SEVEN APPS' MAIN TABLES, as the scenario seeds them.
const SEVEN: [(&str, &str, &str); 7] = [
    ("people", "people_profile", "profile_id"),
    ("notes", "knowledge_note", "note_id"),
    ("docs", "core_document", "document_id"),
    ("photos", "media_asset", "asset_id"),
    ("tasks", "schedule_task", "task_id"),
    ("tally", "tally_group", "group_id"),
    ("agenda", "core_event", "event_id"),
];

#[test]
fn an_example_core_founds_the_scenario_across_seven_apps_with_no_locker_and_no_keys() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = example_at(dir.path());
    assert!(handle.is_example());
    let answer = found(&handle, wire::FoundContent::Example).expect("the example is founded whole");
    assert!(!answer.vault_id.is_empty());

    for (app, table, pk) in SEVEN {
        assert!(
            count(&handle, table, pk) > 0,
            "the example seeded no {app} rows"
        );
    }
    assert_eq!(
        SEVEN.map(|(app, _, _)| app).len(),
        centraid_core::example::APPS.len()
    );
    // NINETEEN FRAMES WITH BYTES: eighteen photographs and the one video.
    assert_eq!(count(&handle, "media_asset", "asset_id"), 19);
    // NO LOCKER, and nothing that could open one.
    assert_eq!(count(&handle, "locker_item", "item_id"), 0);
    let unlock = call(
        &handle,
        wire::request::Kind::Locker(wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Unlock(
                wire::LockerUnlock {},
            )),
        }),
    )
    .expect_err("an example opens no Locker");
    assert!(matches!(unlock, CoreError::Example { .. }), "{unlock:?}");
    // UNKEYED: a door that needs the vault's keys is refused before it asks.
    let drain = call(
        &handle,
        wire::request::Kind::Drain(wire::DrainRequest::default()),
    )
    .expect_err("an example does not back up");
    assert!(matches!(drain, CoreError::Example { .. }), "{drain:?}");
    handle.close();
}

#[test]
fn a_members_core_refuses_the_example_and_its_file_stays_unfounded() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = open(dir.path(), |config| config);
    let refused = found(&handle, wire::FoundContent::Example)
        .expect_err("only an example core founds the example");
    assert!(
        matches!(&refused, CoreError::InvalidRequest { detail } if detail.contains("example")),
        "{refused:?}"
    );
    assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    assert!(!founded(&handle), "the refusal wrote nothing");
    // AND THE SAME FILE STILL FOUNDS AS A MEMBER'S VAULT.
    found(&handle, wire::FoundContent::Starters).expect("the member's found lands");
    handle.close();
}

#[test]
fn an_example_core_is_never_keyed() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let path = dir.path().join("vault.db");
    let refused = Core::open(
        CoreConfig::new(&path)
            .as_example()
            .with_seed(members_seed(), 0),
    )
    .err()
    .expect("an example with a seed is refused");
    assert!(
        matches!(refused, CoreError::InvalidRequest { .. }),
        "{refused:?}"
    );
    assert!(!path.exists(), "refused before the file is touched");
}

#[test]
fn an_example_founds_only_the_example_and_only_once() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = example_at(dir.path());
    for content in [
        wire::FoundContent::Unspecified,
        wire::FoundContent::Starters,
    ] {
        let refused = found(&handle, content).expect_err("an example founds only the example");
        assert!(matches!(refused, CoreError::Example { .. }), "{refused:?}");
        assert!(!founded(&handle), "{content:?} wrote nothing");
    }
    let first = found(&handle, wire::FoundContent::Example).expect("the example founds");
    let notes = count(&handle, "knowledge_note", "note_id");
    for content in [
        wire::FoundContent::Example,
        wire::FoundContent::Starters,
        wire::FoundContent::Unspecified,
    ] {
        let refused = found(&handle, content).expect_err("an example founds once");
        assert!(matches!(refused, CoreError::Example { .. }), "{refused:?}");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    }
    assert_eq!(count(&handle, "knowledge_note", "note_id"), notes);
    let vault_id = handle
        .with_vault(|vault| Ok(vault.vault_id()?))
        .expect("reads");
    assert_eq!(vault_id.as_deref(), Some(first.vault_id.as_str()));
    handle.close();
}

/// EVERY DOOR THAT WRITES, SEALS, DIALS A GATEWAY OR FEEDS THE CHAT, refused
/// on a founded example: one assertion per request kind.
#[test]
fn an_example_refuses_every_write_and_every_backup_door() {
    use wire::request::Kind as K;
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = example_at(dir.path());
    found(&handle, wire::FoundContent::Example).expect("the example founds");
    let notes = count(&handle, "knowledge_note", "note_id");

    let note = wire::Command {
        name: "knowledge.create_note".to_owned(),
        input: serde_json::to_vec(&serde_json::json!({
            "title": "Mine now", "body_text": "no", "format": "plain"
        }))
        .expect("encodes"),
        invoke_key: "test:example-write".to_owned(),
        ..wire::Command::default()
    };
    for (label, kind) in [
        ("command", K::Command(note)),
        ("locker", K::Locker(wire::LockerSessionRequest::default())),
        ("stage", K::Stage(wire::StageRequest::default())),
        ("originals", K::Originals(wire::OriginalsRequest::default())),
        ("assist", K::Assist(wire::AssistRequest::default())),
        ("drain", K::Drain(wire::DrainRequest::default())),
        (
            "pair_phone",
            K::PairPhone(wire::PairRequest {
                payload: "anything at all".to_owned(),
            }),
        ),
        ("restore", K::Restore(wire::RestoreRequest::default())),
        (
            "backup_status",
            K::BackupStatus(wire::BackupStatusRequest::default()),
        ),
        ("handoff", K::Handoff(wire::HandoffRequest::default())),
        ("settle", K::Settle(wire::SettleRequest::default())),
        (
            "fetch_original",
            K::FetchOriginal(wire::FetchOriginalRequest::default()),
        ),
        ("pins", K::Pins(wire::PinsRequest::default())),
        ("reconcile", K::Reconcile(wire::ReconcileRequest::default())),
        (
            "forget_destination",
            K::ForgetDestination(wire::ForgetDestinationRequest::default()),
        ),
        (
            "releasable",
            K::Releasable(wire::ReleasableRequest::default()),
        ),
        ("released", K::Released(wire::ReleasedRequest::default())),
    ] {
        let refused = call(&handle, kind).expect_err(label);
        assert!(
            matches!(refused, CoreError::Example { .. }),
            "{label}: {refused:?}"
        );
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest, "{label}");
        assert!(
            refused.to_string().starts_with("this is an example"),
            "{label}: {refused}"
        );
    }
    assert_eq!(
        count(&handle, "knowledge_note", "note_id"),
        notes,
        "no write landed"
    );
    // THE BACKUP PLANE NEVER OPENED: no ledger, no spool, no scratch copy.
    assert_no_backup_plane(dir.path());
    handle.close();
}

/// AN EXAMPLE CORE OPENS NO BACKUP PLANE. `Plane::of` creates nothing at open,
/// `Handle::open_own_bytes` opens no ledger for an example, and every door that
/// would open one is refused — so the directory holds the vault, its SQLite
/// sidecars and its byte store, and nothing of the backup's.
fn assert_no_backup_plane(dir: &Path) {
    let path = dir.join("vault.db");
    let plane = centraid_core::phone::Plane::of(&path);
    for leftover in [plane.ledger_path(), plane.spool_dir(), plane.scratch_dir()] {
        assert!(!leftover.exists(), "{} exists", leftover.display());
    }
}

/// Every file under `root`, by its path relative to `root`, with its bytes.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, at: &Path, into: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(at).expect("the directory reads") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                walk(root, &path, into);
            } else {
                let relative = path.strip_prefix(root).expect("under root").to_path_buf();
                into.insert(relative, std::fs::read(&path).expect("the file reads"));
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

/// **AN EXAMPLE LEAVES NOTHING BEHIND.** A member's vault is made the way a
/// phone makes one — keyed, founded with its starters, written to, searched,
/// its backup status read so the ledger exists beside it — and closed. An
/// example core is then opened in a SIBLING directory, founded, read, closed
/// and deleted. The member's directory is byte for byte what it was, and the
/// example's is gone.
#[test]
fn an_example_leaves_nothing_behind() {
    let parent = tempfile::tempdir().expect("a scratch directory");
    let member_dir = parent.path().join("member");
    let example_dir = parent.path().join("example");

    // THE MEMBER'S VAULT, AS A PHONE MAKES IT.
    let member = open(&member_dir, |config| config.with_seed(members_seed(), 0));
    found(&member, wire::FoundContent::Starters).expect("the member's vault founds");
    let written = call(
        &member,
        wire::request::Kind::Command(wire::Command {
            name: "knowledge.create_note".to_owned(),
            input: serde_json::to_vec(&serde_json::json!({
                "title": "Lighthouse keys",
                "body_text": "The spare is under the blue planter.",
                "format": "plain",
            }))
            .expect("encodes"),
            invoke_key: "test:member-note".to_owned(),
            ..wire::Command::default()
        }),
    )
    .expect("the member writes a note");
    let Some(wire::response::Kind::Command(outcome)) = written.kind else {
        panic!("a command answered {:?}", written.kind);
    };
    assert_eq!(outcome.status, wire::CommandStatus::Executed as i32);
    assert_eq!(
        notes_search(&member, "planter"),
        1,
        "the FTS index holds it"
    );
    call(
        &member,
        wire::request::Kind::BackupStatus(wire::BackupStatusRequest::default()),
    )
    .expect("the member's backup status reads");
    let ledger = centraid_core::phone::Plane::of(&member_dir.join("vault.db")).ledger_path();
    assert!(ledger.exists(), "the member's ledger is beside the vault");
    member.close_file().expect("the member's file ends");
    member.close();
    drop(member);
    let before = snapshot(&member_dir);
    assert!(before.len() >= 2, "the vault and its ledger: {before:?}");

    // THE EXAMPLE, BESIDE IT.
    let example = example_at(&example_dir);
    found(&example, wire::FoundContent::Example).expect("the example founds");
    assert!(count(&example, "schedule_task", "task_id") > 0);
    assert!(count(&example, "media_asset", "asset_id") > 0);
    assert!(notes_search(&example, "chili") > 0, "the example searches");
    assert_eq!(
        notes_search(&example, "planter"),
        0,
        "nothing of the member's"
    );
    assert_no_backup_plane(&example_dir);
    example.close();
    drop(example);
    std::fs::remove_dir_all(&example_dir).expect("the shell deletes the example");

    // NOTHING MOVED.
    assert!(!example_dir.exists(), "the example's directory is gone");
    let after = snapshot(&member_dir);
    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>(),
        "the member's directory holds the same files"
    );
    for (file, bytes) in &before {
        assert!(
            after.get(file) == Some(bytes),
            "{} changed under the example",
            file.display()
        );
    }
    let siblings: Vec<_> = std::fs::read_dir(parent.path())
        .expect("the parent reads")
        .map(|entry| entry.expect("an entry").file_name())
        .collect();
    assert_eq!(siblings, vec![std::ffi::OsString::from("member")]);
}

/// THE SCENARIO CARRIES NO WORDS, NO SEED AND NO LOCKER. Its sources are read
/// as text: the demo phrase, a seed, a key or a Locker command anywhere in them
/// is an example that could one day seal under somebody's words. The one place
/// the demo words live is the dev binary.
#[test]
fn the_scenario_source_names_no_words_no_seed_and_no_locker() {
    for (file, source) in [
        ("example.rs", include_str!("../src/example.rs")),
        ("starters.rs", include_str!("../src/starters.rs")),
    ] {
        for needle in [
            "abandon abandon",
            "DEMO_WORDS",
            "demo_seed",
            "with_seed",
            "RecoveryPhrase",
            "Keyring",
            "Sealing",
            "seal_command",
            "encrypt_under_locker_key",
            "\"locker.",
        ] {
            assert!(
                !source.contains(needle),
                "{file} carries {needle:?}: an example is never keyed and holds no Locker"
            );
        }
    }
    assert!(!centraid_core::example::APPS.contains(&"locker"));
}

/// THE MEMBER'S FIRST VAULT GETS EXACTLY THE DECLARED STARTERS, read against
/// `starters`' own consts so a change of content keeps this green.
#[test]
fn a_members_first_vault_gets_every_declared_starter_row() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = open(dir.path(), |config| config);
    found(&handle, wire::FoundContent::Starters).expect("founded");

    let mut notes = texts(&handle, "knowledge_note", "title", "note_id");
    let mut want_notes: Vec<String> = centraid_core::starters::NOTES
        .iter()
        .map(|(title, _)| (*title).to_owned())
        .collect();
    notes.sort();
    want_notes.sort();
    assert_eq!(notes, want_notes);

    let mut tasks = texts(&handle, "schedule_task", "title", "task_id");
    let mut want_tasks: Vec<String> = centraid_core::starters::TASKS
        .iter()
        .map(|title| (*title).to_owned())
        .collect();
    tasks.sort();
    want_tasks.sort();
    assert_eq!(tasks, want_tasks);

    assert_eq!(count(&handle, "media_asset", "asset_id"), 0);
    handle.close();
}

#[test]
fn the_starter_tasks_are_due_on_the_members_today_in_their_zone() {
    // 2026-10-10T01:00:00Z is still the 9th in Los Angeles: a starter dated by
    // UTC would sit tomorrow and leave Today empty on a west-coast evening.
    let evening = 1_791_594_000_000_i64;
    assert_eq!(
        centraid_core::starters::local_today("America/Los_Angeles", evening),
        "2026-10-09"
    );
    assert_eq!(
        centraid_core::starters::local_today("Asia/Kolkata", evening),
        "2026-10-10"
    );
    // NO ZONE, OR ONE THE DATABASE DOES NOT KNOW, IS UTC.
    assert_eq!(
        centraid_core::starters::local_today("", evening),
        "2026-10-10"
    );
    assert_eq!(
        centraid_core::starters::local_today("Mars/Olympus", evening),
        "2026-10-10"
    );

    // THROUGH THE HANDLE: a found that names no zone dates them by UTC.
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = open(dir.path(), |config| config);
    found(&handle, wire::FoundContent::Starters).expect("founded");
    let today = centraid_core::starters::local_today("", centraid_core::example::now_ms());
    let due = texts(&handle, "schedule_task", "due_at", "task_id");
    assert_eq!(due.len(), centraid_core::starters::TASKS.len());
    assert!(
        due.iter().all(|day| day.starts_with(&today)),
        "{due:?} against {today}"
    );
    handle.close();
}

#[test]
fn an_empty_found_writes_no_rows() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    let handle = open(dir.path(), |config| config);
    found(&handle, wire::FoundContent::Unspecified).expect("founded");
    assert_eq!(count(&handle, "knowledge_note", "note_id"), 0);
    assert_eq!(count(&handle, "schedule_task", "task_id"), 0);
    handle.close();
}
