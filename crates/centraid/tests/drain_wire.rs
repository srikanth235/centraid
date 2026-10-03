//! **THE DRAIN, OVER THE CARRIER THE PRODUCT SHIPS** (#1029 §2, W15-2).
//!
//! A real vault on a real file, a real `centraid-gateway-server` served through
//! `serve::IrohListener` on a loopback iroh endpoint, and
//! `centraid_core::phone::drain_now` — the core's own door, the one
//! `centraid_call`'s `Drain` arm reaches — driving a real
//! `GatewayClient<IrohTransport>` from the spool.
//!
//! Nothing here is a fake that agrees with itself. The gateway is the shipped
//! router over the shipped carrier; the client is the shipped client; the
//! sealing is `backup::capture` and the manifests are `GenerationManifest`.
//!
//! # RELAY OFF, ADDRESS LOOKUP OFF
//!
//! Both endpoints are loopback with no relay and no DNS, and the phone is
//! handed the server's direct address through the laptop record's
//! `direct_addrs` — which is exactly what that field is for (D-1020-C15). A
//! test that reached n0's relay mesh would be measuring somebody else's uptime.
//!
//! # WHAT IS ASSERTED, BY NAME
//!
//! | Test | The claim |
//! |---|---|
//! | [`a_drain_moves_the_spool_to_the_laptop_and_acks_what_the_laptop_acked`] | one pass with no deadline empties the spool, and `acked_txid` is the gateway's, not the phone's |
//! | [`a_deadline_stops_a_pass_on_an_entry_boundary_and_the_next_pass_continues`] | the acceptance criterion: a budget that admits one entry acks exactly that prefix, and the next pass carries on from it without re-sending what was acked |
//! | [`an_unpaired_phone_reports_unreachable_and_loses_nothing`] | the spool is intact and the next pass starts where this one did |
//! | [`a_laptop_ticket_pairs_by_redeeming_its_invite_and_the_next_drain_lands`] | `phone::pair` over a ticket the laptop minted: the invite admits a vault the laptop never heard of, the lease is claimed, the laptop renders the phone's safety number from what the admit told it (W15-D5), and a drain with the device secret the pair handed back is acked (#1047 E4) |
//! | [`a_laptop_that_refuses_the_code_is_a_refusal_and_not_silence`] | a ticket whose invite the laptop never minted is refused as `UNAUTHORIZED`, not `PEER_UNREACHABLE`, and no laptop record is kept (#1047 E5) |
//! | [`a_vault_that_used_locker_restores_from_its_words_and_its_secret_reveals`] | found, drain, first Locker unlock and seal, drain, restore from the 24 words on a new phone over one carrier, and the password reveals under the re-derived `K` — the `locker_key` row is in the census the generation carries (#1047 R3) |
//! | [`a_refused_restore_leaves_the_lease_where_it_was`] | a generation the new phone refuses moves no lease: the old phone's next drain still lands under the epoch it held, and nothing is left on the new phone (#1047 R3, L7) |
//! | [`a_restore_that_refuses_one_vault_claims_none`] | two vaults, the second damaged: the restore is refused, neither lease moves and both old-phone drains land (#1047 M1) |
//! | [`a_head_that_moves_to_a_damaged_generation_before_the_claim_moves_no_lease`] | the old phone commits a damaged generation between the check and the claim: the claim at the checked head is refused, the new head fails its check, and the old phone still drains (#1047 L1) |
//! | [`a_head_that_moves_to_a_good_generation_before_the_claim_is_the_one_restored`] | the same window with a good generation: the new head is checked and restored, the restored phone's first drain lands, and a third phone restores that drain (#1047 L1, M1) |
//! | [`a_claim_that_fails_after_another_landed_answers_the_claimed_vault`] | vault 0 claimed, vault 1's claim then refused: vault 0 is answered and drains on the new phone, vault 1 is named `unclaimed` and its lease stays (#1047 M1) |
//!
//! # THIS TEST LANDS RED
//!
//! On the commit before its implementation, `phone::drain` seals into the spool
//! and answers `DRAIN_STOP_UNREACHABLE` because nothing uploads. All three
//! cases fail on their assertions — they compile, they run, and they say what
//! is missing.

use std::path::Path;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_locker::phone as locker_phone;
use centraid_core::phone::{self, Keyring, Laptop};
use centraid_gateway_core::Gateway;
use centraid_gateway_core::ids::{Key32, VaultId};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::{Config, IrohConfig};
use centraid_gateway_server::http::Server;
use centraid_gateway_server::serve;
use centraid_gateway_server::state::{SqliteState, register};
use centraid_identity::RecoveryPhrase;
use centraid_vault::Vault;

const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon art";

/// The vault's derivation index. Never chosen by a shell, and never reused (F2).
const INDEX: u32 = 0;

/// Segments the spool holds before the drain, and it is deliberately **more
/// than one batch**.
///
/// `gateway_client::spool::MAX_BATCH_OBJECTS` is 64, so a spool of 64 or fewer
/// objects is one declare, one commit and one manifest entry — and a deadline
/// inside it could not move `acked_txid` however small the budget, because
/// there is no second boundary to stop on. That is correct behaviour for a
/// small vault and it is also a test that asserts nothing, so this drill seeds
/// the spool a real camera-roll pass has: two batches, cut where the client's
/// own policy cuts them.
///
/// A capture tick cuts one segment over the commits since the last one, so this
/// is a write-then-capture loop rather than a run of commits.
const SEGMENTS: usize = 70;

/// A live gateway on a loopback iroh endpoint.
struct Live {
    address: iroh::EndpointAddr,
    /// The laptop's own handle on its state, for what its terminal prints.
    shared: centraid_gateway_server::http::Shared,
    _objects: tempfile::TempDir,
    _served: tokio::task::JoinHandle<()>,
}

