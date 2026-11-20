//! THE BACKUP SURVIVES THE PROCESS (#1202, the iOS retest): pair a phone through the real
//! `pair.laptop` screen against a real gateway, back up until the gateway has acknowledged, lose
//! the process (a new core opened from the device store alone) and find the phone still paired,
//! with a second backup that goes through.
//!
//! The token the core minted is the shell's to keep (E12). Everything between the core and the
//! Keychain is the screens layer's: the key the pairing writes, the key a reopened core is handed
//! its tokens under, and the key a forget deletes must be one spelling of the vault's id.

mod vault_support;

use std::path::Path;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::Handle;
use centraid_core::vaults::Vaults;
use centraid_gateway::server::harness::{self, Spawned};
use centraid_screens::pairing::routes;
use centraid_screens::testing::FakeShell;
use vault_support::*;
use wire::pair_laptop_event::Kind as P;
use wire::screen_event::Kind as E;

struct Gateway {
    runtime: tokio::runtime::Runtime,
    _dir: tempfile::TempDir,
    spawned: Spawned,
}

fn gateway() -> Gateway {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime");
    let dir = tempfile::tempdir().expect("a directory");
    let spawned = runtime
        .block_on(harness::spawn(dir.path()))
        .expect("the gateway starts");
    Gateway {
        runtime,
        _dir: dir,
        spawned,
    }
}

impl Gateway {
    fn payload(&self) -> String {
        let _ = &self.runtime;
        self.spawned.payload().to_json()
    }
}

/// A keyed phone over `dir` holding `id`, with `shell` as its device and synchronised stores.
fn launched(dir: &Path, id: &str, shell: FakeShell) -> Phone {
    let mut phone = Phone::standard(dir);
    phone.shell = shell;
    phone.keep_seed();
    phone.record_index(id, 0);
    phone.launch();
    phone.driver.pump(Duration::from_millis(500));
    assert!(phone.held(id).keyed, "the vault opens keyed");
    phone
}

fn call(core: &Handle, kind: wire::request::Kind) -> wire::response::Kind {
    core.call(&wire::Request { kind: Some(kind) })
        .unwrap_or_else(|error| panic!("refused: {error}"))
        .kind
        .expect("an answer has a kind")
}

fn status(core: &Handle) -> wire::BackupStatusResponse {
    let wire::response::Kind::BackupStatus(status) = call(
        core,
        wire::request::Kind::BackupStatus(wire::BackupStatusRequest {}),
    ) else {
        panic!("a status answers");
    };
    status
}

/// A drain once the phone's own pass is done. A relaunched phone starts a pass of its own, and a
/// second pass while one runs is refused, never queued (core-ffi CONTRACT); so a refusal here
/// pumps the phone and asks again, a bounded number of times.
fn drain_when_free(phone: &mut Phone, core: &Handle) -> wire::DrainResponse {
    let request = wire::request::Kind::Drain(wire::DrainRequest {
        deadline_ms: 0,
        rule: wire::TransferRule::WifiOnly as i32,
        metered: false,
        charging: true,
        wants_snapshot: true,
        exclude_videos: false,
        asked: false,
    });
    for _ in 0..200 {
        match core.call(&wire::Request {
            kind: Some(request.clone()),
        }) {
            Ok(wire::Response {
                kind: Some(wire::response::Kind::Drain(drained)),
            }) => return drained,
            Ok(other) => panic!("a drain answers: {other:?}"),
            Err(error) if error.to_string().contains("a drain is already running") => {
                phone.driver.pump(Duration::from_millis(50));
            }
            Err(error) => panic!("refused: {error}"),
        }
    }
    panic!("the phone's own pass never finished");
}

/// Pair through the screen a member uses, and let the shell keep what it asks to keep.
fn pair(phone: &mut Phone, payload: &str) {
    let page = phone.driver.push("home", routes::laptop());
    let pairing = |phone: &Phone| match &phone.driver.view(page).kind {
        Some(wire::view_state::Kind::PairLaptop(state)) => state.phase,
        other => panic!("not the pairing screen: {other:?}"),
    };
    let send = |phone: &mut Phone, kind: P| {
        phone.driver.send(
            page,
            E::PairLaptop(wire::PairLaptopEvent { kind: Some(kind) }),
        );
    };
    send(
        phone,
        P::Typed(wire::pair_laptop_event::PayloadTyped {
            text: payload.to_owned(),
        }),
    );
    send(phone, P::Primary(wire::pair_laptop_event::Primary {}));
    for _ in 0..100 {
        phone.driver.pump(Duration::from_millis(100));
        if pairing(phone) == wire::pair_laptop_state::Phase::Paired as i32 {
            break;
        }
    }
    assert_eq!(
        pairing(phone),
        wire::pair_laptop_state::Phase::Paired as i32,
        "the pairing completes"
    );
    // THE SHELL PERFORMS THE KEYCHAIN WRITE THE SCREEN ASKED FOR.
    phone.driver.serve(&mut phone.shell);
}

