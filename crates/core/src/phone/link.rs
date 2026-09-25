//! WHAT IT TAKES TO SPEAK TO THE LAPTOP: a device key, a certificate, an iroh
//! transport and a signer (#1029 W15, W15-D3).
//!
//! # THE DEVICE KEY IS MINTED HERE AND KEPT BY THE SHELL
//!
//! A gateway request is signed by a **device**, and a device is a key plus a
//! [`DeviceCertificate`] the vault's identity key issued for it at an epoch.
//! Three things follow, and each rules out an easier answer:
//!
//! 1. **It cannot be re-minted per launch.** A fresh key needs a fresh
//!    certificate, a certificate names an epoch, and the lease only accepts an
//!    epoch above the one it holds (F3) — so a phone that minted at every start
//!    would bump the epoch at every start, and an epoch bump is exactly what F1
//!    spells `VAULT_MOVED`. It would fire at nobody, forever.
//! 2. **It cannot be derived from the seed.** A restored phone must be a *new*
//!    device at epoch + 1, and the old phone's next put must be refused; a
//!    seed-derived key would make the restored phone the same device as the one
//!    that was lost, and nothing would freeze.
//! 3. **This library does not write it down.** Same rule as the vault seed
//!    (`CONTRACT.md` §4b): the one unrecoverable secret does not go in a file
//!    beside the vault it protects.
//!
//! So it is **minted by the core and persisted by the shell**, in the platform
//! secure store, marked *this device only* and **never synced** — a synced
//! device key makes two phones one device, which is the failure the lease
//! exists to prevent.
//!
//! **It is minted at pair or at restore, and never at open**, and it is handed
//! back on that flow's own response. Minting at open would have to reach the
//! shell as an event, and the event queue is bounded and may not be drained yet
//! when a core opens; a device secret the shell missed is a phone that silently
//! re-mints next launch, which is defect 1 again with an extra step. A response
//! cannot be missed.
//!
//! # THE CERTIFICATE GOES BESIDE THE VAULT, NEVER IN IT
//!
//! [`super::Laptop`] carries it, for W15-D1's reason: a restored phone is a new
//! device (F3), so a certificate inside the vault would be shipped to the
//! laptop, restored onto the new phone, and name a device key that phone does
//! not have.

use std::path::Path;

use centraid_gateway_client::client::GatewayClient;
use centraid_gateway_client::signer::DeviceSigner;
use centraid_gateway_client::transport::IrohTransport;
use centraid_identity::certificate::{DeviceCertificate, DeviceKey, Epoch};

use crate::error::{CoreError, Result};

/// This device's signing identity for one vault.
pub struct Device {
    pub key: DeviceKey,
    pub certificate: DeviceCertificate,
}

impl Device {
    /// Mint a fresh device key and certify it at `epoch` with the vault's
    /// identity key.
    ///
    /// # Errors
    /// [`CoreError::Unavailable`] when the operating system has no entropy,
    /// which is the one failure `DeviceKey::generate` has.
    pub fn mint(identity: &centraid_identity::VaultIdentityKey, epoch: u64) -> Result<Self> {
        let key = DeviceKey::generate().map_err(|error| CoreError::Unavailable {
            reason: format!("this device could not mint a key: {error}"),
        })?;
        let certificate = DeviceCertificate::issue(identity, &key.public(), Epoch::new(epoch));
        Ok(Self { key, certificate })
    }

    /// Certify a key the caller already holds, at `epoch`.
    ///
    /// What a pair or a restore does when the shell handed a device secret back
    /// but this vault has no certificate yet — a phone that paired one vault
    /// and is now pairing a second holds one secret and needs a certificate per
    /// vault, because a certificate names the VAULT identity that issued it.
    #[must_use]
    pub fn certify(
        secret: &[u8; 32],
        identity: &centraid_identity::VaultIdentityKey,
        epoch: u64,
    ) -> Self {
        let key = DeviceKey::from_bytes(secret);
        let certificate = DeviceCertificate::issue(identity, &key.public(), Epoch::new(epoch));
        Self { key, certificate }
    }

