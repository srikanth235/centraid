//! **THE RESTORE DRILL, ACROSS THE REAL GATEWAY**
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080), Validation).
//!
//! `crates/vault/tests/restore_drill.rs` proves the snapshot plane against an
//! in-memory store: a vault backed up, its ledger and spool destroyed, and the
//! file brought back row for row. This drill proves the product: the phone's
//! core, through its own doors, against `centraid_gateway::server::harness` —
//! the gateway a member runs, TLS, SQLite and object files included, on
//! `127.0.0.1:0` — with nothing below the socket faked.
//!
//! One test, in the order a member lives it:
//!
//! 1. **A phone pairs and backs up a real library**: a JPEG the core derives
//!    its own thumbnail and preview from, a photograph and a film whose
//!    derivatives the shell staged, a photograph the operating system's
//!    library holds, and a film above 64 MiB, so one file is several parts.
//!    The pass runs to completion, every name every file implies is confirmed
//!    in the ledger AND held by the gateway (asked with `exists`), and the
//!    gateway's data directory holds no plaintext, no plaintext hash and no
//!    key (the canary, over real media).
//! 2. **Fifty more commits and a second snapshot**, so the head the restore
//!    finds is not the first one.
//! 3. **The phone is lost.** A new phone holds nothing — no vault, no ledger,
//!    no spool, no bytes — and restores from the 24 words and the gateway's
//!    pairing payload, claiming the vault at writer epoch 2 (the pairing was
//!    epoch 1).
//! 4. **It is the vault that was lost**: every row of every table equals the
//!    lost vault's, every derivative is back (fetched in bundles by the
//!    restore), and the 64 MiB-plus original fetched by name verifies against
//!    its hash.
//! 5. **The lost phone freezes**: its next pass is refused `VAULT_MOVED`.
//!
//! The lost phone is kept rather than deleted, because #1029 F1 is about a
//! phone that is still there; the destruction of a vault, its ledger and its
//! spool is the vault drill's half.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_gateway::server::harness::{self, Spawned};
use centraid_vault::backup::ledger::Ledger;
use centraid_vault::backup::naming::names_of;

/// The BIP-39 test vector: the whole input to a restore.
const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";

/// Above one 64 MiB part, so the file is two parts and is fetched as two.
const LARGE_FILM_BYTES: usize = 64 * 1024 * 1024 + 1024 * 1024 + 7;

fn seed() -> centraid_core::Seed {
    centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed()
}

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
        self.spawned.payload().to_json()
    }

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

fn ask(handle: &Handle, kind: wire::request::Kind) -> wire::response::Kind {
    handle
        .call(&wire::Request {
            kind: Some(kind.clone()),
        })
        .unwrap_or_else(|error| panic!("refused: {error}"))
        .kind
        .expect("an answer has a kind")
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

/// A real photograph: a JPEG the core's decoder reads and derives from.
fn jpeg() -> Vec<u8> {
    let picture = image::RgbImage::from_fn(640, 480, |x, y| {
        image::Rgb([
            u8::try_from(x % 256).expect("fits"),
            u8::try_from(y % 256).expect("fits"),
            u8::try_from((x + y) % 256).expect("fits"),
        ])
    });
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&picture)
        .expect("encodes");
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

fn library(media_type: &str, os_ref: &str, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        media_type: media_type.to_owned(),
        byte_size: bytes.len() as u64,
        source: wire::StageSource::OsLibrary as i32,
        os_ref: os_ref.to_owned(),
        ..wire::StageBegin::default()
    }
}

fn derivative(parent: &wire::StageHandle, tier: &str, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        for_hash: hex::decode(&parent.content_hash).expect("hex"),
        tier: tier.to_owned(),
        ..owned("image/jpeg", bytes)
    }
}

fn command(handle: &Handle, name: &str, input: &serde_json::Value, key: &str) -> serde_json::Value {
    let wire::response::Kind::Command(outcome) = ask(
        handle,
        wire::request::Kind::Command(wire::Command {
            name: name.to_owned(),
            input: serde_json::to_vec(input).expect("json"),
            invoke_key: key.to_owned(),
            ..wire::Command::default()
        }),
    ) else {
        panic!("a command answers");
    };
    assert_eq!(
        outcome.status,
        wire::CommandStatus::Executed as i32,
        "{name}: {}",
        outcome.reason
    );
    serde_json::from_slice(&outcome.output).expect("json")
}

