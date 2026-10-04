//! THE PHONE'S BACKUP PLANE, THROUGH THE CORE'S OWN DOORS, AGAINST A REAL
//! GATEWAY (#1080, "The phone core").
//!
//! Every case here drives `Handle::call` — the arms `centraid_call` reaches —
//! against `centraid_gateway::server::harness`: the gateway a member runs,
//! TLS and SQLite and object files included, on `127.0.0.1:0`. Nothing below
//! the socket is faked, and nothing above the core's doors is assumed.
//!
//! | Case | What it proves |
//! |---|---|
//! | [`a_phone_pairs_backs_up_and_its_gateway_holds_only_ciphertext`] | pairing from the QR's text, the safety number both ends print, a pass that backs up the snapshot, owned bytes, a derivative and library items sealed in the stream, a status that agrees, and a gateway that holds no plaintext, no plaintext hash and no key |
//! | [`the_operating_system_moves_a_handed_off_part_and_settle_records_it`] | a metered pass that seals and holds back, a handoff whose `allows_cellular` follows the rule, an upload the test performs as the OS would, `settle` for success and failure, and `reconcile` |
//! | [`an_original_comes_back_by_name_and_a_safe_library_item_is_offered_whole`] | `fetch_original` landing, already held and not backed up; `releasable` offering only a whole, unedited, acknowledged library item; `released` forgetting it and announcing the change |
//! | [`a_restore_brings_every_vault_back_and_the_old_phone_freezes`] | the words and the payload alone bring the vault back, checked before the claim, with its derivatives; the old phone's next pass is refused `MOVED` and it reads frozen; the restored phone backs up again |
//! | [`a_head_set_between_the_check_and_the_claim_is_checked_before_it_is_claimed`] | #1047 L1 on the new plane: the claim names the head it checked, and a head the old phone set in that window is laid down and checked first |
//! | [`pairing_a_gateway_that_holds_the_vault_takes_it_over`] | `VAULT_KNOWN` at pairing is a takeover by claim, and the phone it supersedes freezes |
//! | [`a_machine_that_is_not_the_pinned_gateway_is_untrusted_and_a_damaged_copy_is_damaged`] | a flipped bit in the gateway's copy is `FETCH_OUTCOME_DAMAGED` and lands nothing; another machine at the gateway's address is `FETCH_OUTCOME_UNTRUSTED`, a pass that stops `DRAIN_STOP_UNTRUSTED`, and a status that waits `WAIT_REASON_UNTRUSTED` |
//! | [`a_library_item_larger_than_the_spool_backs_up_a_window_at_a_time`] | R-1080-C39: a film twice the spool, hashed on its first read and sealed a window per later read under names known before each; a pass that moved a window asks for the next; an edit between reads keeps nothing; the spool never holds more than its ceiling |
//! | [`forgetting_a_gateway_revokes_this_phones_token_there`] | `forget_destination` revokes the phone's token on the gateway first, and a gateway that cannot be reached is forgotten anyway and says it was not revoked |

use std::path::{Path, PathBuf};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_gateway::server::harness::{self, Spawned};

/// The BIP-39 test vector: the whole input to a restore.
const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";

fn seed() -> centraid_core::Seed {
    centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed()
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime")
}

/// A gateway on its own runtime, kept alive for the test.
struct Gateway {
    runtime: tokio::runtime::Runtime,
    _dir: tempfile::TempDir,
    spawned: Spawned,
}

fn gateway() -> Gateway {
    let runtime = runtime();
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
        self.spawned.payload().to_json()
    }

    /// Every file under the gateway's data directory, read whole.
    fn files(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in std::fs::read_dir(dir).expect("lists") {
                let path = entry.expect("an entry").path();
                if path.is_dir() {
                    walk(&path, out);
                } else if let Ok(bytes) = std::fs::read(&path) {
                    out.push((path, bytes));
                }
            }
        }
        let mut out = Vec::new();
        walk(self.spawned.data_dir(), &mut out);
        out
    }
}

/// A founded phone holding the vault's keys and its content store.
fn phone(dir: &Path) -> Handle {
    phone_with(dir, |config| config)
}

/// [`phone`], opened with a configuration of the test's own.
fn phone_with(dir: &Path, configure: impl FnOnce(CoreConfig) -> CoreConfig) -> Handle {
    std::fs::create_dir_all(dir).expect("a directory");
    let handle = Core::open(configure(
        CoreConfig::new(dir.join("vault.db")).with_seed(seed(), 0),
    ))
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
    handle
        .open_own_bytes(dir.join("vault.bytes"))
        .expect("the store opens");
    handle
}

fn ask(handle: &Handle, kind: wire::request::Kind) -> wire::response::Kind {
    handle
        .call(&wire::Request {
            kind: Some(kind.clone()),
        })
        .unwrap_or_else(|error| panic!("{kind:?} was refused: {error}"))
        .kind
        .expect("an answer has a kind")
}

fn pair(handle: &Handle, gateway: &Gateway) -> wire::PairResponse {
    let wire::response::Kind::PairPhone(paired) = ask(
        handle,
        wire::request::Kind::PairPhone(wire::PairRequest {
            payload: gateway.payload(),
        }),
    ) else {
        panic!("a pairing answers");
    };
    paired
}

/// Bytes nobody else has: a label's hash, stretched.
fn bytes_of(label: &str, size: usize) -> Vec<u8> {
    let mut reader = blake3::Hasher::new()
        .update(label.as_bytes())
        .finalize_xof();
    let mut out = vec![0_u8; size];
    reader.fill(&mut out);
    out
}

