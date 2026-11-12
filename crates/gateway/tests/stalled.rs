//! A GATEWAY THAT GOES SILENT UNDER A LIVE CONNECTION (#1188, item 8).
//!
//! A sleeping laptop or a network that changed leaves the connection open and answers nothing.
//! Only the connect and the handshake were bounded; a call after that waited for the kernel's
//! TCP timeout, and Cancel was looked at only between calls. The client now bounds the wait
//! for headers and between chunks of a body, and a call watches its stop while it waits.
//!
//! Nothing here sleeps or asserts on seconds: the limits are injected small, the cable is
//! stalled (open, silent) and a call that waits for ever is the failure.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use centraid_gateway::client::{Client, ClientError, Limits, Stop};
use centraid_gateway::rules::ids::{Token, VaultId};
use centraid_gateway::rules::wire::{PairKind, PairRequest};
use centraid_gateway::server::harness::{Spawned, spawn};

async fn paired(gateway: &Spawned) -> (VaultId, Client) {
    let identity = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let paired = gateway
        .first_contact()
        .pair(&PairRequest {
            vault_id: vault,
            label: "a phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(gateway.mint_pairing_secret()),
            claim: None,
            read: None,
        })
        .await
        .expect("pairs");
    let token: Token = paired.token;
    (vault, gateway.client(token))
}

fn tiny() -> Limits {
    Limits {
        header: Duration::from_millis(20),
        idle: Duration::from_millis(20),
        poll: Duration::from_millis(1),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gateway_that_goes_silent_ends_a_call_instead_of_holding_it() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, client) = paired(&gateway).await;
    // A healthy call first, so the connection is live and kept.
    client.head_state(&vault).await.expect("answers");

    gateway.cable().stall();
    client.set_limits(tiny());
    let error = client
        .head_state(&vault)
        .await
        .expect_err("a silent gateway is not waited for ever");
    assert!(
        matches!(&error, ClientError::Unreachable(why) if why.contains("stopped answering")),
        "{error:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_is_observed_while_a_call_waits_on_a_silent_gateway() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, client) = paired(&gateway).await;
    client.head_state(&vault).await.expect("answers");

    gateway.cable().stall();
    // The limits are long: only the stop can end this call. It is raised on the third look, so
    // it is seen while the call is already waiting, not before it starts.
    client.set_limits(Limits {
        header: Duration::from_secs(3600),
        idle: Duration::from_secs(3600),
        poll: Duration::from_millis(1),
    });
    let looks = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&looks);
    let stop: Stop = Arc::new(move || seen.fetch_add(1, Ordering::SeqCst) >= 2);
    client.set_stop(Some(stop));
    let error = client
        .head_state(&vault)
        .await
        .expect_err("a cancel ends the wait");
    assert!(
        matches!(&error, ClientError::Io(io) if io.kind() == std::io::ErrorKind::Interrupted),
        "{error:?}"
    );
    assert!(looks.load(Ordering::SeqCst) >= 3, "it looked while waiting");
}