fn add_asset(handle: &Handle, staged: &wire::StageHandle, kind: &str) {
    command(
        handle,
        "media.add_asset",
        &serde_json::json!({ "staged_sha": staged.content_hash, "kind": kind }),
        &format!("media.add_asset:{}", staged.content_hash),
    );
}

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

fn drain(handle: &Handle) -> wire::DrainResponse {
    let wire::response::Kind::Drain(drained) = ask(handle, wire::request::Kind::Drain(at_home()))
    else {
        panic!("a drain answers");
    };
    drained
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

/// Every row of every table, through the vault's own door.
fn dump(vault: &centraid_vault::Vault) -> BTreeMap<String, Vec<String>> {
    centraid_vault::backup::drill::dump(vault).expect("dumps")
}

/// Which of `needles` appear anywhere in `haystacks`. One pass per file over
/// a first-byte table, because the haystack is the whole gateway — a film
/// above 64 MiB included — and a naive window scan per needle is minutes.
fn found_in(haystacks: &[(PathBuf, Vec<u8>)], needles: &[(String, Vec<u8>)]) -> Vec<String> {
    let mut first = [false; 256];
    for (_, needle) in needles {
        first[usize::from(needle[0])] = true;
    }
    let mut found = BTreeSet::new();
    for (path, held) in haystacks {
        for (at, byte) in held.iter().enumerate() {
            if !first[usize::from(*byte)] {
                continue;
            }
            for (label, needle) in needles {
                if held[at..].starts_with(needle) {
                    found.insert(format!("{label} in {}", path.display()));
                }
            }
        }
    }
    found.into_iter().collect()
}

#[test]
fn lose_the_phone_restore_from_the_words_and_the_old_phone_freezes() {
    let started = std::time::Instant::now();
    let gateway = gateway();
    let old_dir = tempfile::tempdir().expect("a directory");
    let old_path = old_dir.path().join("vault.db");
    let old = Core::open(CoreConfig::new(&old_path).with_seed(seed(), 0)).expect("opens");
    old.with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("founds");
    old.open_own_bytes(old_dir.path().join("vault.bytes"))
        .expect("the store opens");
    let wire::response::Kind::PairPhone(paired) = ask(
        &old,
        wire::request::Kind::PairPhone(wire::PairRequest {
            payload: gateway.payload(),
        }),
    ) else {
        panic!("a pairing answers");
    };
    let gateway_id = paired.destination.expect("a destination").gateway_id;

    // ---- 1. A REAL LIBRARY, BACKED UP ------------------------------------
    let real = jpeg();
    let real_handle = stage(&old, owned("image/jpeg", &real), &real);
    add_asset(&old, &real_handle, "photo");
    let photo = bytes_of("a photograph the app holds", 2 * 1024 * 1024);
    let photo_handle = stage(&old, owned("image/heic", &photo), &photo);
    let photo_thumb = bytes_of("the photograph's thumbnail", 9_000);
    stage(
        &old,
        derivative(&photo_handle, "thumb", &photo_thumb),
        &photo_thumb,
    );
    let photo_preview = bytes_of("the photograph's preview", 180_000);
    stage(
        &old,
        derivative(&photo_handle, "preview", &photo_preview),
        &photo_preview,
    );
    add_asset(&old, &photo_handle, "photo");
    let still = bytes_of("a photograph the library holds", 300_000);
    let still_handle = stage(&old, library("image/heic", "lib-still", &still), &still);
    add_asset(&old, &still_handle, "photo");
    let film = bytes_of("a film above one part", LARGE_FILM_BYTES);
    let film_handle = stage(&old, owned("video/mp4", &film), &film);
    let poster = bytes_of("the film's poster", 12_000);
    stage(&old, derivative(&film_handle, "poster", &poster), &poster);
    add_asset(&old, &film_handle, "video");

    let first = drain(&old);
    assert_eq!(first.stopped, wire::DrainStop::Empty as i32, "{first:?}");
    assert!(first.acked_at_ms.is_some(), "the head moved: {first:?}");
    assert_eq!(first.pending_bytes, 0);
    assert!(first.need_bytes.is_empty(), "{first:?}");
    let backed = status(&old);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert!(backed.content_total >= 4, "{backed:?}");

    // EVERY NAME EVERY FILE IMPLIES IS CONFIRMED, AND THE GATEWAY HOLDS IT.
    let keys = centraid_core::phone::Keyring::derive(&seed(), 0).expect("keys");
    let files = old
        .with_vault(|vault| Ok(centraid_vault::backup::files::content_files(vault)))
        .expect("reads")
        .expect("lists");
    let derivatives: Vec<_> = files.iter().filter(|file| file.variant.is_some()).collect();
    assert!(
        derivatives.len() >= 5,
        "the core derived the JPEG's tiers beside the shell's: {files:?}"
    );
    let names: Vec<_> = files
        .iter()
        .flat_map(|file| names_of(&keys.backup, &file.h, file.len))
        .collect();
    assert!(
        names.len() > files.len(),
        "the film above 64 MiB is more than one part"
    );
    let ledger = Ledger::open(Ledger::path_for(&old_path)).expect("the ledger opens");
    let confirmed = ledger.confirmed_names(&gateway_id).expect("reads");
    let unconfirmed: Vec<_> = names
        .iter()
        .filter(|name| !confirmed.contains(name))
        .collect();
    assert!(unconfirmed.is_empty(), "unconfirmed: {unconfirmed:?}");
    let destination = ledger
        .destination(&gateway_id)
        .expect("reads")
        .expect("paired");
    assert_eq!(destination.epoch, 1, "pairing is the first claim");
    let token = destination.token.parse().expect("a token");
    // The gateway's own name type: the same 32 bytes, declared by the protocol.
    let asked: Vec<centraid_gateway::rules::Name> = names
        .iter()
        .map(|name| centraid_gateway::rules::Name::from_bytes(*name.as_bytes()))
        .collect();
    let missing = gateway
        .runtime
        .block_on(
            gateway
                .spawned
                .client(token)
                .exists(&keys.vault_id(), &asked),
        )
        .expect("the gateway answers");
    assert!(missing.is_empty(), "the gateway lacks {missing:?}");

    // THE CANARY, OVER REAL MEDIA: no plaintext, no plaintext hash, no key.
    let door = old.bytes().expect("a door");
    let mut needles: Vec<(String, Vec<u8>)> = Vec::new();
    for file in &files {
        let label = format!("{} {:?}", file.media_type, file.variant);
        let hash = blake3::Hash::from_bytes(*file.h.as_bytes());
        needles.push((format!("{label}'s hash"), hash.as_bytes().to_vec()));
        needles.push((
            format!("{label}'s hash in hex"),
            hash.to_hex().as_bytes().to_vec(),
        ));
        let plaintext = match door
            .store()
            .read(centraid_blobs::ContentHash::from_bytes(*file.h.as_bytes()))
        {
            Ok(bytes) => bytes,
            // The library's photograph is not in the app's store; its bytes
            // are the test's own.
            Err(_) => still.clone(),
        };
        if plaintext.len() >= 64 {
            let middle = plaintext.len() / 2;
            needles.push((
                format!("{label}'s bytes"),
                plaintext[middle..middle + 32].to_vec(),
            ));
        }
    }
    for (label, key) in [
        ("K_backup", keys.backup.k_backup().to_vec()),
        ("K_name", keys.backup.k_name().to_vec()),
        ("the root key", keys.vault.root.as_bytes().to_vec()),
    ] {
        needles.push((label.to_owned(), key));
    }
    let held = gateway.files();
    assert!(held.len() > names.len(), "the gateway holds the objects");
    let leaked = found_in(&held, &needles);
    assert!(leaked.is_empty(), "the gateway can read: {leaked:?}");

    // ---- 2. FIFTY MORE COMMITS AND A SECOND SNAPSHOT ----------------------
    for index in 0..50 {
        command(
            &old,
            "knowledge.create_note",
            &serde_json::json!({
                "title": format!("after the first backup {index}"),
                "body_text": format!("a note written after the first snapshot, number {index}"),
                "format": "plain",
            }),
            &format!("drill-note-{index}"),
        );
    }
    let second = drain(&old);
    assert_eq!(second.stopped, wire::DrainStop::Empty as i32, "{second:?}");
    assert!(second.acked_at_ms.is_some(), "the second head moved");
    let lost = old
        .with_vault(|vault| Ok(dump(vault)))
        .expect("the lost vault dumps");
    assert!(
        lost.get("knowledge_note")
            .is_some_and(|rows| rows.len() >= 50),
        "the fifty notes are in what was lost"
    );

    // ---- 3. THE PHONE IS LOST; A NEW ONE RESTORES FROM THE WORDS ----------
    let new_dir = tempfile::tempdir().expect("a directory");
    let shelf = Core::open(CoreConfig::new(new_dir.path().join("custody.db")).opening_existing())
        .expect("a core with no vault opens");
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
    assert_eq!(restored.vaults.len(), 1, "{restored:?}");
    let path = PathBuf::from(&restored.vaults[0].path);
    let claimed = Ledger::open(Ledger::path_for(&path))
        .expect("the restored ledger opens")
        .destination(&gateway_id)
        .expect("reads")
        .expect("the restore paired the gateway");
    assert_eq!(
        claimed.epoch, 2,
        "the restore claimed the next writer epoch"
    );

    // ---- 4. IT IS THE VAULT THAT WAS LOST ---------------------------------
    let reopened = centraid_vault::Vault::open(&path).expect("opens through the ladder");
    let came_back = dump(&reopened);
    reopened.close().expect("closes");
    assert_eq!(
        came_back.keys().collect::<Vec<_>>(),
        lost.keys().collect::<Vec<_>>()
    );
    for (table, rows) in &lost {
        assert_eq!(
            came_back.get(table),
            Some(rows),
            "`{table}` did not come back row for row"
        );
    }
    let bytes = centraid_blobs::ByteStore::open(path.with_extension("bytes")).expect("opens");
    for file in &derivatives {
        let hash = centraid_blobs::ContentHash::from_bytes(*file.h.as_bytes());
        assert!(
            bytes.is_complete(hash).expect("answers"),
            "the {:?} of a {} is not back",
            file.variant,
            file.media_type
        );
    }
    let film_hash = centraid_blobs::ContentHash::parse_hex(&film_handle.content_hash).expect("hex");
    assert!(
        !bytes.is_complete(film_hash).expect("answers"),
        "an original waits for the rule or a tap"
    );
    let phone = Core::open(CoreConfig::new(&path).with_seed(seed(), 0)).expect("opens");
    phone
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the store opens");
    let wire::response::Kind::FetchOriginal(fetched) = ask(
        &phone,
        wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
            content_hash: hex::decode(&film_handle.content_hash).expect("hex"),
        }),
    ) else {
        panic!("a fetch answers");
    };
    assert_eq!(fetched.outcome, wire::FetchOutcome::Landed as i32);
    let landed = std::fs::read(&fetched.path).expect("reads");
    assert_eq!(landed.len(), LARGE_FILM_BYTES);
    assert_eq!(
        blake3::hash(&landed).to_hex().as_str(),
        film_handle.content_hash,
        "the original verifies against its hash"
    );

    // ---- 5. THE LOST PHONE FREEZES ----------------------------------------
    let refused = old
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(at_home())),
        })
        .expect_err("a superseded phone's pass is refused");
    assert_eq!(refused.code(), wire::ErrorCode::VaultMoved, "{refused}");
    assert!(status(&old).frozen);

    eprintln!(
        "restore drill across the gateway: {} files ({} derivatives, {} names), {} tables, \
         {} rows, in {:.1}s",
        files.len(),
        derivatives.len(),
        names.len(),
        lost.len(),
        lost.values().map(Vec::len).sum::<usize>(),
        started.elapsed().as_secs_f64()
    );
}
