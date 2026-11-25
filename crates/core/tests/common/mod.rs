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

// The chat's half (#1078): the scenario in a vault behind a real handle, and the chat's
// calls over the wire. Its own module because nothing in it is the backup's.
pub mod chat;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_gateway::rules::ids::VaultId;
use centraid_gateway::rules::state::{ObjectRecord, State as _};
use centraid_gateway::server::harness::{self, Spawned};
use centraid_gateway::server::serve::Cable;
use centraid_media::sealed::Name;
use centraid_vault::backup::state::DeviceState;

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
        self.spawned.shared().wait_active_bundles();
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

    /// The names the gateway holds for `vault`: neither held for deletion
    /// nor damaged.
    pub fn held(&self, vault: &VaultId) -> BTreeSet<Name> {
        self.objects(vault)
            .iter()
            .filter(|record| record.is_live())
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
    hand_over_tokens(&handle);
    handle
}

/// The device state beside the vault at `path`, opened on its own connection.
pub fn state(path: &Path) -> DeviceState {
    DeviceState::open_beside(path).expect("the device state opens")
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
    keep_tokens_at(handle.path(), &paired.tokens);
    paired
}

/// THE SHELL'S SECRET STORE, in a test: the tokens a pairing or a restore handed back, kept
/// per vault file (each phone has its own store) and given back to a core that is opened over
/// the same file (`GatewayTokens`, #1191 E12). The core keeps no token of its own on disk.
static SECRETS: std::sync::Mutex<BTreeMap<(PathBuf, String), wire::GatewayToken>> =
    std::sync::Mutex::new(BTreeMap::new());

/// Keep `tokens` for the phone whose vault file is `path`.
pub fn keep_tokens_at(path: &Path, tokens: &[wire::GatewayToken]) {
    let mut held = SECRETS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for token in tokens {
        held.insert(
            (path.to_path_buf(), token.gateway_id.clone()),
            token.clone(),
        );
    }
}

/// Keep what a restore handed back, each token for the vault file it belongs to.
pub fn keep_restored(restored: &wire::RestoreResponse) {
    for vault in &restored.vaults {
        let own: Vec<wire::GatewayToken> = restored
            .tokens
            .iter()
            .filter(|token| token.vault_id == vault.vault_id)
            .cloned()
            .collect();
        keep_tokens_at(Path::new(&vault.path), &own);
    }
}

