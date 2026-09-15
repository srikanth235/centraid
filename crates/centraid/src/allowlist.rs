//! THE GATEWAY'S ALLOWLIST, AND IT SURVIVES A RESTART (#1025 S7,
//! **D-1025-S7-8x**, superseding D-1020-C8's placeholder).
//!
//! ## The defect this exists for
//!
//! `centraid gateway` held its enrolments in [`MemoryAllowlist`] and printed a
//! line saying so. Every pairing was lost on exit: a member paired a phone,
//! restarted the gateway for any ordinary reason, and the phone — holding a
//! durable identity, a vault id and a replica — was refused as a peer the
//! gateway had never seen. The phone could not tell that from a revocation,
//! because **unknown and revoked are one refusal**, which is right for a
//! stranger and wrong for a device the member had enrolled the day before.
//!
//! ## Where enrolment lives, and why nothing new was added to hold it
//!
//! The vault already had the tables. `access_device` is the member's device
//! list (replicated) and `access_device_secret` is its private sibling holding
//! the public key — `UNIQUE`, so it is *already* the index a proved iroh
//! EndpointId is looked up by. `centraid devices list` and `centraid devices
//! revoke` have always read and written exactly these rows through the
//! [`Handle`]; the gateway's admission question was the one reader that did
//! not. One store now answers both, so revoking a phone in the member's own
//! device list is the same act as refusing it at the door.
//!
//! **SQL stays in `crates/vault`** (the `sql-confinement` invariant): every
//! statement this file needs is a method on `Vault` (`crates/vault/src/
//! devices.rs`). This module holds no SQL — it is the adapter from
//! `crates/net`'s [`AllowlistStore`] vocabulary (endpoint ids, tombstones,
//! tickets) to the vault's (device rows and their private key sibling).
//!
//! ## Two deliberate differences from [`MemoryAllowlist`]
//!
//! 1. **Tickets are NOT durable.** A pairing code is a fifteen-minute artifact
//!    on a screen; a gateway restart invalidates the QR being held up at it,
//!    which is the conservative outcome and the one a member can act on (mint
//!    another). Making them durable would mean a ticket minted before a crash
//!    could still be redeemed after it, which is a longer-lived secret for no
//!    gain. The burn and the enrolment still happen under ONE lock, so they are
//!    never observed apart.
//! 2. **A revoked device is a DELETION, not a tombstone in this store.**
//!    Revoking deletes the private key sibling and keeps the replicated row, so
//!    the member's list still renders the device and this store no longer finds
//!    it — the vault's design, and the reason there is no "revoked" state to
//!    forget to check for (`crates/vault/src/devices.rs` header). Admission is
//!    unchanged: unknown and revoked are one refusal. [`Self::devices`] is
//!    therefore the LIVE list; the member's list, tombstones and all, is
//!    `DevicesList` through the [`Handle`], which is where a screen reads it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use centraid_core::Handle;
use centraid_net::allowlist::{
    AllowlistStore, Device, MemoryAllowlist, RedeemRefusal, Ticket, hex_lower, secret_hash,
};

/// What a gateway run keeps its enrolments in.
///
/// An enum and not `Box<dyn AllowlistStore>`: the trait's methods return
/// `impl Future`, which is not dyn-compatible, and making it so would mean
/// boxing a future on every admission to serve one call site. The two arms are
/// the two ways a gateway is started, and a gateway with no `--data-dir` has no
/// vault to be durable in.
pub enum GatewayAllowlist {
    /// No `--data-dir`: there is no vault, so there is nowhere durable to put an
    /// enrolment. The gateway says so at start.
    Memory(MemoryAllowlist),
    /// The vault's own `access_device` rows.
    Durable(DurableAllowlist),
}

impl GatewayAllowlist {
    /// The durable store over this gateway's core.
    #[must_use]
    pub fn durable(core: Arc<Handle>) -> Self {
        Self::Durable(DurableAllowlist::new(core))
    }