fn stage(handle: &Handle, begin: wire::StageBegin, bytes: &[u8]) -> wire::StageHandle {
    let send = |kind: wire::stage_request::Kind| {
        let wire::response::Kind::Stage(answer) = ask(
            handle,
            wire::request::Kind::Stage(wire::StageRequest { kind: Some(kind) }),
        ) else {
            panic!("a stage frame answers");
        };
        answer.kind.expect("a stage answer has a kind")
    };
    let wire::stage_response::Kind::Begun(begun) = send(wire::stage_request::Kind::Begin(begin))
    else {
        panic!("begun");
    };
    let ceiling = usize::try_from(begun.chunk_bytes).expect("fits");
    for (seq, window) in bytes.chunks(ceiling).enumerate() {
        send(wire::stage_request::Kind::Chunk(wire::StageChunk {
            staging_id: begun.staging_id.clone(),
            seq: seq as u64,
            payload: window.to_vec(),
        }));
    }
    let wire::stage_response::Kind::Handle(staged) =
        send(wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }))
    else {
        panic!("a handle");
    };
    staged
}

fn owned(media_type: &str, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        media_type: media_type.to_owned(),
        byte_size: bytes.len() as u64,
        source: wire::StageSource::Owned as i32,
        ..wire::StageBegin::default()
    }
}

/// A library item's begin. Its length is "not known" (0) half the time, as
/// the library answers it.
fn library(media_type: &str, os_ref: &str, bytes: &[u8], edited: bool) -> wire::StageBegin {
    wire::StageBegin {
        media_type: media_type.to_owned(),
        byte_size: if bytes.len().is_multiple_of(2) {
            0
        } else {
            bytes.len() as u64
        },
        source: wire::StageSource::OsLibrary as i32,
        os_ref: os_ref.to_owned(),
        os_edited: edited,
        ..wire::StageBegin::default()
    }
}

fn thumb_of(parent: &wire::StageHandle, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        for_hash: hex::decode(&parent.content_hash).expect("hex"),
        tier: "thumb".to_owned(),
        ..owned("image/jpeg", bytes)
    }
}

/// `media.add_asset` over staged bytes; answers the asset id.
fn add_asset(handle: &Handle, staged: &wire::StageHandle, kind: &str) -> String {
    let wire::response::Kind::Command(outcome) = ask(
        handle,
        wire::request::Kind::Command(wire::Command {
            name: "media.add_asset".to_owned(),
            input: serde_json::to_vec(&serde_json::json!({
                "staged_sha": staged.content_hash,
                "kind": kind,
            }))
            .expect("json"),
            invoke_key: format!("media.add_asset:{}", staged.content_hash),
            ..wire::Command::default()
        }),
    ) else {
        panic!("a command answers");
    };
    assert_eq!(
        outcome.status,
        wire::CommandStatus::Executed as i32,
        "{}",
        outcome.reason
    );
    let output: serde_json::Value = serde_json::from_slice(&outcome.output).expect("json");
    output["asset_id"].as_str().expect("an asset id").to_owned()
}

fn drain(handle: &Handle, request: wire::DrainRequest) -> wire::DrainResponse {
    let wire::response::Kind::Drain(drained) = ask(handle, wire::request::Kind::Drain(request))
    else {
        panic!("a drain answers");
    };
    drained
}

/// A pass at home, on a charger, that the member asked for.
fn at_home() -> wire::DrainRequest {
    wire::DrainRequest {
        deadline_ms: 0,
        rule: wire::TransferRule::WifiOnly as i32,
        metered: false,
        charging: true,
        wants_snapshot: true,
        exclude_videos: false,
        asked: false,
    }
}