async fn live(vault: VaultId, identity: Key32) -> Live {
    let mut state = SqliteState::in_memory().expect("a state file");
    register(&mut state, vault, identity, Plan::active(u64::MAX), false)
        .await
        .expect("a registered vault");
    serving(state).await
}

/// A live gateway that knows NO vault, and one invite its owner minted — what
/// `centraid-gateway invite` leaves behind.
async fn live_with_invite() -> (Live, String) {
    let state = SqliteState::in_memory().expect("a state file");
    let invite = centraid_gateway_server::tenancy::mint(
        &state,
        u64::MAX / 2,
        centraid_gateway_server::clock::now(),
    )
    .expect("an invite");
    (serving(state).await, invite.code)
}

async fn serving(state: SqliteState) -> Live {
    let objects = tempfile::tempdir().expect("a temporary object directory");

    let bytes = ConfiguredBytes::new(Backend::Filesystem(
        FilesystemBytes::open(objects.path(), "").expect("an object directory"),
    ));
    let server = Server {
        gateway: Gateway::new(state, bytes, Policy::default()),
        config: Config::defaults(objects.path(), ""),
    };
    // THE PRODUCTION PATH binds the listener: an endpoint that offers an ALPN
    // outside `serve.rs` is a `no-listening-socket` finding and should be.
    let endpoint = serve::bind_iroh(
        objects.path(),
        &IrohConfig {
            local_only: true,
            bind_addr: Some("127.0.0.1:0".to_owned()),
            ..IrohConfig::default()
        },
    )
    .await
    .expect("a bound endpoint");
    let address = iroh::EndpointAddr::from_parts(
        endpoint.id(),
        endpoint
            .bound_sockets()
            .into_iter()
            .map(iroh::TransportAddr::Ip),
    );
    let shared = serve::shared(server);
    let serving = shared.clone();
    let served = tokio::spawn(async move {
        let _ = serve::serve_iroh(endpoint, serving).await;
    });
    Live {
        address,
        shared,
        _objects: objects,
        _served: served,
    }
}

/// This phone's keys, from the 24 words and a minted device secret.
fn keyring() -> (Keyring, [u8; 32]) {
    let seed = RecoveryPhrase::parse(PHRASE)
        .expect("the vector parses")
        .seed();
    let secret = [0xD1_u8; 32];
    (
        Keyring::derive(&seed, INDEX, Some(secret)).expect("a fresh index"),
        secret,
    )
}

/// Do what a pairing does: certify this device, keep the record, **and claim
/// the lease**.
///
/// The claim is the half that is easy to leave out of a stand-in and is
/// load-bearing: a lease is claimed once, by the flow that makes a device a
/// device, and every drain afterwards writes under it. `phone::pair` claims it
/// for real against a redeemed invite; this claims it the same way with the
/// certificate it just issued.
async fn pair_with(vault_file: &Path, live: &Live, keyring: &Keyring, secret: &[u8; 32]) {
    let device = phone::link::Device::certify(secret, &keyring.vault.identity, 1);
    let record = Laptop {
        gateway_endpoint: hex::encode(live.address.id.as_bytes()),
        relay_url: Some(String::new()),
        direct_addrs: live
            .address
            .ip_addrs()
            .map(|addr: &std::net::SocketAddr| addr.to_string())
            .collect(),
        device_certificate: Some(device.certificate_hex()),
        epoch: Some(1),
        last_acked_at_ms: None,
    };
    record
        .write(vault_file)
        .expect("the laptop record is written");

    let mut client = phone::link::dial(
        &record,
        &device,
        Key32::from_bytes(keyring.vault.identity.public().to_bytes()),
    )
    .await
    .expect("the phone dials the laptop");
    client
        .preflight(phone::link::now_ms())
        .await
        .expect("the laptop answers");
    client
        .claim_lease(phone::link::now_ms())
        .await
        .expect("this device takes the lease");
}

/// A founded vault whose spool holds [`SEGMENTS`] sealed segments.
fn founded(dir: &Path, keyring: &Keyring) -> (Vault, std::path::PathBuf) {
    std::fs::create_dir_all(dir).expect("the directory is made");
    let file = dir.join("vault.db");
    let vault = Vault::create(&file).expect("a vault file");
    vault
        .found("The Drain Household", "Ada")
        .expect("it founds");
    for index in 0..8 {
        centraid_vault::backup::drill::write_one(&vault, index).expect("a commit");
    }
    let _ = keyring;
    (vault, file)
}

/// Write and capture [`SEGMENTS`] times, so the spool holds that many segments
/// **above** whatever base the last drain took.
///
/// It has to be after a drain and not before one, and that is the shape of the
/// product rather than a trick: a first backup is a **base**, which covers
/// every txid there is, so there is nothing above it to cut a second entry on.
/// Segments are what a vault accumulates between bases, which is where a phone
/// with a small background window actually lives.
fn seed_segments(vault: &Vault, file: &Path, keyring: &Keyring) {
    let home = phone::open_home(file).expect("a backup home");
    let spool = home.spool().expect("a spool");
    for index in 0..SEGMENTS {
        centraid_vault::backup::drill::write_one(vault, 1_000 + index).expect("a commit");
        // ONE CAPTURE TICK, ONE SEGMENT. The same call the drain makes; this
        // loop stands in for the debounced tick a running phone has.
        centraid_vault::backup::capture(vault, &spool, &keyring.objects).expect("a capture");
    }
}

