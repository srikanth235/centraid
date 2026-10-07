//! THE SAMPLE VAULT, through the door a phone uses.
//!
//! A phone that founds its first vault also founds a SAMPLE vault beside it and
//! seeds it with the Tahoe scenario (`centraid_core::sample`). These cases hold
//! what the shell relies on without being able to check for itself:
//!
//! - the scenario lands across seven apps through the command plane; on a core
//!   opened with the member's seed and the sample's own index it also lands a
//!   handful of fake Locker items sealed under THAT vault's `K` — which open
//!   under the member's seed and index and under no other, least of all the
//!   dev fixture's public all-`abandon` words; a core with no seed founds the
//!   sample without Locker;
//! - the mark is inside the vault, readable by the very page statement
//!   `VaultRoster.QUERY` sends, and it says `ready` only once the scenario is
//!   whole;
//! - a sample vault — finished or not — refuses to pair and to drain, so no row
//!   of it can reach the member's laptop;
//! - a member's own first vault is not a sample, and its starter rows land.

use centraid_core::api_proto as wire;
use centraid_core::{Core, CoreConfig, CoreError, Handle, Seed};
use centraid_vault::bootstrap::SampleMark;

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        self.handle.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A created, unfounded file with its own byte store, as `centraid_open` makes
/// one: photographs need a store to land in. UNKEYED — a core with no seed.
fn fresh() -> Scratch {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let handle = open_at(&dir, None, true);
    Scratch { dir, handle }
}

/// A created, unfounded file opened KEYED at `index`, as the shell opens a
/// sample it has reserved an index for.
fn fresh_keyed(seed: &Seed, index: u32) -> Scratch {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let handle = open_at(&dir, Some((seed.clone(), index)), true);
    Scratch { dir, handle }
}

/// The file in `dir`, opened with this seed and index or with none. A REOPEN
/// asks for no byte store: the first handle's has not dropped yet, and Locker
/// needs no photographs.
fn open_at(dir: &std::path::Path, keyed: Option<(Seed, u32)>, bytes: bool) -> Handle {
    let path = dir.join("vault.db");
    let config = match keyed {
        Some((seed, index)) => CoreConfig::new(&path).with_seed(seed, index),
        None => CoreConfig::new(&path),
    };
    let handle = Core::open(config).expect("a core opens with create");
    if bytes {
        handle
            .open_own_bytes(path.with_extension("bytes"))
            .expect("the byte store opens");
    }
    handle
}

/// A member's seed: freshly generated, so it is nobody's but this test's.
fn members_seed() -> Seed {
    centraid_identity::RecoveryPhrase::generate()
        .expect("a phrase is minted")
        .seed()
}

/// THE DEV FIXTURE'S SEED — the public all-`abandon` BIP39 vector that
/// `seed-demo-vault` seals ITS Locker under. Held here only to prove a product
/// sample does not open under it.
fn public_demo_seed() -> Seed {
    centraid_identity::RecoveryPhrase::parse(
        "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art",
    )
    .expect("the demo words are a valid phrase")
    .seed()
}

/// One Locker session step through the door a shell uses.
fn locker(
    handle: &Handle,
    step: wire::locker_session_request::Step,
) -> wire::LockerSessionResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(step),
            })),
        })
        .expect("a Locker step is answered");
    match answer.kind {
        Some(wire::response::Kind::Locker(answer)) => answer,
        other => panic!("a Locker step answered {other:?}"),
    }
}

/// Unlock, then reveal one item's cell: the plaintext, or the refusal.
fn reveal(handle: &Handle, item: &str, column: &str) -> Result<String, i32> {
    use wire::locker_session_request::Step;
    locker(handle, Step::Unlock(wire::LockerUnlock {}));
    let answer = locker(
        handle,
        Step::Reveal(wire::LockerReveal {
            item_id: item.to_owned(),
            column: column.to_owned(),
            ..wire::LockerReveal::default()
        }),
    );
    match answer.revealed {
        Some(revealed) => Ok(revealed.value),
        None => Err(answer.refusal),
    }
}

fn found(
    handle: &Handle,
    name: &str,
    content: wire::FoundContent,
) -> Result<wire::FoundResponse, CoreError> {
    let answer = handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Found(wire::FoundRequest {
            display_name: name.to_owned(),
            owner_name: "Me".to_owned(),
            content: content as i32,
        })),
    })?;
    match answer.kind {
        Some(wire::response::Kind::Found(found)) => Ok(found),
        other => panic!("a found answered {other:?}"),
    }
}