fn status(handle: &Handle) -> wire::BackupStatusResponse {
    let wire::response::Kind::BackupStatus(status) = ask(
        handle,
        wire::request::Kind::BackupStatus(wire::BackupStatusRequest {}),
    ) else {
        panic!("a status answers");
    };
    status
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn a_phone_pairs_backs_up_and_its_gateway_holds_only_ciphertext() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());

    let paired = pair(&phone, &gateway);
    let identity = centraid_identity::derive::restore_vault_keys(&seed(), 0)
        .expect("derives")
        .identity
        .public();
    assert_eq!(
        paired.safety_number,
        centraid_identity::safety_number_of_bytes(
            identity.as_bytes(),
            gateway.spawned.pin.as_bytes()
        )
        .grouped(),
        "the phone shows the digits the gateway prints"
    );
    let destination = paired.destination.expect("the gateway this pairing added");
    assert_eq!(destination.gateway_id, gateway.spawned.gateway_id.hex());
    assert_eq!(
        destination.cert_der, gateway.spawned.cert_der,
        "pinned by its exact bytes"
    );
    assert_eq!(destination.label, "127.0.0.1");

    let photo = bytes_of("a photograph the app holds", 200_000);
    let thumb = bytes_of("its thumbnail", 6_000);
    let still = bytes_of("a photograph the library holds", 150_000);
    let film = bytes_of("a film the library holds", 300_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb_handle = stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    add_asset(&phone, &photo_handle, "photo");
    let still_handle = stage(
        &phone,
        library("image/heic", "lib-still", &still, false),
        &still,
    );
    assert!(!still_handle.already_held);
    add_asset(&phone, &still_handle, "photo");
    let film_handle = stage(
        &phone,
        library("video/mp4", "lib-film", &film, false),
        &film,
    );
    add_asset(&phone, &film_handle, "video");
    // THE LIBRARY'S BYTES ARE NOT COPIED INTO THE APP (#1080 ruling 6).
    let door = phone.bytes().expect("a door");
    for kept_out in [&still_handle, &film_handle] {
        assert!(
            !door
                .store()
                .is_complete(
                    centraid_blobs::ContentHash::parse_hex(&kept_out.content_hash).expect("hex")
                )
                .expect("answers")
        );
    }
    // AND STAGED AGAIN, IT IS HELD.
    let again = stage(
        &phone,
        library("image/heic", "lib-still", &still, false),
        &still,
    );
    assert!(again.already_held, "a re-scanned roll is not sent again");

    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
    assert!(drained.confirmed_parts >= 6, "{drained:?}");
    assert!(drained.acked_at_ms.is_some(), "the head moved in this pass");
    assert_eq!(drained.pending_bytes, 0);
    assert!(
        drained.need_bytes.is_empty(),
        "the stage door sealed the library items"
    );

    let backed = status(&phone);
    assert_eq!(backed.destinations.len(), 1);
    assert_eq!(
        backed.content_total, 4,
        "two originals of the app's, two of the library's... {backed:?}"
    );
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert!(backed.waiting.is_empty(), "{backed:?}");
    assert!(backed.last_snapshot_ms.is_some() && backed.acked_at_ms.is_some());
    assert_eq!(backed.spool_bytes, 0);
    assert!(!backed.frozen);

    // A SECOND PASS WITH NOTHING NEW sends nothing and moves no head.
    let idle = drain(
        &phone,
        wire::DrainRequest {
            wants_snapshot: false,
            ..at_home()
        },
    );
    assert_eq!(idle.confirmed_parts, 0, "{idle:?}");
    assert!(idle.acked_at_ms.is_none());

    // THE CANARY (#1080 invariant): no plaintext, no plaintext hash and no
    // key reaches the gateway's directory.
    let keys = centraid_core::phone::Keyring::derive(&seed(), 0).expect("keys");
    let files = gateway.files();
    assert!(files.len() > 4, "the gateway holds objects");
    for (label, plaintext) in [
        ("photo", &photo),
        ("thumb", &thumb),
        ("still", &still),
        ("film", &film),
    ] {
        let middle = &plaintext[plaintext.len() / 2..plaintext.len() / 2 + 64];
        let hash = blake3::hash(plaintext);
        for (path, held) in &files {
            assert!(
                !contains(held, middle),
                "{label}'s bytes are in {}",
                path.display()
            );
            assert!(
                !contains(held, hash.as_bytes()),
                "{label}'s hash is in {}",
                path.display()
            );
            assert!(
                !contains(held, hash.to_hex().as_bytes()),
                "{label}'s hash, in hex, is in {}",
                path.display()
            );
        }
    }
    for (path, held) in &files {
        for key in [
            keys.backup.k_backup(),
            keys.backup.k_name(),
            keys.vault.root.as_bytes(),
        ] {
            assert!(!contains(held, key), "a key is in {}", path.display());
        }
    }
    let _ = thumb_handle;
}