    /// The in-memory store, for a gateway with no vault.
    #[must_use]
    pub fn memory() -> Self {
        Self::Memory(MemoryAllowlist::new())
    }

    /// Whether enrolments made in this run survive it. The gateway prints the
    /// line from this rather than from the flag, so the line cannot drift from
    /// what is actually holding the rows.
    #[must_use]
    pub fn is_durable(&self) -> bool {
        matches!(self, Self::Durable(_))
    }
}

impl AllowlistStore for GatewayAllowlist {
    async fn mint(&self, ticket: Ticket) {
        match self {
            Self::Memory(store) => store.mint(ticket).await,
            Self::Durable(store) => store.mint(ticket).await,
        }
    }

    async fn redeem(
        &self,
        ticket_id: &str,
        secret: &[u8],
        device: Device,
        now_ms: u64,
    ) -> Result<Device, RedeemRefusal> {
        match self {
            Self::Memory(store) => store.redeem(ticket_id, secret, device, now_ms).await,
            Self::Durable(store) => store.redeem(ticket_id, secret, device, now_ms).await,
        }
    }

    async fn device(&self, endpoint_id: &[u8; 32]) -> Option<Device> {
        match self {
            Self::Memory(store) => store.device(endpoint_id).await,
            Self::Durable(store) => store.device(endpoint_id).await,
        }
    }

    async fn devices(&self) -> Vec<Device> {
        match self {
            Self::Memory(store) => store.devices().await,
            Self::Durable(store) => store.devices().await,
        }
    }

    async fn revoke(&self, device: &str, now_ms: u64) -> Option<Device> {
        match self {
            Self::Memory(store) => store.revoke(device, now_ms).await,
            Self::Durable(store) => store.revoke(device, now_ms).await,
        }
    }
}

/// Enrolments in the vault; unredeemed tickets in this process.
pub struct DurableAllowlist {
    core: Arc<Handle>,
    /// Guards the ticket table AND every enrolment write, so a redemption's
    /// burn and its enrolment cannot be observed apart — the property the
    /// trait's one-call `redeem` exists to make available.
    tickets: Mutex<BTreeMap<String, Ticket>>,
}

impl DurableAllowlist {
    #[must_use]
    pub fn new(core: Arc<Handle>) -> Self {
        Self {
            core,
            tickets: Mutex::new(BTreeMap::new()),
        }
    }

    /// The key a proved EndpointId is filed under. Lowercase hex of the 32
    /// bytes — the same spelling `centraid devices` prints, so the value in the
    /// column is one a member can compare against what their phone shows.
    fn key_of(endpoint_id: &[u8; 32]) -> String {
        hex_lower(endpoint_id)
    }

    fn endpoint_of(public_key: &str) -> Option<[u8; 32]> {
        let bytes = (0..public_key.len() / 2)
            .map(|index| u8::from_str_radix(&public_key[index * 2..index * 2 + 2], 16))
            .collect::<std::result::Result<Vec<u8>, _>>()
            .ok()?;
        bytes.try_into().ok()
    }

    /// The vault's row, in the vocabulary the seat lane speaks.
    fn as_net_device(held: &centraid_vault::devices::Device, public_key: &str) -> Device {
        Device {
            endpoint_id: Self::endpoint_of(public_key).unwrap_or([0u8; 32]),
            device_id: held.device_id.clone(),
            label: held.name.clone(),
            platform: held.platform.clone(),
            // The enrolment moment is the vault's, as text. This field is
            // milliseconds and nothing reads it for ordering — the vault's own
            // `ORDER BY enrolled_at` is what orders the list — so a lossy
            // conversion is not attempted and the value a restart cannot
            // recover is reported as the epoch rather than as a guess.
            enrolled_at_ms: 0,
            // A ROW THIS STORE RETURNS IS LIVE BY CONSTRUCTION: revoking
            // deletes the key, so a device found by its key has not been
            // revoked.
            revoked_at_ms: None,
        }
    }
}