fn page(handle: &Handle, from: &str, select: &[&str], pk: &str) -> Vec<wire::Row> {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(wire::PageQuery {
                    name: "sample.test".to_owned(),
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
            })),
        })
        .unwrap_or_else(|refusal| panic!("paging {from} was refused: {refusal}"));
    match answer.kind {
        Some(wire::response::Kind::Page(page)) => page.rows,
        other => panic!("a page answered {other:?}"),
    }
}

fn count(handle: &Handle, from: &str, pk: &str) -> usize {
    page(handle, from, &[pk], pk).len()
}

fn text(value: &wire::Value) -> Option<&str> {
    match value.kind.as_ref()? {
        wire::value::Kind::Text(text) => Some(text),
        _ => None,
    }
}

/// THE ONE STATEMENT A SHELL NAMES A VAULT WITH (`VaultRoster.QUERY`), spelled
/// here as the wire carries it: the shell is Kotlin and this is the contract.
fn identify(handle: &Handle) -> (String, String, Option<String>) {
    let rows = page(
        handle,
        "core_vault",
        &[
            "vault_id",
            "display_name",
            "json_extract(settings_json, '$.sample') AS sample",
        ],
        "vault_id",
    );
    let row = rows.first().expect("a founded vault names itself");
    (
        text(&row.values[0]).unwrap_or_default().to_owned(),
        text(&row.values[1]).unwrap_or_default().to_owned(),
        row.values.get(2).and_then(text).map(str::to_owned),
    )
}

fn mark(handle: &Handle) -> Option<SampleMark> {
    handle
        .with_vault(|vault| Ok(vault.sample_mark()?))
        .expect("the mark reads")
}

/// THE SCENARIO LANDS ACROSS SEVEN APPS, on a core with no seed too.
fn assert_seven_apps(handle: &Handle) {
    for (app, table, pk) in [
        ("people", "people_profile", "profile_id"),
        ("notes", "knowledge_note", "note_id"),
        ("docs", "core_document", "document_id"),
        ("photos", "media_asset", "asset_id"),
        ("tasks", "schedule_task", "task_id"),
        ("tally", "tally_group", "group_id"),
        ("agenda", "core_event", "event_id"),
    ] {
        assert!(
            count(handle, table, pk) > 0,
            "the sample seeded no {app} rows"
        );
    }
    // NINETEEN FRAMES WITH BYTES: eighteen photographs and the one video.
    assert_eq!(count(handle, "media_asset", "asset_id"), 19);
}

#[test]
fn a_keyed_sample_seeds_seven_apps_and_five_sealed_locker_items() {
    let member = members_seed();
    let scratch = fresh_keyed(&member, 3);
    let answer = found(&scratch.handle, "Sample", wire::FoundContent::Sample)
        .expect("the sample vault is founded and seeded whole");
    assert!(!answer.vault_id.is_empty());
    assert_seven_apps(&scratch.handle);

    // FIVE ITEMS, and the session the seeding opened is shut again.
    assert_eq!(count(&scratch.handle, "locker_item", "item_id"), 5);
    assert_eq!(
        locker(
            &scratch.handle,
            wire::locker_session_request::Step::State(wire::LockerStateAsk {})
        )
        .state,
        wire::LockerSessionState::Locked as i32,
        "the seeding left Locker unlocked"
    );

    // THE MARK IS INSIDE THE VAULT, and the shell's own statement reads it.
    assert_eq!(mark(&scratch.handle), Some(SampleMark::Ready));
    let (vault_id, name, sample) = identify(&scratch.handle);
    assert_eq!(vault_id, answer.vault_id);
    assert_eq!(name, "Sample");
    assert_eq!(sample.as_deref(), Some("ready"));
    assert!(scratch.handle.holds_a_sample());

    // A SECRET READS BACK THROUGH THE SHELL'S OWN DOOR: unlock, reveal.
    assert_eq!(
        reveal(&scratch.handle, "sample-locker-wifi", "password").as_deref(),
        Ok("tahoe-cabin-guest")
    );
    assert_eq!(
        reveal(&scratch.handle, "sample-locker-card", "card_number").as_deref(),
        Ok("4242424242424242")
    );
}