#[test]
fn the_operating_system_moves_a_handed_off_part_and_settle_records_it() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let photo = bytes_of("a photograph on a train", 120_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("its thumbnail on a train", 4_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    add_asset(&phone, &photo_handle, "photo");

    // ON CELLULAR, UNDER WI-FI ONLY: the thumbnail crosses, the original is
    // sealed and held back, and the records wait.
    let metered = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            charging: false,
            wants_snapshot: false,
            ..at_home()
        },
    );
    assert_eq!(
        metered.stopped,
        wire::DrainStop::Empty as i32,
        "{metered:?}"
    );
    assert_eq!(
        metered.confirmed_parts, 1,
        "the thumbnail alone: {metered:?}"
    );
    assert!(metered.pending_bytes > 0, "the original waits in the spool");
    let waiting = status(&phone);
    assert!(
        waiting
            .waiting
            .iter()
            .any(|row| row.reason == wire::WaitReason::Wifi as i32 && row.count == 1),
        "{waiting:?}"
    );

    let wire::response::Kind::Handoff(batch) = ask(
        &phone,
        wire::request::Kind::Handoff(wire::HandoffRequest {
            max_bytes: 64 << 20,
            max_parts: 16,
        }),
    ) else {
        panic!("a handoff answers");
    };
    assert_eq!(batch.parts.len(), 1, "{batch:?}");
    let part = &batch.parts[0];
    assert!(
        !part.allows_cellular,
        "a photograph's original under Wi-Fi only"
    );
    let keys = centraid_core::phone::Keyring::derive(&seed(), 0).expect("keys");
    assert_eq!(part.vault_id, keys.vault_hex());
    assert!(
        part.url
            .ends_with(&format!("/v2/v/{}/o/{}", part.vault_id, part.name)),
        "{}",
        part.url
    );
    assert_eq!(part.method, "PUT");
    assert!(
        Path::new(&part.path).is_file(),
        "the OS reads the spool file in place"
    );
    let header = |name: &str| {
        part.headers
            .iter()
            .find(|header| header.name == name)
            .map(|header| header.value.clone())
            .unwrap_or_else(|| panic!("no {name} header"))
    };
    // HANDED OFF ONCE: a second batch does not repeat it.
    let wire::response::Kind::Handoff(empty) = ask(
        &phone,
        wire::request::Kind::Handoff(wire::HandoffRequest {
            max_bytes: 64 << 20,
            max_parts: 16,
        }),
    ) else {
        panic!("a handoff answers");
    };
    assert!(empty.parts.is_empty());

    // THE OS UPLOADS IT, as a background session would: the file, the URL's
    // name, the headers as handed.
    let token: centraid_gateway::rules::ids::Token = header("authorization")
        .strip_prefix("Bearer ")
        .expect("a bearer token")
        .parse()
        .expect("a token");
    let digest = centraid_gateway::rules::ids::Digest::from_header(&header("content-digest"))
        .expect("a digest");
    let client = gateway.spawned.client(token);
    let vault = centraid_gateway::rules::ids::VaultId::from_bytes(
        hex::decode(&part.vault_id)
            .expect("hex")
            .try_into()
            .expect("32 bytes"),
    );
    let name: centraid_gateway::rules::ids::Name = part.name.parse().expect("a name");
    gateway
        .runtime
        .block_on(client.put_file(&vault, &name, &digest, Path::new(&part.path)))
        .expect("the gateway takes it");

    let settle = |settled: Vec<wire::Settled>| {
        let wire::response::Kind::Settle(answer) = ask(
            &phone,
            wire::request::Kind::Settle(wire::SettleRequest { settled }),
        ) else {
            panic!("a settle answers");
        };
        answer
    };
    let outcome = settle(vec![
        wire::Settled {
            name: part.name.clone(),
            http_status: 201,
            error: String::new(),
            gateway_id: part.gateway_id.clone(),
            vault_id: part.vault_id.clone(),
        },
        // A NAME THE LEDGER DOES NOT HOLD, and a part for another vault, are
        // ignored and not counted (A6).
        wire::Settled {
            name: "cd".repeat(32),
            http_status: 201,
            gateway_id: part.gateway_id.clone(),
            ..wire::Settled::default()
        },
        wire::Settled {
            name: part.name.clone(),
            http_status: 201,
            gateway_id: part.gateway_id.clone(),
            vault_id: "ef".repeat(32),
            ..wire::Settled::default()
        },
    ]);
    assert_eq!((outcome.confirmed, outcome.requeued), (1, 0));
    assert!(
        !Path::new(&part.path).exists(),
        "an acknowledged part leaves the spool"
    );

    // A FAILED UPLOAD GOES BACK IN THE QUEUE, and is handed off again.
    let second = bytes_of("a second photograph on the train", 90_000);
    let second_handle = stage(&phone, owned("image/heic", &second), &second);
    add_asset(&phone, &second_handle, "photo");
    drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            wants_snapshot: false,
            ..at_home()
        },
    );
    let wire::response::Kind::Handoff(retry) = ask(
        &phone,
        wire::request::Kind::Handoff(wire::HandoffRequest {
            max_bytes: 64 << 20,
            max_parts: 16,
        }),
    ) else {
        panic!("a handoff answers");
    };
    assert_eq!(retry.parts.len(), 1);
    let failed = settle(vec![wire::Settled {
        name: retry.parts[0].name.clone(),
        http_status: 0,
        error: "TRANSPORT_-1001".to_owned(),
        gateway_id: retry.parts[0].gateway_id.clone(),
        vault_id: retry.parts[0].vault_id.clone(),
    }]);
    assert_eq!((failed.confirmed, failed.requeued), (0, 1));
    let wire::response::Kind::Handoff(again) = ask(
        &phone,
        wire::request::Kind::Handoff(wire::HandoffRequest {
            max_bytes: 64 << 20,
            max_parts: 16,
        }),
    ) else {
        panic!("a handoff answers");
    };
    assert_eq!(again.parts.len(), 1, "a requeued part is handed off again");

    // RECONCILE: the gateway answers, and the ledger agrees with it.
    let wire::response::Kind::Reconcile(reconciled) = ask(
        &phone,
        wire::request::Kind::Reconcile(wire::ReconcileRequest {}),
    ) else {
        panic!("a reconcile answers");
    };
    assert!(reconciled.reachable);
    let wire::response::Kind::Pins(pins) =
        ask(&phone, wire::request::Kind::Pins(wire::PinsRequest {}))
    else {
        panic!("pins answer");
    };
    assert_eq!(pins.destinations.len(), 1);
    assert_eq!(pins.destinations[0].cert_der, gateway.spawned.cert_der);
}

