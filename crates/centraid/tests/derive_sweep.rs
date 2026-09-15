//! THE BACKFILL SWEEP ACTUALLY RUNS (#1025 S7, the verifier's finding).
//!
//! Slice 3 built `media.derive_missing` and proved it at the vault's own door
//! (`crates/vault/tests/derivatives.rs`). What no test covered was the ONE
//! caller the command has: `Handle::derive_missing_tiers`, which the gateway
//! runs at every start. Its guard read
//!
//! ```text
//! if !self.is_gateway() || self.holds_a_replica() { return Ok(0); }
//! ```
//!
//! and `holds_a_replica()` is `self.vault.lock().is_some()` — TRUE OF A
//! GATEWAY, whose vault is the one thing it certainly has open. So the second
//! clause fired on every gateway, the sweep answered `Ok(0)` at every start,
//! and the backfill never ran once. Two green suites either side of a guard
//! that let nothing through.
//!
//! This test is therefore deliberately THROUGH THE HANDLE, over a real byte
//! store, and it is here rather than in `crates/core` because that crate's
//! dev-dependencies carry neither a tokio runtime nor a real photograph — and
//! `ContentBytes` needs both.

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig};

/// A REAL PHOTOGRAPH, from this repository's own sample roll.
///
/// It has to decode: `derive_image_tiers` returns `Ok(0)` with a `warn` for
/// bytes no decoder accepts, so a synthetic PNG header would make this test
/// pass against a sweep that did nothing — which is the exact failure mode
/// being closed.
const A_PHOTOGRAPH: &[u8] =
    include_bytes!("../../../contracts/apps/photos/sample/tahoe-dusk-ridge.png");