impl AllowlistStore for DurableAllowlist {
    async fn mint(&self, ticket: Ticket) {
        self.tickets
            .lock()
            .expect("the ticket mutex")
            .insert(ticket.ticket_id.clone(), ticket);
    }

    async fn redeem(
        &self,
        ticket_id: &str,
        secret: &[u8],
        device: Device,
        now_ms: u64,
    ) -> Result<Device, RedeemRefusal> {
        let mut tickets = self.tickets.lock().expect("the ticket mutex");
        let ticket = tickets.get(ticket_id).ok_or(RedeemRefusal::InvalidCode)?;
        if ticket.secret_hash != secret_hash(secret) {
            return Err(RedeemRefusal::InvalidCode);
        }
        if ticket.redeemed_at_ms.is_some() || ticket.expires_at_ms <= now_ms {
            return Err(RedeemRefusal::ExpiredCode);
        }
        // THE ENROLMENT FIRST, THE BURN SECOND, AND BOTH UNDER THIS LOCK. If
        // the vault write fails the ticket is left unburnt, which is the state
        // a member can retry from; nothing else can redeem it meanwhile,
        // because nothing else can take this lock.
        let enrolled = self.core.with_vault(|vault| {
            let owner = vault.self_party_id()?;
            vault.enrol_device(
                &device.device_id,
                &owner,
                &device.label,
                &device.platform,
                &Self::key_of(&device.endpoint_id),
            )?;
            Ok(())
        });
        if let Err(error) = enrolled {
            // THE COARSE REFUSAL IS ALL THIS TRAIT HAS, and a member holding a
            // valid QR must not be told their code was bad without the reason
            // being somewhere. It is here.
            tracing::error!(%error, device = %device.device_id, "the enrolment would not commit");
            return Err(RedeemRefusal::InvalidCode);
        }
        let mut burnt = ticket.clone();
        burnt.redeemed_at_ms = Some(now_ms);
        tickets.insert(ticket_id.to_owned(), burnt);
        Ok(device)
    }

    async fn device(&self, endpoint_id: &[u8; 32]) -> Option<Device> {
        let key = Self::key_of(endpoint_id);
        let found = self
            .core
            .with_vault(|vault| Ok(vault.device_by_public_key(&key)?))
            .ok()
            .flatten()?;
        Some(Self::as_net_device(&found, &key))
    }

    async fn devices(&self) -> Vec<Device> {
        self.core
            .with_vault(|vault| Ok(vault.live_devices_with_keys()?))
            .unwrap_or_default()
            .iter()
            .map(|(held, key)| Self::as_net_device(held, key))
            .collect()
    }