#[test]
fn an_original_comes_back_by_name_and_a_safe_library_item_is_offered_whole() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let photo = bytes_of("an original that will be lost", 250_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    let still = bytes_of("a library photograph", 80_000);
    let still_handle = stage(
        &phone,
        library("image/heic", "lib-safe", &still, false),
        &still,
    );
    add_asset(&phone, &still_handle, "photo");
    let edited = bytes_of("a library photograph the member edited", 70_000);
    let edited_handle = stage(
        &phone,
        library("image/heic", "lib-edited", &edited, true),
        &edited,
    );
    add_asset(&phone, &edited_handle, "photo");
    // A LIVE PHOTO: a still and a film under one identifier.
    let live_still = bytes_of("a live photo's still", 60_000);
    let live_still_handle = stage(
        &phone,
        library("image/heic", "lib-live", &live_still, false),
        &live_still,
    );
    add_asset(&phone, &live_still_handle, "photo");
    drain(&phone, at_home());
    // ITS FILM ARRIVES AFTER THE PASS, so it is not backed up yet.
    let live_film = bytes_of("a live photo's film", 90_000);
    let live_film_handle = stage(
        &phone,
        library("video/quicktime", "lib-live#pairedVideo", &live_film, false),
        &live_film,
    );
    add_asset(&phone, &live_film_handle, "video");

    // FETCH ORIGINAL: the store's copy goes, and comes back by name.
    let door = phone.bytes().expect("a door");
    let photo_hash =
        centraid_blobs::ContentHash::parse_hex(&photo_handle.content_hash).expect("hex");
    assert!(door.store().remove(photo_hash).expect("removes"));
    let fetch = |handle: &wire::StageHandle| {
        let wire::response::Kind::FetchOriginal(fetched) = ask(
            &phone,
            wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
                content_hash: hex::decode(&handle.content_hash).expect("hex"),
            }),
        ) else {
            panic!("a fetch answers");
        };
        fetched
    };
    let landed = fetch(&photo_handle);
    assert_eq!(landed.outcome, wire::FetchOutcome::Landed as i32);
    assert_eq!(
        std::fs::read(&landed.path).expect("reads"),
        photo,
        "byte for byte"
    );
    // THE LIGHTBOX IS TOLD: the change event names the asset's table.
    let mut told = false;
    while let Some(event) = phone.next_event(Duration::from_millis(50)).expect("events") {
        if let Some(wire::event::Kind::Change(change)) = event.kind
            && change.table == "media_asset"
        {
            told = true;
        }
    }
    assert!(told, "a landed original is announced");
    assert_eq!(
        fetch(&photo_handle).outcome,
        wire::FetchOutcome::AlreadyHeld as i32
    );
    let in_library = fetch(&still_handle);
    assert_eq!(in_library.outcome, wire::FetchOutcome::AlreadyHeld as i32);
    assert!(
        in_library.path.is_empty(),
        "the library's own item is the shell's to open"
    );
    // A FILE NO GATEWAY HOLDS is not in the backup, and says so.
    let fresh = bytes_of("taken after the last pass", 40_000);
    let fresh_handle = stage(&phone, owned("image/heic", &fresh), &fresh);
    add_asset(&phone, &fresh_handle, "photo");
    assert!(
        door.store()
            .remove(
                centraid_blobs::ContentHash::parse_hex(&fresh_handle.content_hash).expect("hex")
            )
            .expect("removes")
    );
    assert_eq!(
        fetch(&fresh_handle).outcome,
        wire::FetchOutcome::NotInBackup as i32
    );

    // RELEASABLE (A19, A20): the safe library item only — not the edited one,
    // and not the live photo whose film is not backed up.
    let releasable = || {
        let wire::response::Kind::Releasable(answer) = ask(
            &phone,
            wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 50 }),
        ) else {
            panic!("releasable answers");
        };
        answer
    };
    let offered = releasable();
    assert_eq!(offered.items.len(), 1, "{offered:?}");
    assert_eq!(offered.items[0].os_ref, "lib-safe");
    assert_eq!(offered.items[0].size, still.len() as u64);
    assert_eq!(offered.total_bytes, still.len() as u64);
    assert_eq!(
        hex::encode(&offered.items[0].content_hash),
        still_handle.content_hash
    );
    // THE FILM BACKED UP, the live photo is offered whole: both hashes.
    drain(&phone, at_home());
    let whole = releasable();
    let live: Vec<&wire::Releasable> = whole
        .items
        .iter()
        .filter(|item| item.os_ref.starts_with("lib-live"))
        .collect();
    assert_eq!(live.len(), 2, "a live photo is offered whole: {whole:?}");
    // iOS NAMES THE FILM `<identifier>#pairedVideo`: one item, two refs, and
    // the core groups by the identifier, so neither half is offered alone.
    assert!(live.iter().any(|item| item.os_ref == "lib-live"));
    assert!(
        live.iter()
            .any(|item| item.os_ref == "lib-live#pairedVideo")
    );
    assert!(whole.items.iter().all(|item| item.os_ref != "lib-edited"));

    // RELEASED: the member deleted it from the library.
    while phone
        .next_event(Duration::from_millis(10))
        .expect("events")
        .is_some()
    {}
    let wire::response::Kind::Released(released) = ask(
        &phone,
        wire::request::Kind::Released(wire::ReleasedRequest {
            content_hash: vec![hex::decode(&still_handle.content_hash).expect("hex")],
        }),
    ) else {
        panic!("released answers");
    };
    assert_eq!(released.recorded, 1);
    let mut announced = false;
    while let Some(event) = phone.next_event(Duration::from_millis(50)).expect("events") {
        if let Some(wire::event::Kind::Change(change)) = event.kind
            && change.table == "media_asset"
            && !change.pk_set.is_empty()
        {
            announced = true;
        }
    }
    assert!(announced, "the grid is told the item is fetchable now");
    assert!(
        releasable()
            .items
            .iter()
            .all(|item| item.os_ref != "lib-safe")
    );
    assert_eq!(
        fetch(&still_handle).outcome,
        wire::FetchOutcome::Landed as i32,
        "and it comes back from the gateway"
    );
}