/// Give a freshly opened core the tokens its phone's store holds.
pub fn hand_over_tokens(handle: &Handle) {
    let tokens: Vec<wire::GatewayToken> = SECRETS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .filter(|((path, _), _)| path == handle.path())
        .map(|(_, token)| token.clone())
        .collect();
    ask(
        handle,
        wire::request::Kind::GatewayTokens(wire::GatewayTokensRequest { tokens }),
    );
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
    let outcome = handle
        .command(name, input, key)
        .unwrap_or_else(|error| panic!("{name} refused: {error}"));
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

/// `photo.add` over staged bytes; answers the photograph's id. `kind` is what
/// the bytes are drawn as: a photograph or a video.
pub fn add_asset(handle: &Handle, staged: &wire::StageHandle, kind: &str) -> String {
    let media_type = if kind == "video" {
        "video/mp4"
    } else {
        "image/jpeg"
    };
    let output = command(
        handle,
        "photo.add",
        &serde_json::json!({
            "blob": staged.content_hash,
            "size": staged.byte_size,
            "media_type": media_type,
        }),
        &format!("photo.add:{}", staged.content_hash),
    );
    output["id"].as_str().expect("a photograph id").to_owned()
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
        os_uploads: false,
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
            confirm_unproven: true,
            ..wire::RestoreRequest::default()
        }),
    )
    .map(|kind| {
        let wire::response::Kind::Restore(restored) = kind else {
            panic!("a restore answers as a restore");
        };
        keep_restored(&restored);
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

/// Every chunk name the vault's files seal to under the test keys, by class: the names a
/// gateway holds once the vault is backed up whole. Read from the vault's own bytes, the way the
/// engine rebuilds them.
pub fn chunk_names(handle: &Handle) -> BTreeSet<Name> {
    use centraid_media::sealed::{self, Class};
    let keys = keys();
    let store = handle.bytes().expect("a content store");
    handle
        .with_vault(|vault| {
            let mut names = BTreeSet::new();
            for file in centraid_vault::backup::files::content_files(vault).expect("lists") {
                let class = if file.is_original() {
                    Class::Originals
                } else {
                    Class::Thumbnails
                };
                let Some(path) = store
                    .store()
                    .path_of(centraid_blobs::ContentHash::from_bytes(*file.h.as_bytes()))
                    .expect("reads")
                else {
                    continue;
                };
                let bytes = std::fs::read(path).expect("reads the file");
                for chunk in bytes.chunks(sealed::CHUNK_BYTES) {
                    names.insert(sealed::name_of(&keys.backup, class, chunk));
                }
            }
            Ok(names)
        })
        .expect("reads")
}

/// **THE OS UPLOADS WHAT THE PHONE HANDED IT, AND ONLY WAKES A PASS** (#1209, §6.5): every bundle
/// file a pass named is `POST`ed to its gateway by the test under the headers it was handed, as
/// iOS's background session or WorkManager would. The test records nothing as stored: the next
/// pass re-reads the head and diffs. Answers how many bundle files the OS moved.
pub fn the_os_uploads(gateway: &Gateway, bundles: &[wire::HandoffPart]) -> usize {
    use centraid_gateway::rules::bundle;
    let mut moved = 0;
    for part in bundles {
        let token: centraid_gateway::rules::ids::Token = part
            .headers
            .iter()
            .find(|header| header.name == "authorization")
            .and_then(|header| header.value.strip_prefix("Bearer "))
            .expect("a bearer token")
            .parse()
            .expect("a token");
        let vault = centraid_gateway::rules::ids::VaultId::from_bytes(
            hex::decode(&part.vault_id)
                .expect("hex")
                .try_into()
                .expect("32 bytes"),
        );
        let body = std::fs::read(&part.path).expect("the bundle file is there");
        assert_eq!(part.method, "POST");
        assert_eq!(part.size, body.len() as u64);
        let frames = bundle::decode(&body).expect("the bundle file is a bundle");
        gateway
            .runtime
            .block_on(gateway.spawned.client(token).bundle(&vault, &frames))
            .expect("the gateway takes the bundle");
        moved += 1;
    }
    moved
}

/// The root the phone last confirmed at `id` (`conf`), from its device state.
pub fn conf_of(path: &Path, id: &str) -> Option<Name> {
    state(path)
        .gateway(id)
        .expect("reads")
        .expect("paired")
        .conf
        .map(|(name, _)| name)
}

/// The gateway-side name of chunk `index` of `plaintext` as class `class`, under the test keys:
/// what a test needs to damage or lose one object on purpose.
pub fn chunk_of(
    plaintext: &[u8],
    index: usize,
    class: centraid_media::sealed::Class,
) -> centraid_gateway::rules::ids::Name {
    let chunk = plaintext
        .chunks(centraid_media::sealed::CHUNK_BYTES)
        .nth(index)
        .expect("the chunk is there");
    let name = centraid_media::sealed::name_of(&keys().backup, class, chunk);
    centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes())
}

/// The root the phone last confirmed at `id`: the head it set there.
pub fn head_of(path: &Path, id: &str) -> Name {
    conf_of(path, id).expect("a head")
}

/// Every records object the tree rooted at `root` lists (the root itself, its leaves, its ranges,
/// its blobs nodes and its directory), read from the phone's own cached nodes.
pub fn records_at(path: &Path, root: &Name) -> BTreeSet<Name> {
    use centraid_media::sealed::{self, Class};
    let state = state(path);
    let plaintext = state
        .get_node(root)
        .expect("reads")
        .expect("the tree is cached");
    let reference = sealed::seal(&keys().backup, Class::Records, &plaintext)
        .expect("seals")
        .reference();
    centraid_vault::backup::tree::records_of(&state, &reference)
        .expect("the tree reads")
        .into_keys()
        .collect()
}
