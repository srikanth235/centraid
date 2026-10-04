//! THE PHONE AND THE GATEWAY, FOR EVERY BACKUP TEST IN THIS CRATE (#1080).
//!
//! One founded phone holding the vault's keys, a real gateway on
//! `127.0.0.1:0` (`centraid_gateway::server::harness`), and the core's own
//! doors between them: nothing below the socket is faked and nothing above the
//! core's doors is assumed.
//!
//! `dead_code` is allowed because each integration test is its own binary and
//! compiles this whole module: a helper `backup_edges.rs` uses and
//! `phone_backup.rs` does not is dead in one binary and live in the other, and
//! there is no per-binary way to say so — the reason `crates/vault/tests/
//! common` gives for the same allowance.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_gateway::rules::ids::VaultId;
use centraid_gateway::rules::state::{ObjectRecord, State as _};
use centraid_gateway::server::harness::{self, Spawned};
use centraid_gateway::server::serve::Cable;
use centraid_vault::backup::ledger::Ledger;
use centraid_vault::backup::naming::Name;

/// The BIP-39 test vector: the whole input to a restore.
pub const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon abandon abandon art";

pub fn seed() -> centraid_core::Seed {
    centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed()
}

/// The keys of the vault at index 0 of [`WORDS`].
pub fn keys() -> centraid_core::phone::Keyring {
    centraid_core::phone::Keyring::derive(&seed(), 0).expect("the keys derive")
}

/// The vault's id, as the gateway files it.
pub fn vault_id() -> VaultId {
    keys().vault_id()
}

pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime")
}

/// A gateway on its own runtime, kept alive for the test.
pub struct Gateway {
    pub runtime: tokio::runtime::Runtime,
    pub dir: tempfile::TempDir,
    pub spawned: Spawned,
}

pub fn gateway() -> Gateway {
    gateway_in(tempfile::tempdir().expect("a directory"))
}

/// A gateway serving `dir`, which may hold a previous run's state.
pub fn gateway_in(dir: tempfile::TempDir) -> Gateway {
    let runtime = runtime();
    let spawned = runtime
        .block_on(harness::spawn(dir.path()))
        .expect("the gateway starts");
    Gateway {
        runtime,
        dir,
        spawned,
    }
}

impl Gateway {
    pub fn payload(&self) -> String {
        self.spawned.payload().to_json()
    }

    /// The cable every connection to this gateway runs through: what a test
    /// cuts to take the gateway away part-way through a pass or a restore.
    /// TLS runs over it untouched — the phone still pins the gateway's own
    /// certificate — so a cut is exactly a laptop that went to sleep or left
    /// the network.
    pub fn cable(&self) -> &Cable {
        self.spawned.cable()
    }

    /// Stop serving and start again over the same data directory, at the same
    /// address: a laptop that went to sleep and woke up, its `serve` on the
    /// port it is configured with.
    pub fn restart(self) -> Self {
        let Self {
            runtime: asleep,
            dir,
            spawned,
        } = self;
        let addr = spawned.addr;
        asleep.block_on(spawned.shutdown());
        drop(asleep);
        let runtime = runtime();
        let spawned = runtime
            .block_on(harness::spawn_on(dir.path(), addr))
            .expect("the gateway starts again where it was");
        Gateway {
            runtime,
            dir,
            spawned,
        }
    }