fn waiting_to_pair_again(core: &Handle) -> bool {
    status(core)
        .destinations
        .iter()
        .any(|destination| destination.pair_again)
}

#[test]
fn a_paired_phone_is_still_paired_and_still_backs_up_after_the_process_dies() {
    let gateway = gateway();
    let dir = scratch();
    let id = lay_down(&dir, "a", "Home");
    let mut phone = launched(&dir, &id, FakeShell::default());
    let core = phone.shelf.core_of(&id).expect("the vault is open");

    pair(&mut phone, &gateway.payload());

    // THE TOKEN IS IN THE DEVICE STORE, under the key the contract names: the vault's identity
    // (64 hex), not the shelf's own id for it, and a gateway id (32 hex).
    let kept: Vec<&String> = phone
        .shell
        .device
        .keys()
        .filter(|key| key.starts_with("gateway-token."))
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    let parts: Vec<&str> = kept[0]["gateway-token.".len()..].split('.').collect();
    assert_eq!((parts[0].len(), parts[1].len()), (64, 32), "{kept:?}");
    assert_eq!(
        Some(parts[0].to_owned()),
        core.vault_hex(),
        "the vault's identity, not its shelf id"
    );
    assert_ne!(parts[0], id);
    let identity = parts[0].to_owned();
    // THE OS NAMES A FINISHED UPLOAD'S VAULT BY ITS IDENTITY; the shelf finds its own id from it.
    assert_eq!(phone.secrets.shelf_id_of(&identity), Some(id.clone()));

    // THE FIRST BACKUP IS ACKNOWLEDGED, and nothing is left for the operating system to be handed.
    // Pairing may start the phone's own pass: wait for it, then read the first backup from the
    // ledger, whichever pass made it.
    drain_when_free(&mut phone, &core);
    let first = status(&core);
    assert!(first.last_snapshot_ms.is_some(), "{first:?}");
    assert_eq!(first.pending_bytes, 0, "{first:?}");
    assert!(!waiting_to_pair_again(&core));
    let first_snapshot_ms = status(&core)
        .last_snapshot_ms
        .expect("the first backup named a snapshot");

    // THE PROCESS DIES: a new phone over the same files, with only the device store carried over.
    let shell = phone.shell.clone();
    drop(core);
    drop(phone);
    let mut phone = launched(&dir, &id, shell);
    let core = phone.shelf.core_of(&id).expect("the vault is open");
    assert!(
        !waiting_to_pair_again(&core),
        "the relaunched phone is still paired: {:?}",
        status(&core).destinations
    );

    // AND A SECOND BACKUP GOES THROUGH: something new to send, acknowledged by the gateway.
    core.command(
        "note.create",
        &serde_json::json!({"title": "After the restart", "body": "Still backed up."}),
        "after-the-restart",
    )
    .expect("a note is written");
    // The relaunched phone's own pass may be running, or may carry the note itself: read the
    // outcome from the ledger, not from whose pass sent it.
    let first_snapshot = first_snapshot_ms;
    drain_when_free(&mut phone, &core);
    let after = status(&core);
    assert!(
        after
            .last_snapshot_ms
            .expect("a snapshot after the restart")
            > first_snapshot,
        "a newer snapshot, holding the note, was acknowledged: {after:?}"
    );
    assert_eq!(after.pending_bytes, 0, "{after:?}");

    // FORGETTING THE VAULT DELETES ITS TOKENS under the same key the pairing wrote.
    let forgotten = phone.shelf.forget(&id);
    let deleted: Vec<&str> = forgotten
        .writes
        .iter()
        .filter(|op| op.op == wire::secret_op::Op::Delete as i32)
        .map(|op| op.key.as_str())
        .filter(|key| key.starts_with("gateway-token."))
        .collect();
    assert_eq!(deleted.len(), 1, "{:?}", forgotten.writes);
    assert!(deleted[0].starts_with(&format!("gateway-token.{identity}.")));
}

