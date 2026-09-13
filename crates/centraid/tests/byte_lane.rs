//! A REAL SEAT FETCHES A PHOTOGRAPH FROM THE REAL GATEWAY (#1020, D-1020-B1).
//!
//! `crates/blobs/tests/windows.rs` proves the transfer law against a gateway
//! written inside the test. This one spawns the shipped binary and fetches a
//! blob the binary is serving out of its own store, because what is under test
//! here is the wiring in `run.rs` and nothing else.
//!
//! **It exists because the wiring was wrong the first time and only the
//! compiler noticed.** The accept loop's seat arm was an unguarded
//! `Ok(Some(accepted))`, so it matched every lane that was not `PAIR` — the
//! byte arm added beside it was unreachable, and a `centraid/v1/byte`
//! connection would have been handed to the envelope reader, which would have
//! tried to parse iroh-blobs' protocol as a length-framed frame. An
//! `unreachable pattern` warning caught it. Nothing at runtime would have, and
//! nothing in `crates/blobs` could have: every test there serves the lane
//! itself.
//!
//! ## The blob goes into the VAULT'S OWN CAS, not into the byte store
//!
//! Since D-1020-B2 the content CAS is BLAKE3-named, so the gateway takes it
//! into the byte store in place at startup and the file's own name is the hash
//! a seat asks for. Seeding the CAS therefore tests the real path — a
//! photograph minted by a command is servable without any further step — where
//! seeding the byte store directly would have tested only the transport.
//!
//! The vault is founded by the TEST and the binary then opens it, because both
//! stores are single-writer and the running gateway holds them.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_api_proto::core_v1::pair_response;
use centraid_blobs::{ByteStore, ContentHash, Holding};
use centraid_net::endpoint::{Endpoint, EndpointConfig};
use centraid_net::{pairing, ticket};
use centraid_protocol::alpn;

const READY_LINE: &str = "centraid gateway ready";

struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawn the binary and read back its ticket. See `seat_lane.rs` for why the
/// stdout reader must drain for the whole run rather than stop at the ticket.
fn start(data_dir: &std::path::Path) -> Option<(Gateway, String)> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .arg("gateway")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--print-qr")
        .arg("--no-relay")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the gateway binary runs");
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = false;
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with(READY_LINE) {
                ready = true;
            }
            if let Some(encoded) = line.strip_prefix("ticket ")
                && ready
                && !sent
            {
                sent = true;
                let _ = tx.send(encoded.trim().to_owned());
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(encoded) => Some((Gateway(child), encoded)),
        Err(_) => None,
    }
}

/// 2 MiB, so the transfer spans many chunk groups and is still quick. The law
/// about interruption is `crates/blobs`' to prove; this one is about reach.
fn a_photograph() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 * 1024 * 1024);
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    while bytes.len() < 2 * 1024 * 1024 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paired_seat_fetches_a_blob_from_the_gateways_own_store() {
    let data_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    let photograph = a_photograph();

    // FOUND THE VAULT AND SEED ITS CAS, then let go of both. The layout is the
    // one `cmd::sole_vault_file` looks for, so the binary opens this vault
    // rather than founding another.
    let vault_file = data_dir.path().join("vault").join("v1").join("vault.db");
    std::fs::create_dir_all(vault_file.parent().expect("a parent")).expect("the layout is made");
    let hash = {
        use centraid_vault::backup::store::BlobStore as _;
        let vault = centraid_vault::Vault::create(&vault_file).expect("a vault is created");
        vault
            .found("Byte Lane", "Test Owner")
            .expect("it is founded");
        let cas = centraid_vault::backup::store::FsBlobStore::open_content(
            centraid_vault::Vault::blobs_root_for(&vault_file),
        )
        .expect("the content CAS opens");
        let named = cas.put(&photograph).expect("the CAS takes the photograph");
        drop(vault);
        ContentHash::parse_hex(&named).expect("the CAS names blobs in hex")
    };
    // THE CAS AND THE BYTE PLANE AGREE ON THE NAME. This is the whole of
    // D-1020-B2 in one assertion: if the vault named its bytes any other way,
    // the gateway's import would file them under a hash no seat ever asks for.
    assert_eq!(
        hash,
        ContentHash::of(&photograph),
        "the vault's CAS does not name bytes the way the byte plane does"
    );

    let Some((_gateway, encoded)) = start(data_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };
    let scanned = ticket::decode(&encoded).expect("the printed ticket decodes");

    let seat = Endpoint::spawn(EndpointConfig::default())
        .await
        .expect("the seat binds");
    let paired = pairing::redeem(&seat, &scanned, "Test Seat", "ios")
        .await
        .expect("the pair lane answered");
    match paired.result.expect("a result") {
        pair_response::Result::Ok(ok) => assert!(!ok.vault_id.is_empty()),
        pair_response::Result::Error(error) => panic!("the gateway refused the ticket: {error:?}"),
    }

    let gateway_endpoint: [u8; 32] = scanned
        .gateway_endpoint
        .as_slice()
        .try_into()
        .expect("a ticket names a 32-byte endpoint");
    let connection = seat
        .connect(gateway_endpoint, None, &scanned.direct_addrs, alpn::BYTE)
        .await
        .expect("the byte lane admits the device it just enrolled");

    let seat_store = ByteStore::open(seat_dir.path().join("blobs"))
        .await
        .expect("the seat's store opens");
    assert_eq!(
        seat_store.holding(hash).await.expect("the store answers"),
        Holding::Missing,
        "the seat starts with nothing"
    );

    let report = tokio::time::timeout(
        Duration::from_secs(30),
        centraid_blobs::fetch(&seat_store, connection.iroh(), hash),
    )
    .await
    .expect("the fetch finished inside 30s")
    .expect("the gateway served the byte lane");

    assert!(report.complete, "the blob did not arrive whole: {report:?}");
    assert_eq!(report.held_before, 0, "the seat held nothing to begin with");

    // AND THE BYTES ARE THE BYTES, fetched from a process that founded its own
    // vault, opened its own store and routed its own ALPN.
    let out = seat_dir.path().join("recovered.bin");
    seat_store
        .export(hash, &out)
        .await
        .expect("the seat exports");
    let recovered = std::fs::read(&out).expect("the exported file reads");
    assert!(recovered == photograph, "the recovered photograph differs");

    seat.close().await;
}