fn drain(
    vault: &Vault,
    file: &Path,
    keyring: &Keyring,
    deadline_ms: u64,
    runtime: &tokio::runtime::Handle,
) -> wire::DrainResponse {
    phone::drain_now(
        vault,
        file,
        Some(keyring),
        &wire::DrainRequest {
            deadline_ms,
            ..wire::DrainRequest::default()
        },
        runtime,
    )
    .expect("a drain answers")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drain_moves_the_spool_to_the_laptop_and_acks_what_the_laptop_acked() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (keys, secret) = keyring();
    let (vault, file) = founded(&dir, &keys);
    let gateway = live(
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
    )
    .await;
    pair_with(&file, &gateway, &keys, &secret).await;

    let runtime = tokio::runtime::Handle::current();
    let answer = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));

    assert_eq!(
        answer.stopped,
        wire::DrainStop::Empty as i32,
        "a pass with no deadline runs until the spool is empty"
    );
    assert!(
        answer.acked_txid > 0,
        "the gateway acked nothing, so there is nothing to claim"
    );
    assert_eq!(
        answer.pending_bytes, 0,
        "the spool still holds {} bytes after an Empty pass",
        answer.pending_bytes
    );
    // THE ONLY BACKUP CLAIM THERE IS: the server's own moment, in the server's
    // own answer.
    assert!(
        answer.acked_at_ms.is_some_and(|moment| moment > 0),
        "a pass that acked carries the GATEWAY's moment and not this phone's"
    );

    // AND A STATUS READ AGREES, without dialling anything.
    let status = phone::backup_status(&file).expect("a status reads");
    assert!(status.laptop_paired);
    assert_eq!(status.acked_txid, Some(answer.acked_txid));
    assert_eq!(status.acked_at_ms, answer.acked_at_ms);
    assert_eq!(status.pending_bytes, 0);

    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **THE ACCEPTANCE CRITERION.** A budget that admits one entry acks exactly
/// that prefix, and the next pass continues from there.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deadline_stops_a_pass_on_an_entry_boundary_and_the_next_pass_continues() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (keys, secret) = keyring();
    let (vault, file) = founded(&dir, &keys);
    let gateway = live(
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
    )
    .await;
    pair_with(&file, &gateway, &keys, &secret).await;

    let runtime = tokio::runtime::Handle::current();

    // THE FIRST BACKUP IS A BASE, and a base covers every txid there is. The
    // deadline this test is about lives in what comes AFTER one.
    let founding = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(founding.stopped, wire::DrainStop::Empty as i32);
    seed_segments(&vault, &file, &keys);

    // A BUDGET OF ONE MILLISECOND. Rule 2 of the deadline semantics: a pass
    // always commits at least one entry, however small the budget — a window
    // too small for a single entry that made no progress would make a phone on
    // 28-second windows never finish. So this pass commits exactly one.
    let first = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 1, &runtime));
    assert_eq!(
        first.stopped,
        wire::DrainStop::Deadline as i32,
        "a one-millisecond budget does not empty a spool"
    );
    assert!(
        first.acked_txid > 0,
        "a pass that commits nothing at all makes a phone on small windows never finish"
    );
    assert!(
        first.pending_bytes > 0,
        "the deadline stopped a pass that had nothing left to do"
    );

    // AND THE NEXT PASS CARRIES ON FROM THERE. Not from the beginning: the
    // objects already committed come back as `already_committed` and are not
    // re-sent, which is what makes a resumed drain cheap.
    let second = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(
        second.stopped,
        wire::DrainStop::Empty as i32,
        "the second pass should have finished the spool"
    );
    assert!(
        second.acked_txid > first.acked_txid,
        "the second pass acked {} and the first had already acked {}",
        second.acked_txid,
        first.acked_txid
    );
    assert_eq!(second.pending_bytes, 0);

    // A THIRD PASS OVER AN EMPTY SPOOL IS A NO-OP AND SAYS SO. Idempotent, and
    // safe to call from a background window that fired one second late.
    let third = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(third.stopped, wire::DrainStop::Empty as i32);
    assert_eq!(third.pending_bytes, 0);

    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unpaired_phone_reports_unreachable_and_loses_nothing() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (keys, _) = keyring();
    let (vault, file) = founded(&dir, &keys);
    let runtime = tokio::runtime::Handle::current();

    let answer = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(
        answer.stopped,
        wire::DrainStop::Unreachable as i32,
        "a phone with no laptop has nowhere to send bytes"
    );
    assert_eq!(
        answer.acked_at_ms, None,
        "nothing acked, so nothing claimed"
    );
    assert!(
        answer.pending_bytes > 0,
        "the pass sealed nothing into the spool, so there is nothing to resume"
    );

    // AND THE SPOOL IS STILL THERE for the pass that finds a laptop.
    let again = tokio::task::block_in_place(|| drain(&vault, &file, &keys, 0, &runtime));
    assert_eq!(
        again.pending_bytes, answer.pending_bytes,
        "an unreachable pass lost part of the spool"
    );

    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