    async fn revoke(&self, device: &str, now_ms: u64) -> Option<Device> {
        let named = device.to_lowercase();
        let (held, key) = self
            .core
            .with_vault(|vault| Ok(vault.live_devices_with_keys()?))
            .ok()?
            .into_iter()
            .find(|(held, key)| held.device_id == device || *key == named)?;
        let revoked = self
            .core
            .with_vault(|vault| Ok(vault.revoke_device(&held.device_id)?))
            .ok()?;
        if !revoked {
            return None;
        }
        let mut gone = Self::as_net_device(&held, &key);
        gone.revoked_at_ms = Some(now_ms);
        Some(gone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_core::{Core, CoreConfig};

    const TTL_MS: u64 = 15 * 60 * 1000;

    /// A founded gateway vault at `path`, opened fresh each time — which is
    /// what makes these tests about DURABILITY and not about a live object.
    fn gateway(path: &std::path::Path, found: bool) -> Arc<Handle> {
        let handle = Core::open(CoreConfig::gateway(path)).expect("the gateway core opens");
        if found {
            handle
                .with_vault(|vault| Ok(vault.found("Durable", "Owner")?))
                .expect("the vault founds");
        }
        Arc::new(handle)
    }

    fn phone(endpoint: u8) -> Device {
        Device {
            endpoint_id: [endpoint; 32],
            device_id: format!("dev_{endpoint}"),
            label: "A Phone".to_owned(),
            platform: "ios".to_owned(),
            enrolled_at_ms: 1_000,
            revoked_at_ms: None,
        }
    }

    async fn paired(store: &DurableAllowlist, endpoint: u8) {
        store
            .mint(Ticket {
                ticket_id: format!("tkt_{endpoint}"),
                secret_hash: secret_hash(b"secret"),
                expires_at_ms: TTL_MS,
                redeemed_at_ms: None,
            })
            .await;
        store
            .redeem(&format!("tkt_{endpoint}"), b"secret", phone(endpoint), 1_000)
            .await
            .expect("the redemption enrols");
    }

    /// THE DEFECT, AS ONE ASSERTION: a second process over the same file admits
    /// the device the first one enrolled. Two `Handle`s over one path, the
    /// first dropped before the second opens, which is a restart in everything
    /// but the fork.
    #[tokio::test]
    async fn an_enrolment_outlives_the_process_that_made_it() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let file = dir.path().join("vault.db");

        let first = gateway(&file, true);
        let store = DurableAllowlist::new(Arc::clone(&first));
        paired(&store, 1).await;
        assert_eq!(
            store.device(&[1u8; 32]).await.expect("enrolled").device_id,
            "dev_1"
        );
        drop(store);
        first.close();
        drop(first);

        let restarted = gateway(&file, false);
        let store = DurableAllowlist::new(restarted);
        let admitted = store.device(&[1u8; 32]).await.expect("still enrolled");
        assert_eq!(admitted.device_id, "dev_1");
        assert!(admitted.is_live());
        assert_eq!(store.devices().await.len(), 1);
        // A key nobody enrolled is still a stranger. The store remembering
        // everything and the store remembering the right thing are different
        // properties and this is the second one.
        assert!(store.device(&[9u8; 32]).await.is_none());
    }

    /// AND SO DOES THE REVOCATION. A durable allowlist that lost the revocation
    /// would be worse than the in-memory one it replaced: a phone the member
    /// took authority from would get it back at the next restart.
    #[tokio::test]
    async fn a_revocation_outlives_it_too() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let file = dir.path().join("vault.db");

        let first = gateway(&file, true);
        let store = DurableAllowlist::new(Arc::clone(&first));
        paired(&store, 2).await;
        assert!(store.revoke("dev_2", 5_000).await.is_some());
        assert!(store.device(&[2u8; 32]).await.is_none());
        drop(store);
        first.close();
        drop(first);

        let restarted = gateway(&file, false);
        let store = DurableAllowlist::new(restarted);
        assert!(
            store.device(&[2u8; 32]).await.is_none(),
            "a revoked device was admitted after a restart"
        );
        assert!(store.devices().await.is_empty());
    }

    /// The burn is durable BECAUSE the enrolment is: a ticket redeemed in this
    /// process cannot be redeemed again in it, and a restart invalidates every
    /// outstanding code rather than carrying a secret across (see the header).
    #[tokio::test]
    async fn a_ticket_burns_once_and_does_not_survive_a_restart() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let file = dir.path().join("vault.db");
        let core = gateway(&file, true);
        let store = DurableAllowlist::new(core);
        paired(&store, 3).await;
        assert_eq!(
            store
                .redeem("tkt_3", b"secret", phone(4), 1_001)
                .await
                .expect_err("burnt"),
            RedeemRefusal::ExpiredCode
        );
        assert!(store.device(&[4u8; 32]).await.is_none());

        // A fresh process has no tickets at all, and says so with the refusal a
        // member holding an old QR should get.
        let store = DurableAllowlist::new(gateway(&file, false));
        assert_eq!(
            store
                .redeem("tkt_3", b"secret", phone(5), 1_001)
                .await
                .expect_err("gone"),
            RedeemRefusal::InvalidCode
        );
    }
}
