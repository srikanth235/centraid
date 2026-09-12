//! The device allowlist, as a trait (#1020, **D-1020-C8**).
//!
//! **Why a trait and not a SQLite file here.** The natural design is a small
//! SQLite database owned by `net` with two tables, `devices` and `tickets`,
//! written in one transaction so that redemption burns the ticket and enrols
//! the device atomically — which is exactly what v0's `redeemAndEnroll` does
//! (`packages/server/src/serve/pairing-store.ts:98-105`), and what makes "a
//! failure anywhere leaves zero enrolment, never a half-paired device" true.
//!
//! That design cannot live in this crate: #1020's `sql-confinement` invariant
//! puts SQL only under `crates/{ontology,vault,seat,search}` and
//! `crates/apps/kit`, and `crates/net` is none of them. Weakening the rule to
//! admit one more crate would be weakening a gate to fit a design, so the
//! design moves instead:
//!
//! * **This crate** defines [`AllowlistStore`] and ships [`MemoryAllowlist`],
//!   which is what the tests and a `--data-dir`-less `centraid gateway` run on.
//! * **`crates/vault` (lane D1)** lands the durable implementation behind the
//!   same trait, in the crate that is allowed to hold the transaction.
//!
//! The trait is therefore written to be implementable transactionally: every
//! method that changes two facts at once takes them in ONE call
//! ([`AllowlistStore::redeem`] burns the ticket and enrols the device together)
//! rather than leaving a caller to sequence two writes and a window where a
//! crash half-pairs a phone.
//!
//! **Only a hash of the ticket secret is stored.** The secret travels in the
//! QR, is read off a screen by a camera, and survives in a photo roll; a
//! gateway that kept it could hand out the same pairing twice from its own
//! backup. v0 stores `secret_hash` for the same reason
//! (`packages/server/src/serve/gateway-schema.ts:98-111`).

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Mutex;

use sha2::{Digest as _, Sha256};

/// An enrolled device.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Device {
    /// The iroh EndpointId, 32 raw bytes. The PROVED identity — iroh's TLS
    /// handshake is what proves it, so nothing the caller says enters here
    /// (v0's `devices` table is "a pure binding of a proved iroh EndpointId",
    /// `packages/server/src/serve/gateway-schema.ts:46-71`).
    pub endpoint_id: [u8; 32],
    /// The vault-side `access_device.device_id`.
    pub device_id: String,
    pub label: String,
    pub platform: String,
    /// Milliseconds since the epoch.
    pub enrolled_at_ms: u64,
    /// `Some` means revoked. A TOMBSTONE, not a deletion: a revoked device that
    /// re-presents its key must be refused for the same reason twice, and a
    /// deleted row would make it look new
    /// (`packages/server/src/serve/enrollment-store.ts:474-483`).
    pub revoked_at_ms: Option<u64>,
}

impl Device {
    /// Enrolled and not revoked. The one question the seat lane asks.
    pub fn is_live(&self) -> bool {
        self.revoked_at_ms.is_none()
    }
}

/// A minted, unredeemed ticket.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ticket {
    pub ticket_id: String,
    /// `sha256(secret)`. The secret itself is never stored.
    pub secret_hash: [u8; 32],
    pub expires_at_ms: u64,
    /// `Some` means burnt. Kept rather than deleted so a replayed QR is
    /// answered "expired" rather than "never existed", which is the same
    /// refusal a member can act on and no more.
    pub redeemed_at_ms: Option<u64>,
}

/// `sha256` of a ticket secret.
pub fn secret_hash(secret: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret);
    hasher.finalize().into()
}

/// Why a redemption was refused. Deliberately coarse, matching
/// `PairErrorCode`: a member holding a screenshot of an old QR must not learn
/// from the answer whether the ticket ever existed.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RedeemRefusal {
    /// No such ticket, or the secret does not hash to the stored hash.
    InvalidCode,
    /// The ticket existed and its TTL has passed, or it was already burnt.
    ExpiredCode,
}

/// The gateway's own pairing and enrolment state.
///
/// Every method is `async` so the durable implementation can be — a trait whose
/// methods are synchronous cannot be implemented over an async connection pool
/// without blocking a core thread.
pub trait AllowlistStore: Send + Sync {
    /// Record a minted ticket.
    fn mint(&self, ticket: Ticket) -> impl Future<Output = ()> + Send;

    /// Burn the ticket and enrol the device, **in one call**, so an
    /// implementation can do it in one transaction. A refusal leaves both
    /// facts untouched.
    fn redeem(
        &self,
        ticket_id: &str,
        secret: &[u8],
        device: Device,
        now_ms: u64,
    ) -> impl Future<Output = Result<Device, RedeemRefusal>> + Send;

    /// The device this endpoint id is, live or tombstoned. `None` means never
    /// enrolled — and for the seat lane's admission decision, `None` and a
    /// tombstoned row are the SAME refusal (`identity.ts:27-35`).
    fn device(&self, endpoint_id: &[u8; 32]) -> impl Future<Output = Option<Device>> + Send;