/// THE PAIRING THE PRODUCT SHIPS (#1047 E4): a ticket minted over the
/// laptop's endpoint and a fresh invite, scanned by a phone the laptop has
/// never heard of. `phone::pair` must redeem the invite BEFORE it claims the
/// lease — every signed call is `UnknownVault` until then — and hand back the
/// device secret the next drain signs with.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_laptop_ticket_pairs_by_redeeming_its_invite_and_the_next_drain_lands() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (keys, _) = keyring();
    let (vault, file) = founded(&dir, &keys);
    let (live, code) = live_with_invite().await;
    let runtime = tokio::runtime::Handle::current();

    let ticket = centraid_identity::ticket::mint(
        *live.address.id.as_bytes(),
        &code,
        u64::MAX,
        String::new(),
        live.address
            .ip_addrs()
            .map(|addr: &std::net::SocketAddr| addr.to_string())
            .collect(),
    );
    let paired = tokio::task::block_in_place(|| {
        phone::pair(
            &file,
            Some(&keys),
            &wire::PairRequest {
                payload: centraid_identity::ticket::encode(&ticket),
            },
            &runtime,
        )
    })
    .expect("a laptop that never heard of this vault takes it through the invite");
    assert_eq!(
        paired.gateway_endpoint,
        live.address.id.as_bytes().to_vec(),
        "the endpoint the phone will dial is the laptop's"
    );
    // THE TWO SCREENS AGREE (W15-D5): the laptop renders its number from the
    // account the admit named and its own endpoint key, through the same
    // function the phone's core called — and gets the phone's digits.
    let admitted = {
        let server = live.shared.lock().await;
        centraid_gateway_server::tenancy::list(&server.gateway.state).expect("a read")
    };
    let account = admitted
        .iter()
        .find_map(|record| record.redeemed_by)
        .expect("the invite admitted this vault");
    assert!(
        !paired.safety_number.is_empty(),
        "the phone has a number to compare"
    );
    assert_eq!(
        centraid_gateway_server::tenancy::safety_number(live.address.id.as_bytes(), &account),
        Some(paired.safety_number.clone()),
        "the laptop's terminal prints the phone's safety number"
    );
    let secret: [u8; 32] = paired
        .device_secret
        .as_slice()
        .try_into()
        .expect("the pair hands the device secret over once");
    assert!(
        Laptop::read(&file).expect("it reads").is_some(),
        "the laptop record is kept beside the vault"
    );

    // THE NEXT DRAIN SIGNS WITH THE KEY THE CERTIFICATE NAMES.
    let seed = RecoveryPhrase::parse(PHRASE).expect("the vector").seed();
    let keyed = Keyring::derive(&seed, INDEX, Some(secret)).expect("the same index");
    let answer = tokio::task::block_in_place(|| drain(&vault, &file, &keyed, 0, &runtime));
    assert_eq!(
        answer.stopped,
        wire::DrainStop::Empty as i32,
        "the paired laptop took the spool"
    );
    assert!(answer.acked_txid > 0, "and acked it");

    drop(vault);
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A REFUSAL IS NOT SILENCE (#1047 E5). The laptop answers, does not know the
/// invite, and will not grant a lease to a vault it never admitted: the core
/// says so with `UNAUTHORIZED`, so the phone asks for a new code instead of
/// telling the member to wake a laptop that is awake.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_laptop_that_refuses_the_code_is_a_refusal_and_not_silence() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (keys, _) = keyring();
    let (vault, file) = founded(&dir, &keys);
    let (live, _code) = live_with_invite().await;
    let runtime = tokio::runtime::Handle::current();

    let ticket = centraid_identity::ticket::mint(
        *live.address.id.as_bytes(),
        "not-an-invite-this-laptop-minted",
        u64::MAX,
        String::new(),
        live.address
            .ip_addrs()
            .map(|addr: &std::net::SocketAddr| addr.to_string())
            .collect(),
    );
    let refused = tokio::task::block_in_place(|| {
        phone::pair(
            &file,
            Some(&keys),
            &wire::PairRequest {
                payload: centraid_identity::ticket::encode(&ticket),
            },
            &runtime,
        )
    })
    .expect_err("an invite the laptop never minted is refused");
    assert_eq!(
        refused.code(),
        wire::ErrorCode::Unauthorized,
        "the laptop answered, so this is a refusal and not unreachable: {refused}"
    );
    assert!(
        Laptop::read(&file).expect("it reads").is_none(),
        "a refused pairing keeps no laptop record"
    );

    drop(vault);
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A phone as the shell opens one: a core over `file` holding the words' seed
/// at [`INDEX`] and `secret` as its device key.
fn phone_core(file: &Path, secret: [u8; 32]) -> centraid_core::Handle {
    let seed = RecoveryPhrase::parse(PHRASE).expect("the vector").seed();
    centraid_core::Core::open(
        centraid_core::CoreConfig::new(file)
            .with_seed(seed, INDEX)
            .with_device_secret(secret),
    )
    .expect("a core opens")
}

/// Close a core and drop it off the async context: a handle owns a runtime of
/// its own, and tokio refuses to drop one from inside another's task.
fn let_go(handle: centraid_core::Handle) {
    handle.close();
    tokio::task::block_in_place(move || drop(handle));
}

fn call(handle: &centraid_core::Handle, kind: wire::request::Kind) -> wire::response::Kind {
    handle
        .call(&wire::Request { kind: Some(kind) })
        .expect("the core answers")
        .kind
        .expect("an answer with a kind")
}

fn locker(
    handle: &centraid_core::Handle,
    step: wire::locker_session_request::Step,
) -> wire::LockerSessionResponse {
    match call(
        handle,
        wire::request::Kind::Locker(wire::LockerSessionRequest { step: Some(step) }),
    ) {
        wire::response::Kind::Locker(answer) => answer,
        other => panic!("a Locker step answered as {other:?}"),
    }
}

fn command(handle: &centraid_core::Handle, name: &str, input: &serde_json::Value) {
    match call(
        handle,
        wire::request::Kind::Command(wire::Command {
            name: name.to_owned(),
            input: serde_json::to_vec(input).expect("JSON"),
            invoke_key: format!("r3-{name}"),
            ..wire::Command::default()
        }),
    ) {
        wire::response::Kind::Command(outcome)
            if outcome.status == wire::CommandStatus::Executed as i32 => {}
        other => panic!("{name} did not execute: {other:?}"),
    }
}

fn drain_handle(handle: &centraid_core::Handle) -> wire::DrainResponse {
    match call(
        handle,
        wire::request::Kind::Drain(wire::DrainRequest {
            deadline_ms: 0,
            ..wire::DrainRequest::default()
        }),
    ) {
        wire::response::Kind::Drain(answer) => answer,
        other => panic!("a drain answered as {other:?}"),
    }
}

/// A phone that founded its vault, drained once, THEN used Locker, and drained
/// again — the order a member lives in, and the order that matters: the first
/// drain's capture seeds the running census before the first unlock writes
/// its `locker_key` row.
async fn a_phone_that_used_locker(dir: &Path) -> (centraid_core::Handle, std::path::PathBuf, Live) {
    let (keys, secret) = keyring();
    let old = dir.join("old");
    std::fs::create_dir_all(&old).expect("the old phone's directory");
    let file = old.join("vault.db");
    let gateway = live(
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
        Key32::from_bytes(keys.vault.identity.public().to_bytes()),
    )
    .await;
    let handle = phone_core(&file, secret);
    handle
        .with_vault(|vault| {
            vault.found("The Locker Household", "Ada")?;
            Ok(())
        })
        .expect("the phone founds its vault");
    pair_with(&file, &gateway, &keys, &secret).await;

    let first = tokio::task::block_in_place(|| drain_handle(&handle));
    assert_eq!(
        first.stopped,
        wire::DrainStop::Empty as i32,
        "the base lands"
    );

    // FIRST USE OF LOCKER: the unlock names a generation and writes the
    // `locker_key` row; the add seals the password under `K`.
    tokio::task::block_in_place(|| {
        locker(
            &handle,
            wire::locker_session_request::Step::Unlock(wire::LockerUnlock {}),
        );
        command(
            &handle,
            "locker.add_item",
            &serde_json::json!({
                "item_id": "r3-bank", "type": "login", "title": "Bank",
                "username": "ada@example.com", "password": "hunter22"
            }),
        );
    });
    let second = tokio::task::block_in_place(|| drain_handle(&handle));
    assert_eq!(
        second.stopped,
        wire::DrainStop::Empty as i32,
        "the Locker lands"
    );
    assert!(second.acked_txid > first.acked_txid, "and is acked");
    (handle, file, gateway)
}

fn restore_request(gateway: &Live) -> wire::RestoreRequest {
    wire::RestoreRequest {
        phrase: PHRASE.to_owned(),
        endpoint: Some(gateway.address.id.as_bytes().to_vec()),
        direct_addrs: gateway
            .address
            .ip_addrs()
            .map(|addr: &std::net::SocketAddr| addr.to_string())
            .collect(),
        ..wire::RestoreRequest::default()
    }
}

/// **A VAULT THAT USED LOCKER COMES BACK FROM ITS WORDS** (#1047 R3).
///
/// The walk that found it: a phone that had saved one Locker login could not
/// be restored at all — `census_matches` refused with `locker_key: the
/// generation says 0 rows … and the restored vault has 1`, because the first
/// unlock wrote that row around the commit guard and the running census never
/// counted it. Here the whole loop runs over the shipped carrier: found,
/// drain, unlock, seal, drain, restore from the 24 words on a new phone, and
/// reveal the password under the `K` the restored phone re-derived.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vault_that_used_locker_restores_from_its_words_and_its_secret_reveals() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old_phone, _old_file, gateway) = a_phone_that_used_locker(&dir).await;
    let_go(old_phone);

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    let started = std::time::Instant::now();
    let restored = tokio::task::block_in_place(|| {
        phone::restore::run(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
        )
    })
    .expect("a vault that used Locker restores");
    // THE MEASUREMENT #1047 R3 ASKED FOR: one index plus the twenty-miss gap
    // over one connection, where it used to be twenty-one fresh endpoints.
    eprintln!(
        "restore of 1 vault + {} gap indices took {:?}",
        restored.gap_scanned,
        started.elapsed()
    );
    assert_eq!(restored.vaults.len(), 1, "the one vault comes back");
    let vault = &restored.vaults[0];

    let secret: [u8; 32] = restored
        .device_secret
        .as_slice()
        .try_into()
        .expect("a restore hands a device secret over");
    let new_phone = phone_core(Path::new(&vault.path), secret);
    tokio::task::block_in_place(|| {
        // Read through Locker's own shelf statement, as the app does.
        let items = new_phone
            .with_vault(|vault| {
                Ok(vault.read(|connection| {
                    let door = TestDoor::new(connection);
                    let shelf =
                        locker_phone::load_items(&door, false, None).expect("the Live shelf reads");
                    Ok(shelf
                        .items
                        .iter()
                        .filter(|listed| listed.row.title == "Bank")
                        .count())
                })?)
            })
            .expect("the restored vault reads");
        assert_eq!(items, 1, "the Locker item's row came back");
        locker(
            &new_phone,
            wire::locker_session_request::Step::Unlock(wire::LockerUnlock {}),
        );
        let revealed = locker(
            &new_phone,
            wire::locker_session_request::Step::Reveal(wire::LockerReveal {
                item_id: "r3-bank".to_owned(),
                column: "password".to_owned(),
                ..wire::LockerReveal::default()
            }),
        )
        .revealed
        .expect("the restored phone opens what the lost one sealed");
        assert_eq!(revealed.value, "hunter22");
    });
    let_go(new_phone);

    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **A REFUSED RESTORE MOVES NOTHING** (#1047 R3).
///
/// The restore used to claim the lease at `held + 1` before it fetched or
/// checked anything, so a generation the new phone then refused had already
/// frozen the old phone as `VAULT_MOVED` — nothing restored on the new phone,
/// and the old one no longer allowed to back up. Here every object on the
/// laptop is damaged, the restore is refused, and the old phone's next drain
/// must still land under the lease it held.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_restore_leaves_the_lease_where_it_was() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old_phone, _old_file, gateway) = a_phone_that_used_locker(&dir).await;

    // DAMAGE EVERY OBJECT THE LAPTOP HOLDS. Whatever the restore opens first —
    // the manifest, a base range — will not open.
    damage(gateway._objects.path());

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    let refused = tokio::task::block_in_place(|| {
        phone::restore::run(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
        )
    })
    .expect_err("a generation that will not open is refused");
    eprintln!("the refusal: {refused}");
    // AND NOTHING IS LEFT ON THE NEW PHONE (#1047 L7): no `vault.db`, no
    // `-wal` or `-shm`, no object store and no directory a shell could list.
    assert_left_nothing(&new_root);

    // THE OLD PHONE STILL HOLDS THE LEASE. A write under its epoch lands; a
    // restore that had moved the lease would make this `VAULT_MOVED`.
    tokio::task::block_in_place(|| {
        command(
            &old_phone,
            "locker.add_item",
            &serde_json::json!({
                "item_id": "r3-after", "type": "password", "title": "After",
                "password": "still-mine"
            }),
        );
        let after = drain_handle(&old_phone);
        assert_eq!(
            after.stopped,
            wire::DrainStop::Empty as i32,
            "a refused restore froze the phone that still had the vault: {after:?}"
        );
    });
    let_go(old_phone);

    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Damage every object under `root` bigger than a header, so whatever a
/// restore opens first — the manifest, a base range — will not open.
fn damage(root: &Path) {
    let mut stack = vec![root.to_path_buf()];
    let mut damaged = 0;
    while let Some(at) = stack.pop() {
        for entry in std::fs::read_dir(&at).expect("the object directory reads") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 64) {
                let mut bytes = std::fs::read(&path).expect("an object reads");
                let middle = bytes.len() / 2;
                bytes[middle] ^= 0xFF;
                std::fs::write(&path, bytes).expect("an object is damaged");
                damaged += 1;
            }
        }
    }
    assert!(damaged > 0, "the laptop held no object to damage");
}