/// **R-1080-C39: A LIBRARY ITEM LARGER THAN THE SPOOL BACKS UP A WINDOW AT A
/// TIME.** The spool holds one part; the film is two. Its first read only
/// hashes it, and every later read seals the parts its pass planned, under
/// names known before the read began. A pass that moved one window asks for
/// the next before it answers, an edit in the library between two reads keeps
/// nothing, and the spool never holds more than its ceiling.
#[test]
fn a_library_item_larger_than_the_spool_backs_up_a_window_at_a_time() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let part = centraid_media::sealed::PART_BYTES;
    let phone = phone_with(dir.path(), |config| config.with_spool_ceiling(part));
    pair(&phone, &gateway);
    let spool = dir.path().join("vault.spool");
    // The sealed parts the spool holds; a part is its plaintext plus a
    // header and a tag per 4 MiB, never 64 KiB more.
    let spooled = || -> u64 {
        std::fs::read_dir(&spool)
            .expect("lists")
            .map(|entry| entry.expect("an entry"))
            .filter(|entry| entry.file_name().len() == 64)
            .map(|entry| entry.metadata().expect("measures").len())
            .sum()
    };
    let ceiling = part + 64 * 1024;

    let film = bytes_of(
        "a film twice the spool",
        usize::try_from(part).expect("fits") + 4_096,
    );
    let begin = || wire::StageBegin {
        media_type: "video/quicktime".to_owned(),
        byte_size: film.len() as u64,
        source: wire::StageSource::OsLibrary as i32,
        os_ref: "lib-film".to_owned(),
        ..wire::StageBegin::default()
    };
    // THE FIRST READ ONLY HASHES IT: two parts cannot wait in a spool of one.
    let staged = stage(&phone, begin(), &film);
    add_asset(&phone, &staged, "video");
    assert_eq!(spooled(), 0, "nothing sealed that could not be kept");

    // THE SHELL'S HALF, as `LibraryFeed` does it: stream what a pass asks for.
    let mut feeds = 0;
    let mut answers = Vec::new();
    loop {
        let answer = drain(&phone, at_home());
        assert!(spooled() <= ceiling, "{} bytes spooled", spooled());
        answers.push((answer.need_bytes.len(), answer.confirmed_parts));
        if answer.need_bytes.is_empty() {
            break;
        }
        assert!(
            answers.len() < 8,
            "two windows take a few passes: {answers:?}"
        );
        for need in &answer.need_bytes {
            assert_eq!(need.os_ref, "lib-film");
            assert_eq!(hex::encode(&need.content_hash), staged.content_hash);
            assert_eq!(need.size, film.len() as u64);
            feeds += 1;
            if feeds == 1 {
                // EDITED IN THE LIBRARY BETWEEN TWO READS, past the window:
                // the whole is another file, so the window is not kept.
                let mut edited = film.clone();
                edited[film.len() - 1] ^= 1;
                let other = stage(&phone, begin(), &edited);
                assert_ne!(other.content_hash, staged.content_hash);
                assert_eq!(
                    spooled(),
                    0,
                    "an edited item lends no part to the old names"
                );
                continue;
            }
            let again = stage(&phone, begin(), &film);
            assert_eq!(again.content_hash, staged.content_hash);
            assert!(spooled() <= ceiling, "{} bytes spooled", spooled());
            assert!(spooled() > 0, "the window was sealed");
        }
    }
    assert_eq!(
        feeds, 3,
        "an edited read, then one read per window: {answers:?}"
    );
    // A PASS THAT MOVED A WINDOW ASKED FOR THE NEXT ONE BEFORE IT ANSWERED.
    assert!(
        answers
            .iter()
            .any(|(asked, confirmed)| *asked == 1 && *confirmed > 0),
        "{answers:?}"
    );
    // BOTH PARTS ARE AT THE GATEWAY: the film counts as backed up.
    let backed = status(&phone);
    assert!(backed.content_total >= 1, "{backed:?}");
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    // AND IT IS NOT OFFERED FOR FREEING: the read that came back edited is
    // what the library holds under its identifier now, and no gateway has
    // that version (the root's ruling A20).
    let wire::response::Kind::Releasable(offered) = ask(
        &phone,
        wire::request::Kind::Releasable(wire::ReleasableRequest { limit: 10 }),
    ) else {
        panic!("releasable answers");
    };
    assert!(
        offered.items.iter().all(|item| item.os_ref != "lib-film"),
        "{offered:?}"
    );
    assert_eq!(spooled(), 0, "the spool is empty once both moved");
}

/// What a vault is, for comparing two of them through the vault's own
/// doors: its id, and every file its rows name — each content item and each
/// derivative, by hash, length and tier. A note's body is a content item, so
/// a note the restore missed is a difference here.
/// One file a vault's rows name: its hash, its length and its tier.
type Named = (String, u64, Option<String>);

fn census(path: &Path) -> (Option<String>, Vec<Named>) {
    let vault = centraid_vault::Vault::open(path).expect("opens");
    let id = vault.vault_id().expect("reads");
    let mut files: Vec<Named> = centraid_vault::backup::files::content_files(&vault)
        .expect("reads")
        .into_iter()
        .map(|file| (file.h.to_hex(), file.len, file.variant))
        .collect();
    files.sort();
    vault.close().expect("closes");
    (id, files)
}

fn restore(dir: &Path, gateway: &Gateway) -> wire::RestoreResponse {
    std::fs::create_dir_all(dir).expect("a directory");
    let shelf = Core::open(CoreConfig::new(dir.join("custody.db")).opening_existing())
        .expect("a core with no vault opens");
    assert!(!shelf.holds_a_replica());
    let wire::response::Kind::Restore(restored) = ask(
        &shelf,
        wire::request::Kind::Restore(wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: gateway.payload(),
            ..wire::RestoreRequest::default()
        }),
    ) else {
        panic!("a restore answers");
    };
    restored
}