    /// Every file under the gateway's data directory, read whole.
    pub fn files(&self) -> Vec<(PathBuf, Vec<u8>)> {
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

    /// Every object row the gateway keeps for `vault`, tombstoned and damaged
    /// ones included.
    pub fn objects(&self, vault: &VaultId) -> Vec<ObjectRecord> {
        let mut out = Vec::new();
        let mut after: Option<(VaultId, centraid_gateway::rules::ids::Name)> = None;
        loop {
            let page = self
                .spawned
                .shared()
                .rules(|rules| {
                    rules
                        .state
                        .all_objects(after.as_ref().map(|(v, n)| (v, n)), 1_000)
                        .map_err(Into::into)
                })
                .expect("the gateway lists its objects");
            let full = page.len() == 1_000;
            after = page.last().map(|(v, record)| (*v, record.name));
            out.extend(
                page.into_iter()
                    .filter(|(owner, _)| owner == vault)
                    .map(|(_, record)| record),
            );
            if !full {
                return out;
            }
        }
    }

    /// The names the gateway holds for `vault`: neither tombstoned nor
    /// damaged.
    pub fn held(&self, vault: &VaultId) -> BTreeSet<Name> {
        self.objects(vault)
            .iter()
            .filter(|record| record.is_held())
            .map(|record| Name::from_bytes(*record.name.as_bytes()))
            .collect()
    }

    /// The vault's writer epoch and the manifest its head names.
    pub fn writer(&self, vault: &VaultId) -> (u64, Option<Name>) {
        let pairings = self
            .spawned
            .shared()
            .rules(|rules| rules.pairings())
            .expect("the gateway lists its pairings");
        let pairing = pairings
            .iter()
            .find(|pairing| pairing.vault.vault == *vault)
            .expect("the gateway holds the vault");
        (
            pairing.vault.writer_epoch,
            pairing
                .head
                .as_ref()
                .map(|head| Name::from_bytes(*head.name.as_bytes())),
        )
    }
}

/// A founded phone holding the vault's keys and its content store.
pub fn phone(dir: &Path) -> Handle {
    phone_with(dir, |config| config)
}

/// [`phone`], opened with a configuration of the test's own.
pub fn phone_with(dir: &Path, configure: impl FnOnce(CoreConfig) -> CoreConfig) -> Handle {
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

/// The same phone after a crash or a relaunch: a new core over the files a
/// dropped one left, the vault already founded.
pub fn reopen(path: &Path) -> Handle {
    let handle = Core::open(CoreConfig::new(path).with_seed(seed(), 0)).expect("the core reopens");
    handle
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the store opens");
    handle
}

/// The ledger beside the vault at `path`, opened on its own connection.
pub fn ledger(path: &Path) -> Ledger {
    Ledger::open(Ledger::path_for(path)).expect("the ledger opens")
}

pub fn try_ask(
    handle: &Handle,
    kind: wire::request::Kind,
) -> centraid_core::Result<wire::response::Kind> {
    handle
        .call(&wire::Request { kind: Some(kind) })
        .map(|response| response.kind.expect("an answer has a kind"))
}

pub fn ask(handle: &Handle, kind: wire::request::Kind) -> wire::response::Kind {
    try_ask(handle, kind.clone()).unwrap_or_else(|error| panic!("{kind:?} was refused: {error}"))
}

pub fn pair(handle: &Handle, gateway: &Gateway) -> wire::PairResponse {
    pair_with(handle, &gateway.payload())
}

/// Pair from a payload's text.
pub fn pair_with(handle: &Handle, payload: &str) -> wire::PairResponse {
    let wire::response::Kind::PairPhone(paired) = ask(
        handle,
        wire::request::Kind::PairPhone(wire::PairRequest {
            payload: payload.to_owned(),
        }),
    ) else {
        panic!("a pairing answers");
    };
    paired
}

/// Bytes nobody else has: a label's hash, stretched.
pub fn bytes_of(label: &str, size: usize) -> Vec<u8> {
    let mut reader = blake3::Hasher::new()
        .update(label.as_bytes())
        .finalize_xof();
    let mut out = vec![0_u8; size];
    reader.fill(&mut out);
    out
}

/// One stage frame, answered.
pub fn stage_frame(handle: &Handle, kind: wire::stage_request::Kind) -> wire::stage_response::Kind {
    let wire::response::Kind::Stage(answer) = ask(
        handle,
        wire::request::Kind::Stage(wire::StageRequest { kind: Some(kind) }),
    ) else {
        panic!("a stage frame answers");
    };
    answer.kind.expect("a stage answer has a kind")
}

pub fn stage(handle: &Handle, begin: wire::StageBegin, bytes: &[u8]) -> wire::StageHandle {
    let send = |kind| stage_frame(handle, kind);
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

pub fn owned(media_type: &str, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        media_type: media_type.to_owned(),
        byte_size: bytes.len() as u64,
        source: wire::StageSource::Owned as i32,
        ..wire::StageBegin::default()
    }
}

/// A library item's begin. Its length is "not known" (0) half the time, as
/// the library answers it.
pub fn library(media_type: &str, os_ref: &str, bytes: &[u8], edited: bool) -> wire::StageBegin {
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

pub fn thumb_of(parent: &wire::StageHandle, bytes: &[u8]) -> wire::StageBegin {
    wire::StageBegin {
        for_hash: hex::decode(&parent.content_hash).expect("hex"),
        tier: "thumb".to_owned(),
        ..owned("image/jpeg", bytes)
    }
}

/// One command through the core, which must execute; answers its output.
pub fn command(
    handle: &Handle,
    name: &str,
    input: &serde_json::Value,
    key: &str,
) -> serde_json::Value {
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
    if outcome.output.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&outcome.output).expect("json")
    }
}

/// `media.add_asset` over staged bytes; answers the asset id.
pub fn add_asset(handle: &Handle, staged: &wire::StageHandle, kind: &str) -> String {
    let output = command(
        handle,
        "media.add_asset",
        &serde_json::json!({
            "staged_sha": staged.content_hash,
            "kind": kind,
        }),
        &format!("media.add_asset:{}", staged.content_hash),
    );
    output["asset_id"].as_str().expect("an asset id").to_owned()
}

pub fn try_drain(
    handle: &Handle,
    request: wire::DrainRequest,
) -> centraid_core::Result<wire::DrainResponse> {
    try_ask(handle, wire::request::Kind::Drain(request)).map(|kind| {
        let wire::response::Kind::Drain(drained) = kind else {
            panic!("a drain answers as a drain");
        };
        drained
    })
}

pub fn drain(handle: &Handle, request: wire::DrainRequest) -> wire::DrainResponse {
    try_drain(handle, request).unwrap_or_else(|error| panic!("the pass was refused: {error}"))
}

/// A pass at home, on a charger, that the member asked for.
pub fn at_home() -> wire::DrainRequest {
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

/// A pass the shell runs for no reason the member gave: a window, a commit.
pub fn quietly() -> wire::DrainRequest {
    wire::DrainRequest {
        wants_snapshot: false,
        ..at_home()
    }
}

pub fn status(handle: &Handle) -> wire::BackupStatusResponse {
    let wire::response::Kind::BackupStatus(status) = ask(
        handle,
        wire::request::Kind::BackupStatus(wire::BackupStatusRequest {}),
    ) else {
        panic!("a status answers");
    };
    status
}

/// How many files the status says wait for `reason`.
pub fn waiting(status: &wire::BackupStatusResponse, reason: wire::WaitReason) -> u64 {
    status
        .waiting
        .iter()
        .filter(|row| row.reason == reason as i32)
        .map(|row| row.count)
        .sum()
}

pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// One file a vault's rows name: its hash, its length and its tier.
pub type Named = (String, u64, Option<String>);

/// What a vault is, for comparing two of them through the vault's own
/// doors: its id, and every file its rows name — each content item and each
/// derivative, by hash, length and tier.
pub fn census(path: &Path) -> (Option<String>, Vec<Named>) {
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

/// Every row of every table a vault file holds, as the drill dumps it.
pub fn rows(path: &Path) -> BTreeMap<String, Vec<String>> {
    let vault = centraid_vault::Vault::open(path).expect("opens");
    let dumped = centraid_vault::backup::drill::dump(&vault).expect("dumps");
    vault.close().expect("closes");
    dumped
}

/// A core with no vault, which is what a phone restoring from its words is.
pub fn shelf(dir: &Path) -> Handle {
    std::fs::create_dir_all(dir).expect("a directory");
    let shelf = Core::open(CoreConfig::new(dir.join("custody.db")).opening_existing())
        .expect("a core with no vault opens");
    assert!(!shelf.holds_a_replica());
    shelf
}

pub fn try_restore(dir: &Path, payload: &str) -> centraid_core::Result<wire::RestoreResponse> {
    try_ask(
        &shelf(dir),
        wire::request::Kind::Restore(wire::RestoreRequest {
            phrase: WORDS.to_owned(),
            payload: payload.to_owned(),
            ..wire::RestoreRequest::default()
        }),
    )
    .map(|kind| {
        let wire::response::Kind::Restore(restored) = kind else {
            panic!("a restore answers as a restore");
        };
        restored
    })
}

pub fn restore(dir: &Path, gateway: &Gateway) -> wire::RestoreResponse {
    try_restore(dir, &gateway.payload())
        .unwrap_or_else(|error| panic!("the restore was refused: {error}"))
}

/// How many tokens the gateway holds, for every vault it knows.
pub fn tokens(gateway: &Gateway) -> usize {
    gateway
        .spawned
        .shared()
        .rules(|rules| rules.pairings())
        .expect("the gateway lists its pairings")
        .iter()
        .map(|pairing| pairing.tokens.len())
        .sum()
}

pub fn forget(handle: &Handle, gateway_id: &str) -> wire::ForgetDestinationResponse {
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

/// The gateway's name for part `index` of the file `hash_hex`: what a test
/// needs to damage one object on purpose.
pub fn gateway_name(hash_hex: &str, index: u32) -> centraid_gateway::rules::ids::Name {
    let h = centraid_vault::backup::naming::PlaintextHash::from_bytes(
        <[u8; 32]>::try_from(hex::decode(hash_hex).expect("hex")).expect("32 bytes"),
    );
    let name = centraid_vault::backup::naming::name(&keys().backup, &h, index);
    centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes())
}

/// Every name the vault at `path`'s files imply.
pub fn file_names(handle: &Handle) -> BTreeSet<Name> {
    let keys = keys();
    handle
        .with_vault(|vault| {
            Ok(centraid_vault::backup::files::content_files(vault)
                .expect("lists")
                .iter()
                .flat_map(|file| {
                    centraid_vault::backup::naming::names_of(&keys.backup, &file.h, file.len)
                })
                .collect())
        })
        .expect("reads")
}