/// A refused restore leaves the new phone's directory exactly as empty as it
/// found it (#1047 L7).
fn assert_left_nothing(root: &Path) {
    let left: Vec<_> = std::fs::read_dir(root)
        .expect("the new phone's directory reads")
        .map(|entry| entry.expect("an entry").path())
        .collect();
    assert!(
        left.is_empty(),
        "a refused restore left files on the new phone: {left:?}"
    );
}

/// The words' keys at `index`, with the one device secret every vault on the
/// old phone shares.
fn keyring_at(index: u32) -> Keyring {
    let seed = RecoveryPhrase::parse(PHRASE).expect("the vector").seed();
    Keyring::derive(&seed, index, Some([0xD1_u8; 32])).expect("a fresh index")
}

fn identity_of(index: u32) -> Key32 {
    Key32::from_bytes(keyring_at(index).vault.identity.public().to_bytes())
}

/// One old phone's vault: its core and its file.
struct OldVault {
    handle: centraid_core::Handle,
    index: u32,
}

/// An old phone holding a vault at each of `indices`, each founded, paired
/// with one laptop that holds them all, and drained once — the member with
/// more than one vault that #1047 M1 found no test for.
async fn an_old_phone_with(dir: &Path, indices: &[u32]) -> (Vec<OldVault>, Live) {
    let mut state = SqliteState::in_memory().expect("a state file");
    for index in indices {
        let identity = identity_of(*index);
        register(
            &mut state,
            identity,
            identity,
            Plan::active(u64::MAX),
            false,
        )
        .await
        .expect("a registered vault");
    }
    let gateway = serving(state).await;
    let mut vaults = Vec::new();
    for index in indices {
        let keys = keyring_at(*index);
        let secret = [0xD1_u8; 32];
        let home = dir.join(format!("old-{index}"));
        std::fs::create_dir_all(&home).expect("the old phone's directory");
        let file = home.join("vault.db");
        let handle = centraid_core::Core::open(
            centraid_core::CoreConfig::new(&file)
                .with_seed(
                    RecoveryPhrase::parse(PHRASE).expect("the vector").seed(),
                    *index,
                )
                .with_device_secret(secret),
        )
        .expect("a core opens");
        handle
            .with_vault(|vault| {
                vault.found("A Household", "Ada")?;
                Ok(())
            })
            .expect("the phone founds its vault");
        pair_with(&file, &gateway, &keys, &secret).await;
        let old = OldVault {
            handle,
            index: *index,
        };
        assert!(write_and_drain(&old, 0), "vault {index}'s base lands");
        vaults.push(old);
    }
    (vaults, gateway)
}