    /// Every device, tombstones included: the device list is what renders a
    /// revoked phone as revoked rather than as absent.
    fn devices(&self) -> impl Future<Output = Vec<Device>> + Send;

    /// Tombstone a device by device id or by hex endpoint id (v0 accepts
    /// either). Returns the device as it now stands, or `None` if no such
    /// device. Revoking an already-revoked device is idempotent and keeps the
    /// FIRST tombstone's timestamp — the moment authority was withdrawn is a
    /// fact, and a second call must not move it.
    fn revoke(&self, device: &str, now_ms: u64) -> impl Future<Output = Option<Device>> + Send;
}

/// The in-memory implementation: what the tests and a gateway with no data
/// directory run on. Not durable, and it says so — `centraid gateway` without
/// `--data-dir` prints that every pairing is lost on exit.
#[derive(Debug, Default)]
pub struct MemoryAllowlist {
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    devices: BTreeMap<[u8; 32], Device>,
    tickets: BTreeMap<String, Ticket>,
}

impl MemoryAllowlist {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enrol a device without a ticket. Test-and-bootstrap only, and named so
    /// that it cannot be mistaken for the pairing path.
    pub fn enroll_without_a_ticket(&self, device: Device) {
        self.state
            .lock()
            .expect("the allowlist mutex")
            .devices
            .insert(device.endpoint_id, device);
    }
}

impl AllowlistStore for MemoryAllowlist {
    async fn mint(&self, ticket: Ticket) {
        self.state
            .lock()
            .expect("the allowlist mutex")
            .tickets
            .insert(ticket.ticket_id.clone(), ticket);
    }

    async fn redeem(
        &self,
        ticket_id: &str,
        secret: &[u8],
        device: Device,
        now_ms: u64,
    ) -> Result<Device, RedeemRefusal> {
        let mut state = self.state.lock().expect("the allowlist mutex");
        let ticket = state
            .tickets
            .get(ticket_id)
            .ok_or(RedeemRefusal::InvalidCode)?;
        // Constant-time comparison is not what protects this: the secret is
        // 128 bits of randomness and a timing oracle over a hash comparison
        // leaks nothing usable. What protects it is that only the HASH is
        // here, so a compromised store cannot mint a second pairing.
        if ticket.secret_hash != secret_hash(secret) {
            return Err(RedeemRefusal::InvalidCode);
        }
        if ticket.redeemed_at_ms.is_some() || ticket.expires_at_ms <= now_ms {
            return Err(RedeemRefusal::ExpiredCode);
        }
        // One critical section: the burn and the enrolment cannot be observed
        // apart, which is what the durable implementation will get from a
        // transaction.
        let mut burnt = ticket.clone();
        burnt.redeemed_at_ms = Some(now_ms);
        state.tickets.insert(ticket_id.to_owned(), burnt);
        state.devices.insert(device.endpoint_id, device.clone());
        Ok(device)
    }

    async fn device(&self, endpoint_id: &[u8; 32]) -> Option<Device> {
        self.state
            .lock()
            .expect("the allowlist mutex")
            .devices
            .get(endpoint_id)
            .cloned()
    }

    async fn devices(&self) -> Vec<Device> {
        self.state
            .lock()
            .expect("the allowlist mutex")
            .devices
            .values()
            .cloned()
            .collect()
    }

    async fn revoke(&self, device: &str, now_ms: u64) -> Option<Device> {
        let mut state = self.state.lock().expect("the allowlist mutex");
        let key = state.devices.iter().find_map(|(id, held)| {
            (held.device_id == device || hex_lower(id) == device.to_lowercase()).then_some(*id)
        })?;
        let held = state.devices.get_mut(&key)?;
        if held.revoked_at_ms.is_none() {
            held.revoked_at_ms = Some(now_ms);
        }
        Some(held.clone())
    }
}