#[test]
fn a_restore_brings_every_vault_back_and_the_old_phone_freezes() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    let photo = bytes_of("a photograph from before the phone was lost", 100_000);
    let photo_handle = stage(&old, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("the grid's picture of it", 5_000);
    let thumb_handle = stage(&old, thumb_of(&photo_handle, &thumb), &thumb);
    add_asset(&old, &photo_handle, "photo");
    drain(&old, at_home());
    let lost = census(&old_dir.path().join("vault.db"));

    let new_dir = tempfile::tempdir().expect("a directory");
    let restored = restore(new_dir.path(), &gateway);
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    assert!(restored.unclaimed.is_empty());
    assert_eq!(restored.gap_scanned, centraid_core::phone::restore::GAP);
    let vault = &restored.vaults[0];
    assert_eq!(vault.index, 0);
    assert!(vault.rows > 0);
    let keys = centraid_core::phone::Keyring::derive(&seed(), 0).expect("keys");
    assert_eq!(vault.vault_id, keys.vault_hex());
    assert_eq!(
        vault.safety_number,
        centraid_identity::safety_number_of_bytes(
            keys.vault.identity.public().as_bytes(),
            gateway.spawned.pin.as_bytes()
        )
        .grouped()
    );
    let path = PathBuf::from(&vault.path);
    assert_eq!(census(&path), lost, "the rows came back");
    // THE GRID IS WHOLE: the derivative came back; the original waits.
    let bytes = centraid_blobs::ByteStore::open(path.with_extension("bytes")).expect("opens");
    let thumb_hash =
        centraid_blobs::ContentHash::parse_hex(&thumb_handle.content_hash).expect("hex");
    assert_eq!(
        bytes.read(thumb_hash).expect("the thumbnail is here"),
        thumb
    );
    assert!(
        !bytes
            .is_complete(
                centraid_blobs::ContentHash::parse_hex(&photo_handle.content_hash).expect("hex")
            )
            .expect("answers"),
        "originals are fetched by the rule or a tap"
    );

    // THE OLD PHONE'S NEXT PASS IS REFUSED, AND IT READS FROZEN.
    let note = old.call(&wire::Request {
        kind: Some(wire::request::Kind::Command(wire::Command {
            name: "knowledge.create_note".to_owned(),
            input: serde_json::to_vec(&serde_json::json!({
                "title": "after", "body_text": "written on the lost phone", "format": "plain"
            }))
            .expect("json"),
            invoke_key: "after-the-restore".to_owned(),
            ..wire::Command::default()
        })),
    });
    assert!(note.is_ok(), "the old phone still writes its own vault");
    let refused = old
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(at_home())),
        })
        .expect_err("a superseded phone's pass is refused");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert!(status(&old).frozen);
    let again = old
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(at_home())),
        })
        .expect_err("and stays refused");
    assert_eq!(again.code(), wire::ErrorCode::VaultMoved);

    // THE RESTORED PHONE BACKS UP AGAIN, continuing the head it restored.
    let restored_phone = Core::open(CoreConfig::new(&path).with_seed(seed(), 0)).expect("opens");
    restored_phone
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the store opens");
    assert!(status(&restored_phone).destinations.len() == 1);
    let next = drain(&restored_phone, at_home());
    assert_eq!(next.stopped, wire::DrainStop::Empty as i32, "{next:?}");
    assert!(
        next.acked_at_ms.is_some(),
        "the head moved from the restored one"
    );
}

#[test]
fn a_head_set_between_the_check_and_the_claim_is_checked_before_it_is_claimed() {
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old = phone(old_dir.path());
    pair(&old, &gateway);
    drain(&old, at_home());

    let new_dir = tempfile::tempdir().expect("a directory");
    let runtime = runtime();
    let mut moved_once = false;
    let restored = centraid_core::phone::restore::run_observed(
        &new_dir.path().join("custody.db"),
        &wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: gateway.payload(),
            ..wire::RestoreRequest::default()
        },
        runtime.handle(),
        &mut |_| {
            if !moved_once {
                moved_once = true;
                // THE OLD PHONE BACKS UP IN THE WINDOW: a note, a snapshot.
                ask(
                    &old,
                    wire::request::Kind::Command(wire::Command {
                        name: "knowledge.create_note".to_owned(),
                        input: serde_json::to_vec(&serde_json::json!({
                            "title": "in the window", "body_text": "between check and claim",
                            "format": "plain"
                        }))
                        .expect("json"),
                        invoke_key: "in-the-window".to_owned(),
                        ..wire::Command::default()
                    }),
                );
                std::thread::sleep(Duration::from_millis(5));
                let moved = drain(&old, at_home());
                assert!(moved.acked_at_ms.is_some(), "the old phone set a new head");
            }
        },
    )
    .expect("restores");
    assert_eq!(restored.vaults.len(), 1);
    let path = PathBuf::from(&restored.vaults[0].path);
    assert_eq!(
        census(&path),
        census(&old_dir.path().join("vault.db")),
        "the vault restored is the head the old phone set in the window, checked"
    );
}

#[test]
fn pairing_a_gateway_that_holds_the_vault_takes_it_over() {
    let gateway = gateway();
    let first_dir = tempfile::tempdir().expect("a directory");
    let first = phone(first_dir.path());
    pair(&first, &gateway);
    drain(&first, at_home());

    // THE SAME VAULT'S KEYS ON ANOTHER FILE: a phone whose ledger was lost.
    let second_dir = tempfile::tempdir().expect("a directory");
    let second = phone(second_dir.path());
    let paired = pair(&second, &gateway);
    assert!(!paired.safety_number.is_empty());
    let refused = first
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(at_home())),
        })
        .expect_err("the superseded phone is refused");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved);
    let drained = drain(&second, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Empty as i32,
        "{drained:?}"
    );
}