/// Commit one row on the old phone and drain it. `true` when the laptop took
/// it — which it does only while this phone still holds the lease: a restore
/// that had moved it makes the drain `VAULT_MOVED`.
fn write_and_drain(old: &OldVault, row: usize) -> bool {
    tokio::task::block_in_place(|| {
        old.handle
            .with_vault(|vault| {
                centraid_vault::backup::drill::write_one(vault, 10_000 + row)?;
                Ok(())
            })
            .expect("the old phone commits");
        match old.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Drain(wire::DrainRequest {
                deadline_ms: 0,
                ..wire::DrainRequest::default()
            })),
        }) {
            Ok(wire::Response {
                kind: Some(wire::response::Kind::Drain(answer)),
                ..
            }) if answer.stopped == wire::DrainStop::Empty as i32 => true,
            other => {
                eprintln!("vault {}'s drain answered {other:?}", old.index);
                false
            }
        }
    })
}

/// Content items in the vault at `file`, by the census the restore checks.
fn content_items(file: &Path) -> i64 {
    centraid_vault::backup::drill::census(file)
        .expect("the census reads")
        .get("core_content_item")
        .copied()
        .unwrap_or(0)
}

fn let_go_all(vaults: Vec<OldVault>) {
    for old in vaults {
        let_go(old.handle);
    }
}