fn data_uri(bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Open a gateway core at `path` with `store` attached.
///
/// The same two steps and the same order as `run.rs`: the core first, because
/// opening one is synchronous, then `attach_bytes`, because opening the store
/// is not. The store is passed IN and cloned rather than reopened, because this
/// test opens two cores over one directory in sequence and a second
/// `ByteStore::open` over a live one would be a second writer to its index.
fn gateway_with_bytes(
    path: &std::path::Path,
    store: &centraid_blobs::ByteStore,
) -> centraid_core::Handle {
    let handle = Core::open(CoreConfig::gateway(path)).expect("the gateway core opens");
    handle.attach_bytes(centraid_blobs::ContentBytes::new(
        store.clone(),
        tokio::runtime::Handle::current(),
    ));
    handle
}

/// The derivative tiers this vault file holds, read off the file directly.
fn variants(path: &std::path::Path) -> Vec<String> {
    let connection = rusqlite::Connection::open(path).expect("the vault file opens");
    centraid_vault::testdoor::derivative_variants(&connection)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gateway_start_derives_the_tiers_a_vault_is_missing() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let vault_path = dir.path().join("vault.db");
    let blobs_path = dir.path().join("vault.bytes");

    // ---- 1. A VAULT WITH ONE PHOTOGRAPH IN IT ----------------------------
    let store = centraid_blobs::ByteStore::open(&blobs_path)
        .await
        .expect("the byte store opens");
    let handle = gateway_with_bytes(&vault_path, &store);
    handle
        .with_vault(|vault| Ok(vault.found("Sweep", "Owner")?))
        .expect("the vault founds");
    let owner = handle
        .with_vault(|vault| Ok(vault.self_party_id()?))
        .expect("the owner reads");
    handle
        .with_vault(|vault| Ok(vault.enrol_device("d1", &owner, "A Phone", "ios", "pk-1")?))
        .expect("the device enrols");

    let input = serde_json::json!({
        "data_uri": data_uri(A_PHOTOGRAPH),
        "kind": "photo",
        "title": "Tahoe, dusk",
    });
    // THE PAYLOAD HASH IS THE SUBMITTER'S, not the door's: `submit_intent` is
    // the GATEWAY's side and a hash that does not reproduce is refused there.
    // (A shell's own `queue_write` is the opposite — it refuses a declared one
    // and computes its own, D-1025-S4-6.)
    let payload = centraid_vault::intents::IntentPayload {
        app_id: "media".to_owned(),
        action: "add_asset".to_owned(),
        input: input.clone(),
        base_versions: Vec::new(),
        depends_on: Vec::new(),
        needs: Vec::new(),
    };
    let outcome = handle
        .submit_intent(
            &wire::Intent {
                intent_id: "i-1".to_owned(),
                app_id: "media".to_owned(),
                action: "add_asset".to_owned(),
                input: serde_json::to_vec(&input).expect("the input encodes"),
                payload_hash: payload.hash().expect("the payload hashes"),
                ..Default::default()
            },
            "d1",
        )
        .expect("the gateway runs the intent");
    assert_eq!(
        outcome.status,
        wire::IntentStatus::Executed as i32,
        "the photograph did not commit: {outcome:?}"
    );

    // The mint derives inside its own transaction, so the tiers are here now.
    // Asserted BEFORE they are taken away, so that the state this test builds
    // is a state the product really produces.
    handle.close();
    drop(handle);
    assert_eq!(
        variants(&vault_path),
        vec!["preview".to_owned(), "thumb".to_owned()],
        "the mint itself derived nothing, so this test could not tell a working \
         sweep from a broken one"
    );

    // ---- 2. A VAULT FOUNDED BEFORE THE GATEWAY MADE TIERS -----------------
    //
    // Taken away on the FILE, with the core closed, so what the sweep then
    // opens is an ordinary old vault and not a connection this test has been
    // holding open. There is no door that mints an original WITHOUT its tiers
    // — they are written inside the mint's own transaction — so making one and
    // forgetting them is the only way to build the state the backfill exists
    // for.
    {
        let connection = rusqlite::Connection::open(&vault_path).expect("the vault file opens");
        assert_eq!(
            centraid_vault::testdoor::forget_derivatives(&connection),
            2
        );
    }
    assert!(variants(&vault_path).is_empty());

    // ---- 3. THE SWEEP, AT A GATEWAY START, THROUGH THE HANDLE -------------
    let handle = gateway_with_bytes(&vault_path, &store);
    let derived = handle
        .derive_missing_tiers(centraid_vault::commands::media::DERIVE_SWEEP_LIMIT)
        .expect("the sweep runs");
    assert_eq!(
        derived, 1,
        "the sweep reported no items; this is the `Ok(0)` the guard used to \
         return at every gateway start"
    );
    assert_eq!(
        variants(&vault_path),
        vec!["preview".to_owned(), "thumb".to_owned()],
        "the sweep ran and the tiers did not come back"
    );

    // ---- 4. AND IT IS RESUMABLE: A SWEPT VAULT SELECTS NOTHING ------------
    assert_eq!(
        handle
            .derive_missing_tiers(centraid_vault::commands::media::DERIVE_SWEEP_LIMIT)
            .expect("the second sweep runs"),
        0,
        "a second start re-derived what the first one had already made"
    );
    handle.close();
}

/// A SEAT STILL ANSWERS ZERO, which is the half of the guard that was right.
///
/// The derivative is a gateway-derived fact that reaches a replica as ordinary
/// log rows; a seat running the sweep would be a second writer over rows the
/// applier then overwrites. The fix narrowed the guard and must not have
/// widened it.
#[tokio::test(flavor = "multi_thread")]
async fn a_seat_sweeps_nothing() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("seat.db");
    let made = Core::open(CoreConfig::gateway(&path)).expect("opens");
    made.with_vault(|vault| Ok(vault.found("Sweep", "Owner")?))
        .expect("founds");
    made.close();
    drop(made);

    let seat = Core::open(CoreConfig::thin_seat(&path)).expect("the seat opens");
    assert_eq!(
        seat.derive_missing_tiers(centraid_vault::commands::media::DERIVE_SWEEP_LIMIT)
            .expect("answers"),
        0
    );
}