/// THE SEALED ITEMS OPEN UNDER THE MEMBER'S SEED AND THIS VAULT'S INDEX, AND
/// UNDER NOTHING ELSE. The dev fixture's all-`abandon` words — the one seed
/// that is public — at its own index 0 or at the sample's, the member's own
/// seed at another index, and another member's seed at the sample's index all
/// answer `DID_NOT_OPEN`, never a wrong plaintext.
#[test]
fn the_samples_locker_opens_under_the_members_seed_and_index_and_no_other() {
    let member = members_seed();
    let mut scratch = fresh_keyed(&member, 3);
    found(&scratch.handle, "Sample", wire::FoundContent::Sample).expect("founded");
    scratch.handle.close();

    let did_not_open = wire::LockerRevealRefusal::DidNotOpen as i32;
    for (label, keys, opens) in [
        (
            "the member's seed at the sample's index",
            Some((member.clone(), 3)),
            true,
        ),
        (
            "the member's seed at another index",
            Some((member.clone(), 2)),
            false,
        ),
        (
            "the public demo seed at index 0",
            Some((public_demo_seed(), 0)),
            false,
        ),
        (
            "the public demo seed at the sample's index",
            Some((public_demo_seed(), 3)),
            false,
        ),
        (
            "another member's seed at the sample's index",
            Some((members_seed(), 3)),
            false,
        ),
    ] {
        scratch.handle = open_at(&scratch.dir, keys, false);
        let revealed = reveal(&scratch.handle, "sample-locker-wifi", "password");
        if opens {
            assert_eq!(revealed.as_deref(), Ok("tahoe-cabin-guest"), "{label}");
        } else {
            assert_eq!(revealed, Err(did_not_open), "{label}");
        }
        scratch.handle.close();
    }
}

/// A CORE OPENED WITH NO SEED has no `K`: the sample is founded whole and has
/// no Locker, and its Locker cannot be unlocked — never sealed under a
/// stand-in.
#[test]
fn an_unkeyed_sample_has_no_locker_items_and_no_locker_key() {
    let scratch = fresh();
    found(&scratch.handle, "Sample", wire::FoundContent::Sample)
        .expect("an unkeyed sample is founded and seeded whole");
    assert_seven_apps(&scratch.handle);
    assert_eq!(count(&scratch.handle, "locker_item", "item_id"), 0);
    assert_eq!(mark(&scratch.handle), Some(SampleMark::Ready));
    let unlock = scratch
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(wire::locker_session_request::Step::Unlock(
                    wire::LockerUnlock {},
                )),
            })),
        })
        .expect_err("a core with no seed cannot open Locker");
    assert!(
        matches!(unlock, CoreError::Unavailable { .. }),
        "{unlock:?}"
    );
}

#[test]
fn a_sample_vault_refuses_to_pair_and_to_drain() {
    // KEYED, AS A MEMBER'S IS: the keys buy Locker and nothing else, so a keyed
    // sample refuses a drain and a pairing exactly as an unkeyed one does.
    let scratch = fresh_keyed(&members_seed(), 1);
    found(&scratch.handle, "Sample", wire::FoundContent::Sample).expect("founded");

    let drain = scratch
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(wire::DrainRequest::default())),
        })
        .expect_err("a sample vault does not drain");
    assert!(matches!(drain, CoreError::SampleVault { .. }), "{drain:?}");
    assert_eq!(drain.code(), wire::ErrorCode::InvalidRequest);

    let pair = scratch
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::PairPhone(wire::PairRequest {
                payload: "anything at all".to_owned(),
            })),
        })
        .expect_err("a sample vault does not pair");
    assert!(matches!(pair, CoreError::SampleVault { .. }), "{pair:?}");
    // REFUSED BEFORE THE PAYLOAD IS EVEN READ: the ledger beside the vault
    // records no gateway as a destination (#1080).
    let ledger_path =
        centraid_vault::backup::ledger::Ledger::path_for(&scratch.dir.join("vault.db"));
    if ledger_path.exists() {
        let ledger =
            centraid_vault::backup::ledger::Ledger::open(&ledger_path).expect("the ledger opens");
        assert!(ledger.destinations().expect("the ledger reads").is_empty());
    }
}