/// **A RESTORE THAT REFUSES ONE VAULT CLAIMS NONE** (#1047 M1).
///
/// A member with two vaults, the second damaged on the laptop. The restore
/// used to claim vault 0's lease the moment it checked, and then fail on vault
/// 1 — dropping the answer and the new device secret with it. The old phone
/// froze on vault 0 and the new phone held a file it could not drain. Every
/// vault is checked now before any lease moves, so the refusal leaves both
/// leases on the old phone, whose next drain lands on each.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restore_that_refuses_one_vault_claims_none() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old, gateway) = an_old_phone_with(&dir, &[0, 1]).await;
    damage(&gateway._objects.path().join(identity_of(1).hex()));

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    let refused = tokio::task::block_in_place(|| {
        phone::restore::run(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
        )
    })
    .expect_err("a vault that will not check refuses the restore");
    eprintln!("the refusal: {refused}");
    assert_left_nothing(&new_root);

    for (row, vault) in old.iter().enumerate() {
        assert!(
            write_and_drain(vault, 100 + row),
            "the refused restore moved vault {}'s lease off the old phone",
            vault.index
        );
    }
    let_go_all(old);
    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **A HEAD THAT MOVES BEFORE THE CLAIM IS CHECKED BEFORE IT IS TAKEN**