#[test]
fn work_queued_before_the_process_dies_is_still_queued_and_goes_out_after_the_restart() {
    let gateway = gateway();
    let dir = scratch();
    let id = lay_down(&dir, "a", "Home");
    let mut phone = launched(&dir, &id, FakeShell::default());
    let core = phone.shelf.core_of(&id).expect("the vault is open");
    pair(&mut phone, &gateway.payload());
    // Pairing may start the phone's own pass: wait for it, then read the first backup from the
    // ledger, whichever pass made it.
    drain_when_free(&mut phone, &core);
    let first = status(&core);
    assert!(first.last_snapshot_ms.is_some(), "{first:?}");
    assert_eq!(first.pending_bytes, 0, "{first:?}");

    // A note is written and the process dies before any backup carried it.
    core.command(
        "note.create",
        &serde_json::json!({"title": "Queued", "body": "Written before the process died."}),
        "queued-before-the-restart",
    )
    .expect("a note is written");
    let before = status(&core)
        .last_snapshot_ms
        .expect("the first backup named a snapshot");
    let shell = phone.shell.clone();
    drop(core);
    drop(phone);

    // The relaunched phone is still paired and still owes that note: a backup after the restart
    // carries it. The phone's own launch pass may be the one that does, so the test asks once that
    // pass is done, and reads the outcome from the ledger rather than from whose pass sent it.
    let mut phone = launched(&dir, &id, shell);
    let core = phone.shelf.core_of(&id).expect("the vault is open");
    assert!(!waiting_to_pair_again(&core));
    drain_when_free(&mut phone, &core);
    let after = status(&core);
    assert!(
        after
            .last_snapshot_ms
            .expect("a snapshot after the restart")
            > before,
        "a newer snapshot, holding the note, was acknowledged: {after:?}"
    );
    assert_eq!(after.pending_bytes, 0, "{after:?}");
    // And nothing is left owed: a further pass has nothing new to send.
    let again = drain_when_free(&mut phone, &core);
    assert_eq!(again.confirmed_parts, 0, "{again:?}");
}

#[test]
fn after_the_first_backup_the_same_phone_shows_its_24_words() {
    let gateway = gateway();
    let dir = scratch();
    let id = lay_down(&dir, "a", "Home");
    let mut phone = launched(&dir, &id, FakeShell::default());
    // The words this phone made: kept on the device beside the seed the vault opened with.
    let mut words = vec!["abandon"; 23];
    words.push("art");
    phone.shell.device.insert(
        centraid_screens::custody::secrets::LOCAL_WORDS.to_owned(),
        words.join(" "),
    );
    phone.driver.serve(&mut phone.shell);
    let core = phone.shelf.core_of(&id).expect("the vault is open");
    pair(&mut phone, &gateway.payload());
    // Pairing may start the phone's own pass: wait for it, then read the first backup from the
    // ledger, whichever pass made it.
    drain_when_free(&mut phone, &core);
    let first = status(&core);
    assert!(first.last_snapshot_ms.is_some(), "{first:?}");
    assert_eq!(first.pending_bytes, 0, "{first:?}");

    // THE MEMBER OPENS THE WORDS from the same running phone, after the first backup.
    let page = phone
        .driver
        .push("home", centraid_screens::custody::routes::show());
    phone.driver.serve(&mut phone.shell);
    // The screen asked for the owner check; other effects of the launch and the pairing may be
    // waiting in front of it, and the shell answers the one that was asked.
    let at = phone
        .driver
        .effects
        .iter()
        .position(|request| {
            request.instance == page
                && matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(wire::effect::Kind::OwnerCheck(_))
                )
        })
        .expect("the words page asks the owner check");
    let asked = phone.driver.effects.remove(at);
    phone.driver.effects.insert(0, asked);
    phone
        .driver
        .answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                biometry: wire::Biometry::Face as i32,
                outcome: wire::owner_checked::Outcome::Succeeded as i32,
            },
        ));
    phone.driver.serve(&mut phone.shell);
    let Some(wire::view_state::Kind::WordsShow(state)) = &phone.driver.view(page).kind else {
        panic!("not words.show: {:?}", phone.driver.view(page).kind);
    };
    assert_eq!(state.phase, wire::words_show_state::Phase::Show as i32);
    assert!(state.secure);
    assert_eq!(state.words.len(), 24);
    assert_eq!(state.words[0].word, "abandon");
    assert_eq!(state.words[23].word, "art");
}