/// A PROCESS KILLED MID-SEED leaves the mark at `seeding`. That vault is not a
/// finished sample — the shell deletes it — and it is still a sample to every
/// guard here, so nothing half-seeded ever pairs or drains either.
#[test]
fn an_interrupted_sample_says_seeding_and_still_refuses_to_leave() {
    let scratch = fresh();
    scratch
        .handle
        .with_vault(|vault| Ok(vault.found_sample("Sample", "Me")?))
        .expect("the found's own commit lands");

    assert_eq!(mark(&scratch.handle), Some(SampleMark::Seeding));
    let (_, _, sample) = identify(&scratch.handle);
    assert_eq!(sample.as_deref(), Some("seeding"));
    assert!(scratch.handle.holds_a_sample());
    let drain = scratch
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(wire::DrainRequest::default())),
        })
        .expect_err("half a sample does not drain");
    assert!(matches!(drain, CoreError::SampleVault { .. }), "{drain:?}");
}

/// THE MEMBER'S OWN FIRST VAULT IS NOT A SAMPLE, and its two starter rows land
/// through the command plane: a note and a task, so it is not a blank wall.
#[test]
fn a_members_first_vault_is_not_a_sample_and_gets_its_starters() {
    let scratch = fresh();
    found(&scratch.handle, "My vault", wire::FoundContent::Starters).expect("founded");

    assert_eq!(mark(&scratch.handle), None);
    assert!(!scratch.handle.holds_a_sample());
    let (_, name, sample) = identify(&scratch.handle);
    assert_eq!(name, "My vault");
    assert_eq!(sample, None, "a member's vault carries no sample mark");
    assert_eq!(count(&scratch.handle, "knowledge_note", "note_id"), 1);
    assert_eq!(count(&scratch.handle, "schedule_task", "task_id"), 1);
    assert_eq!(count(&scratch.handle, "media_asset", "asset_id"), 0);
}

#[test]
fn an_empty_found_writes_no_rows_and_no_mark() {
    let scratch = fresh();
    found(&scratch.handle, "Plain", wire::FoundContent::Empty).expect("founded");
    assert_eq!(mark(&scratch.handle), None);
    assert_eq!(count(&scratch.handle, "knowledge_note", "note_id"), 0);
    assert_eq!(count(&scratch.handle, "schedule_task", "task_id"), 0);
}

/// FINISHING IS ONLY FOR A SAMPLE THAT IS STILL SEEDING: a member's vault is
/// never turned into a sample by it, and a finished one is not finished twice.
#[test]
fn only_a_seeding_sample_can_be_finished() {
    let scratch = fresh();
    found(&scratch.handle, "My vault", wire::FoundContent::Empty).expect("founded");
    let refused = scratch
        .handle
        .with_vault(|vault| Ok(vault.finish_sample()?))
        .expect_err("a member's vault is not a sample");
    assert!(refused.to_string().contains("sample"), "{refused}");
    assert_eq!(mark(&scratch.handle), None);
}

/// THE PRODUCT PATH CARRIES NO WORDS, NO DEMO SEED AND NO KEY OF ITS OWN. The
/// scenario's sources are read as text: the demo phrase, a name of the demo
/// seed or a core opened with a seed of the scenario's own anywhere in them is
/// a sample vault that could one day seal under public words. Locker is there
/// — sealed through the core's own door, under the keys the open core derived
/// from the member's seed — and every Locker command it runs is one the shell
/// runs too.
#[test]
fn the_scenario_source_names_no_words_no_demo_seed_and_no_key_of_its_own() {
    for (file, source) in [
        ("sample.rs", include_str!("../src/sample.rs")),
        ("sample/locker.rs", include_str!("../src/sample/locker.rs")),
    ] {
        for needle in [
            "abandon abandon",
            "DEMO_WORDS",
            "demo_seed",
            "with_seed",
            "RecoveryPhrase",
            "Keyring::derive",
            "encrypt_under_locker_key",
        ] {
            assert!(
                !source.contains(needle),
                "{file} carries {needle:?}: the sample's keys are the open core's, never its own"
            );
        }
    }
    // THE LOCKER STEP SEALS BY THE CORE'S OWN FUNCTION, not a copy of it.
    let locker = include_str!("../src/sample/locker.rs");
    assert!(locker.contains("session::seal_command"));
    assert!(locker.contains("Step::Unlock"));
    // AND THE FIRST-PARTY BINARY'S SEEDER IS NOT THE PRODUCT'S: the one place
    // the demo words live is the dev binary.
    assert!(!centraid_core::sample::APPS.contains(&"locker"));
}