/// (#1047 L1).
///
/// The old phone commits in the window between the new phone's check and its
/// claim, and the generation that commit made is damaged. The claim used to
/// land first and lay the new head down after, so the lease moved and nothing
/// was restored. The claim names the head it checked now: the laptop refuses
/// it, the new phone re-reads and re-checks, the damaged head refuses the
/// restore, and the old phone still holds its lease.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_head_that_moves_to_a_damaged_generation_before_the_claim_moves_no_lease() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old, gateway) = an_old_phone_with(&dir, &[0]).await;
    let objects = gateway._objects.path().join(identity_of(0).hex());

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    let mut moved = false;
    let refused = tokio::task::block_in_place(|| {
        phone::restore::run_observed(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
            &mut |_| {
                if !moved {
                    moved = true;
                    // THE OLD PHONE COMMITS IN THE WINDOW, and what it made
                    // will not open.
                    assert!(write_and_drain(&old[0], 1), "the old phone's commit lands");
                    damage(&objects);
                }
            },
        )
    })
    .expect_err("a moved head that will not check refuses the restore");
    eprintln!("the refusal: {refused}");
    assert!(moved, "the restore never reached its claim");
    assert_left_nothing(&new_root);
    assert!(
        write_and_drain(&old[0], 2),
        "a moved head the new phone refused took the lease off the old phone"
    );
    let_go_all(old);
    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **A HEAD THAT MOVES BEFORE THE CLAIM IS THE HEAD RESTORED** (#1047 L1).
///
/// The same window, and a good generation in it: the new phone re-reads,
/// checks the new head, claims at it, and the commit the old phone made in
/// the window comes back. The old phone's next drain is `VAULT_MOVED`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_head_that_moves_to_a_good_generation_before_the_claim_is_the_one_restored() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old, gateway) = an_old_phone_with(&dir, &[0]).await;

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    let mut claims = 0;
    let restored = tokio::task::block_in_place(|| {
        phone::restore::run_observed(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
            &mut |_| {
                claims += 1;
                if claims == 1 {
                    assert!(write_and_drain(&old[0], 1), "the old phone's commit lands");
                }
            },
        )
    })
    .expect("a moved head that checks restores");
    assert_eq!(claims, 2, "the claim at the old head was refused, once");
    assert_eq!(restored.vaults.len(), 1);
    assert!(restored.unclaimed.is_empty());
    // The old phone's file holds every commit it made, the one in the window
    // included; the restored file must hold as many.
    let on_the_old_phone = content_items(&dir.join("old-0").join("vault.db"));
    assert_eq!(
        content_items(Path::new(&restored.vaults[0].path)),
        on_the_old_phone,
        "the commit made in the window came back"
    );
    assert!(
        !write_and_drain(&old[0], 2),
        "the old phone still writes to a vault the new one restored"
    );

    // AND THE RESTORED PHONE CARRIES ON (#1047 M1's "adopted"): its first
    // drain appends to the generation it restored — a restore used to keep no
    // head, so that drain founded a new generation the laptop refused as a
    // head conflict — and a third phone restores what it drained.
    let secret: [u8; 32] = restored
        .device_secret
        .as_slice()
        .try_into()
        .expect("a device secret");
    let adopted = OldVault {
        handle: phone_core(Path::new(&restored.vaults[0].path), secret),
        index: 0,
    };
    assert!(
        write_and_drain(&adopted, 3),
        "the restored phone's first drain did not land"
    );
    let_go(adopted.handle);
    let third = dir.join("third");
    std::fs::create_dir_all(&third).expect("a third phone's directory");
    let again = tokio::task::block_in_place(|| {
        phone::restore::run(
            &third.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
        )
    })
    .expect("what the restored phone drained restores");
    assert_eq!(
        content_items(Path::new(&again.vaults[0].path)),
        on_the_old_phone + 1,
        "the restored phone's drain came back"
    );

    let_go_all(old);
    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **A CLAIM THAT FAILS AFTER ANOTHER LANDED DROPS NEITHER** (#1047 M1).
///
/// Two vaults check; vault 0 is claimed; vault 1's head then moves to a
/// damaged generation before its claim. Refusing the whole restore would drop
/// vault 0 — claimed, the old phone frozen on it — with the device secret that
/// drains it. So vault 0 is answered and adopted: the new phone drains it
/// under the secret it was handed. Vault 1 is named `unclaimed`, nothing of it
/// is left on the new phone, and the old phone still drains it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claim_that_fails_after_another_landed_answers_the_claimed_vault() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old, gateway) = an_old_phone_with(&dir, &[0, 1]).await;
    let objects = gateway._objects.path().join(identity_of(1).hex());

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    let mut moved = false;
    let restored = tokio::task::block_in_place(|| {
        phone::restore::run_observed(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
            &mut |index| {
                if index == 1 && !moved {
                    moved = true;
                    assert!(write_and_drain(&old[1], 1), "vault 1's commit lands");
                    damage(&objects);
                }
            },
        )
    })
    .expect("a claimed vault is answered, not dropped");
    assert_eq!(
        restored.vaults.iter().map(|v| v.index).collect::<Vec<_>>(),
        vec![0],
        "vault 0 is answered"
    );
    assert_eq!(
        restored
            .unclaimed
            .iter()
            .map(|v| v.index)
            .collect::<Vec<_>>(),
        vec![1],
        "vault 1 is named, not skipped in silence"
    );
    assert!(
        !new_root.join(&identity_of(1).hex()[..16]).exists(),
        "nothing of the unclaimed vault is left on the new phone"
    );

    // VAULT 0 IS ADOPTED: the new phone drains it under the secret it was
    // handed, which is what the old code dropped.
    let secret: [u8; 32] = restored
        .device_secret
        .as_slice()
        .try_into()
        .expect("a device secret");
    let adopted = OldVault {
        handle: phone_core(Path::new(&restored.vaults[0].path), secret),
        index: 0,
    };
    assert!(
        write_and_drain(&adopted, 1),
        "the new phone cannot drain the vault it claimed"
    );
    // VAULT 1'S LEASE IS STILL THE OLD PHONE'S.
    assert!(
        write_and_drain(&old[1], 2),
        "an unclaimed vault's lease moved off the old phone"
    );
    let_go(adopted.handle);
    let_go_all(old);
    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **A VAULT THAT STAYED COMES BACK ON ITS OWN** (#1047 T1, R-1047-R6).
///
/// Vault 1's head keeps moving under every claim the first restore makes, so
/// it stays with the old phone while vault 0 is claimed, adopted and opened.
/// A second restore then names the indices (`RestoreRequest.indices`): vault 0
/// is skipped because this phone holds it — its file is not laid down again
/// under the open core, which goes on draining — and vault 1 alone is fetched,
/// checked and claimed. The old phone's next drain on vault 1 is then
/// `VAULT_MOVED`, and the new phone drains it under the secret the second
/// restore minted for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vault_that_stayed_comes_back_on_its_own_while_the_adopted_one_stays_open() {
    let dir = centraid_ontology::golden::scratch_dir();
    let (old, gateway) = an_old_phone_with(&dir, &[0, 1]).await;

    let new_root = dir.join("new");
    std::fs::create_dir_all(&new_root).expect("the new phone's directory");
    let runtime = tokio::runtime::Handle::current();
    // THE OLD PHONE COMMITS BEFORE EVERY ONE OF VAULT 1'S CLAIMS, so the head
    // it checked is never the head the laptop holds and the claim runs out.
    let mut raced = 0;
    let first = tokio::task::block_in_place(|| {
        phone::restore::run_observed(
            &new_root.join("vault.db"),
            &restore_request(&gateway),
            &runtime,
            &mut |index| {
                if index == 1 {
                    raced += 1;
                    assert!(write_and_drain(&old[1], raced), "vault 1's commit lands");
                }
            },
        )
    })
    .expect("a claimed vault is answered");
    assert_eq!(
        first.vaults.iter().map(|v| v.index).collect::<Vec<_>>(),
        vec![0]
    );
    assert_eq!(
        first.unclaimed.iter().map(|v| v.index).collect::<Vec<_>>(),
        vec![1],
        "vault 1 stayed"
    );

    // VAULT 0 IS ADOPTED AND OPEN.
    let first_secret: [u8; 32] = first
        .device_secret
        .as_slice()
        .try_into()
        .expect("a device secret");
    let vault_0 = Path::new(&first.vaults[0].path).to_path_buf();
    let adopted = OldVault {
        handle: phone_core(&vault_0, first_secret),
        index: 0,
    };
    assert!(
        write_and_drain(&adopted, 1),
        "vault 0 drains on the new phone"
    );
    let held_rows = content_items(&vault_0);

    // THE SECOND RESTORE NAMES THE INDICES, vault 0's among them, while vault
    // 0's core is open.
    let again = tokio::task::block_in_place(|| {
        phone::restore::run(
            &new_root.join("vault.db"),
            &wire::RestoreRequest {
                indices: vec![0, 1],
                ..restore_request(&gateway)
            },
            &runtime,
        )
    })
    .expect("the vault that stayed restores on its own");
    assert_eq!(
        again.vaults.iter().map(|v| v.index).collect::<Vec<_>>(),
        vec![1],
        "only vault 1 is answered; vault 0 is this phone's already"
    );
    assert!(again.unclaimed.is_empty());
    assert_eq!(again.gap_scanned, 0, "a named restore scans no gap");
    assert_ne!(
        again.device_secret, first.device_secret,
        "a restore mints for the vaults it answers"
    );

    // VAULT 0 WAS NOT TOUCHED: its open core commits and drains as before.
    assert_eq!(
        content_items(&vault_0),
        held_rows,
        "vault 0 was laid down again"
    );
    assert!(
        write_and_drain(&adopted, 2),
        "vault 0 stopped draining after the second restore"
    );

    // VAULT 1 MOVED: the old phone is fenced, the new one drains it.
    assert!(
        !write_and_drain(&old[1], 100),
        "the old phone still writes vault 1"
    );
    let second_secret: [u8; 32] = again
        .device_secret
        .as_slice()
        .try_into()
        .expect("a device secret");
    let vault_1 = OldVault {
        handle: centraid_core::Core::open(
            centraid_core::CoreConfig::new(&again.vaults[0].path)
                .with_seed(RecoveryPhrase::parse(PHRASE).expect("the vector").seed(), 1)
                .with_device_secret(second_secret),
        )
        .expect("a core opens"),
        index: 1,
    };
    assert!(
        write_and_drain(&vault_1, 200),
        "vault 1 drains on the new phone"
    );

    let_go(vault_1.handle);
    let_go(adopted.handle);
    let_go_all(old);
    drop(gateway);
    let _ = std::fs::remove_dir_all(&dir);
}