    /// Rebuild from the secret the shell kept and the certificate beside the
    /// vault.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] when the stored certificate will not
    /// parse, or does not certify this key. **A certificate for another key is
    /// refused rather than replaced**: signing with a key the laptop never
    /// enrolled produces `GatewaySignatureInvalid` on a member's backup, which
    /// is a failure nobody can read in a log.
    pub fn resume(secret: &[u8; 32], certificate_hex: &str) -> Result<Self> {
        let key = DeviceKey::from_bytes(secret);
        let raw = hex::decode(certificate_hex).map_err(|error| CoreError::InvalidRequest {
            detail: format!("the stored device certificate is not hex: {error}"),
        })?;
        let certificate =
            DeviceCertificate::from_bytes(&raw).map_err(|error| CoreError::InvalidRequest {
                detail: format!("the stored device certificate will not parse: {error}"),
            })?;
        if certificate.device() != &key.public() {
            return Err(CoreError::InvalidRequest {
                detail: "the stored device certificate names a different key".to_owned(),
            });
        }
        Ok(Self { key, certificate })
    }

    /// The hex a [`super::Laptop`] record keeps.
    #[must_use]
    pub fn certificate_hex(&self) -> String {
        hex::encode(self.certificate.to_bytes())
    }

    fn signer(&self) -> DeviceSigner {
        DeviceSigner::new(
            self.key.clone(),
            &self.certificate,
            centraid_gateway_core::PROTOCOL_MIN,
        )
    }
}

/// Dial the laptop the record names and hand back a client for `vault`.
///
/// **This endpoint offers no ALPN and never accepts** — `dial_only_endpoint` is
/// the phone's half of "the phone dials; it accepts no inbound connection"
/// (#1029 §6), and `no-listening-socket` checks it.
///
/// # Errors
/// [`CoreError::Unavailable`] when the endpoint will not bind or the record's
/// endpoint id is not 32 bytes.
pub async fn dial(
    laptop: &super::Laptop,
    device: &Device,
    vault: centraid_gateway_core::ids::VaultId,
) -> Result<GatewayClient<IrohTransport>> {
    let raw = hex::decode(&laptop.gateway_endpoint).map_err(|error| CoreError::Unavailable {
        reason: format!("the paired laptop's id is not hex: {error}"),
    })?;
    let raw: [u8; 32] = raw.try_into().map_err(|_| CoreError::Unavailable {
        reason: "the paired laptop's id is not 32 bytes".to_owned(),
    })?;
    let id = iroh::EndpointId::from_bytes(&raw).map_err(|error| CoreError::Unavailable {
        reason: format!("the paired laptop's id is not an endpoint: {error}"),
    })?;

    let endpoint =
        IrohTransport::dial_only_endpoint()
            .await
            .map_err(|error| CoreError::Unavailable {
                reason: format!("this phone could not bind an endpoint: {error}"),
            })?;

    // THE HINTS ARE HINTS AND NEVER AUTHORITY: iroh's TLS proves the endpoint
    // id, so a tampered address reaches the right laptop or nothing. They are
    // here because a LAN-only deployment with no relay and no address lookup
    // has nothing an id alone could be dialled through (D-1020-C15).
    let address = iroh::EndpointAddr::from_parts(
        id,
        laptop
            .direct_addrs
            .iter()
            .filter_map(|text| text.parse::<std::net::SocketAddr>().ok())
            .map(iroh::TransportAddr::Ip),
    );

    Ok(GatewayClient::new(
        IrohTransport::new(endpoint, address),
        device.signer(),
        vault,
    ))
}

/// This phone's wall clock, in milliseconds, for signing.
///
/// The gateway corrects it — a `GatewayClockSkew` refusal carries the server's
/// time and the client re-signs once (`gateway_client`'s header) — so a phone
/// that has been off for a month is not stuck, and nothing here needs to be
/// right to the second.
#[must_use]
pub fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(i64::MAX)
}

/// The vault id a gateway path names: the vault's identity public key.
#[must_use]
pub fn vault_id_of(keys: &centraid_identity::VaultKeys) -> centraid_gateway_core::ids::VaultId {
    centraid_gateway_core::ids::Key32::from_bytes(keys.identity.public().to_bytes())
}

/// A path a caller handed us exists and is a directory we can write.
pub(crate) fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|error| CoreError::Invariant {
        context: format!("making {}: {error}", path.display()),
    })
}