/// How many tokens the gateway holds, for every vault it knows.
fn tokens(gateway: &Gateway) -> usize {
    gateway
        .spawned
        .shared()
        .rules(|rules| rules.pairings())
        .expect("the gateway lists its pairings")
        .iter()
        .map(|pairing| pairing.tokens.len())
        .sum()
}

fn forget(handle: &Handle, gateway_id: &str) -> wire::ForgetDestinationResponse {
    let wire::response::Kind::ForgetDestination(forgot) = ask(
        handle,
        wire::request::Kind::ForgetDestination(wire::ForgetDestinationRequest {
            gateway_id: gateway_id.to_owned(),
        }),
    ) else {
        panic!("a forget answers");
    };
    forgot
}

#[test]
fn forgetting_a_gateway_revokes_this_phones_token_there() {
    let kept = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let handle = phone(dir.path());
    let id = pair(&handle, &kept)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&handle, at_home());
    assert_eq!(tokens(&kept), 1, "the pairing minted one token");

    let forgot = forget(&handle, &id);
    assert!(forgot.forgotten && forgot.revoked, "{forgot:?}");
    assert_eq!(tokens(&kept), 0, "the gateway forgot the token too");

    // A GATEWAY THAT IS GONE IS FORGOTTEN ANYWAY, and the answer says its
    // token was not revoked.
    let gone = gateway();
    let gone_id = pair(&handle, &gone)
        .destination
        .expect("a destination")
        .gateway_id;
    drop(gone);
    let forgot = forget(&handle, &gone_id);
    assert!(forgot.forgotten && !forgot.revoked, "{forgot:?}");
    let wire::response::Kind::Pins(pins) =
        ask(&handle, wire::request::Kind::Pins(wire::PinsRequest {}))
    else {
        panic!("pins answer");
    };
    assert!(pins.destinations.is_empty(), "{:?}", pins.destinations);
    assert!(
        !forget(&handle, &gone_id).forgotten,
        "a second forget finds nothing"
    );
}

/// The gateway's name for part `index` of the file `hash_hex`: what a test
/// needs to damage one object on purpose.
fn gateway_name(hash_hex: &str, index: u32) -> centraid_gateway::rules::ids::Name {
    let keyring = centraid_core::phone::Keyring::derive(&seed(), 0).expect("the keys derive");
    let h = centraid_vault::backup::naming::PlaintextHash::from_bytes(
        <[u8; 32]>::try_from(hex::decode(hash_hex).expect("hex")).expect("32 bytes"),
    );
    let name = centraid_vault::backup::naming::name(&keyring.backup, &h, index);
    centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes())
}

#[test]
fn a_machine_that_is_not_the_pinned_gateway_is_untrusted_and_a_damaged_copy_is_damaged() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let id = pair(&phone, &home)
        .destination
        .expect("a destination")
        .gateway_id;
    let photo = bytes_of("an original the gateway will damage", 250_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    drain(&phone, at_home());
    let door = phone.bytes().expect("a door");
    let hash = centraid_blobs::ContentHash::parse_hex(&photo_handle.content_hash).expect("hex");
    assert!(door.store().remove(hash).expect("removes"));
    let fetch = || {
        let wire::response::Kind::FetchOriginal(fetched) = ask(
            &phone,
            wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
                content_hash: hex::decode(&photo_handle.content_hash).expect("hex"),
            }),
        ) else {
            panic!("a fetch answers");
        };
        fetched
    };

    // DAMAGED: one bit flipped in the gateway's copy, which no scrub has
    // marked yet, so the gateway still serves it.
    let vault = centraid_core::phone::Keyring::derive(&seed(), 0)
        .expect("the keys derive")
        .vault_id();
    home.spawned
        .corrupt(&vault, &gateway_name(&photo_handle.content_hash, 0))
        .expect("a bit flips");
    let damaged = fetch();
    assert_eq!(
        damaged.outcome,
        wire::FetchOutcome::Damaged as i32,
        "{damaged:?}"
    );
    assert!(
        door.store().path_of(hash).expect("reads").is_none(),
        "nothing damaged lands"
    );

    // UNTRUSTED: another machine answers at the pinned gateway's address.
    let impostor = gateway();
    let ledger = centraid_vault::backup::ledger::Ledger::open(dir.path().join("vault.backup.db"))
        .expect("the ledger opens");
    let mut row = ledger
        .destination(&id)
        .expect("reads")
        .expect("the gateway is paired");
    row.addrs = vec![impostor.spawned.addr.to_string()];
    ledger.put_destination(&row).expect("writes");
    let untrusted = fetch();
    assert_eq!(
        untrusted.outcome,
        wire::FetchOutcome::Untrusted as i32,
        "{untrusted:?}"
    );
    let fresh = bytes_of("taken while another machine answers", 40_000);
    let fresh_handle = stage(&phone, owned("image/heic", &fresh), &fresh);
    add_asset(&phone, &fresh_handle, "photo");
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Untrusted as i32,
        "{drained:?}"
    );
    let status = status(&phone);
    assert!(
        status
            .waiting
            .iter()
            .any(|row| row.reason == wire::WaitReason::Untrusted as i32),
        "{status:?}"
    );
    assert_eq!(tokens(&impostor), 0, "nothing paired with the impostor");
}