/// Lowercase hex. Hand-rolled rather than pulling `hex` in: the only use is the
/// device-id spelling in the CLI and the two lines below.
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).expect("a nibble"));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("a nibble"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL_MS: u64 = 15 * 60 * 1000;

    fn device(endpoint: u8) -> Device {
        Device {
            endpoint_id: [endpoint; 32],
            device_id: format!("dev_{endpoint}"),
            label: "A Phone".to_owned(),
            platform: "ios".to_owned(),
            enrolled_at_ms: 1_000,
            revoked_at_ms: None,
        }
    }

    async fn with_ticket(secret: &[u8], expires_at_ms: u64) -> MemoryAllowlist {
        let store = MemoryAllowlist::new();
        store
            .mint(Ticket {
                ticket_id: "tkt_1".to_owned(),
                secret_hash: secret_hash(secret),
                expires_at_ms,
                redeemed_at_ms: None,
            })
            .await;
        store
    }

    #[tokio::test]
    async fn a_redemption_enrols_the_device_and_burns_the_ticket() {
        let store = with_ticket(b"secret", TTL_MS).await;
        let enrolled = store
            .redeem("tkt_1", b"secret", device(1), 1_000)
            .await
            .expect("redeemed");
        assert!(enrolled.is_live());
        assert_eq!(
            store.device(&[1u8; 32]).await.expect("enrolled").device_id,
            "dev_1"
        );

        // The burn: the same QR again is refused, and a member who screenshotted
        // it is told "expired" rather than "invalid", because the ticket did
        // exist.
        assert_eq!(
            store
                .redeem("tkt_1", b"secret", device(2), 1_001)
                .await
                .expect_err("burnt"),
            RedeemRefusal::ExpiredCode
        );
        assert!(store.device(&[2u8; 32]).await.is_none());
    }

    #[tokio::test]
    async fn a_wrong_secret_and_an_unknown_ticket_are_the_same_refusal() {
        let store = with_ticket(b"secret", TTL_MS).await;
        assert_eq!(
            store
                .redeem("tkt_1", b"wrong", device(1), 1_000)
                .await
                .expect_err("refused"),
            RedeemRefusal::InvalidCode
        );
        assert_eq!(
            store
                .redeem("tkt_missing", b"secret", device(1), 1_000)
                .await
                .expect_err("refused"),
            RedeemRefusal::InvalidCode
        );
        assert!(
            store.device(&[1u8; 32]).await.is_none(),
            "a refusal leaves zero enrolment"
        );
    }

    /// TTL is 15 minutes and the edge is exclusive: at exactly the expiry the
    /// ticket is gone. An inclusive edge would leave a one-millisecond window
    /// whose behaviour nobody could state.
    #[tokio::test]
    async fn an_expired_ticket_is_refused_at_its_own_edge() {
        let store = with_ticket(b"secret", TTL_MS).await;
        assert_eq!(
            store
                .redeem("tkt_1", b"secret", device(1), TTL_MS)
                .await
                .expect_err("expired"),
            RedeemRefusal::ExpiredCode
        );
        let store = with_ticket(b"secret", TTL_MS).await;
        assert!(
            store
                .redeem("tkt_1", b"secret", device(1), TTL_MS - 1)
                .await
                .is_ok()
        );
    }

    /// Only the hash is stored. The test looks for the secret's bytes in the
    /// stored ticket and fails if it finds them — which is the shape of v0's
    /// snapshot canary test, and the only way to assert an absence.
    #[tokio::test]
    async fn the_secret_itself_is_never_stored() {
        let secret = b"a-very-distinctive-secret";
        let store = with_ticket(secret, TTL_MS).await;
        let held = store
            .state
            .lock()
            .expect("the mutex")
            .tickets
            .get("tkt_1")
            .cloned()
            .expect("minted");
        assert_ne!(held.secret_hash.as_slice(), secret.as_slice());
        assert_eq!(held.secret_hash, secret_hash(secret));
        assert!(
            !format!("{held:?}").contains("distinctive"),
            "the secret reached the store"
        );
    }

    /// Revocation is a tombstone, and revoking twice keeps the FIRST moment.
    /// The withdrawal of authority is a fact with a time, and a second call
    /// must not move it.
    #[tokio::test]
    async fn revocation_tombstones_once_and_is_reachable_by_either_name() {
        let store = MemoryAllowlist::new();
        store.enroll_without_a_ticket(device(7));

        let revoked = store.revoke("dev_7", 5_000).await.expect("revoked");
        assert_eq!(revoked.revoked_at_ms, Some(5_000));
        assert!(!revoked.is_live());
        assert_eq!(
            store
                .revoke("dev_7", 9_999)
                .await
                .expect("idempotent")
                .revoked_at_ms,
            Some(5_000)
        );

        // By hex endpoint id, which is what `centraid devices revoke` may be
        // handed.
        store.enroll_without_a_ticket(device(8));
        let by_hex = hex_lower(&[8u8; 32]);
        assert!(
            store
                .revoke(&by_hex, 6_000)
                .await
                .expect("revoked")
                .revoked_at_ms
                .is_some()
        );
        assert!(store.revoke("nobody", 1).await.is_none());
    }

    /// A tombstone stays in the device list. Rendering a revoked phone as
    /// absent is how a member cannot tell whether the revocation worked.
    #[tokio::test]
    async fn a_revoked_device_stays_in_the_list() {
        let store = MemoryAllowlist::new();
        store.enroll_without_a_ticket(device(1));
        store.revoke("dev_1", 5_000).await.expect("revoked");
        let listed = store.devices().await;
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].is_live());
        assert!(
            store.device(&[1u8; 32]).await.is_some(),
            "the row is a tombstone, not a deletion"
        );
    }

    #[test]
    fn hex_is_lowercase_and_two_characters_per_byte() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xab, 0xff]), "000fabff");
        assert_eq!(hex_lower(&[7u8; 32]).len(), 64);
    }
}
