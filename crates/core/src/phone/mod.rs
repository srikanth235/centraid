//! THE PHONE'S TWO FLOWS, AND THE TWO SCREENS BESIDE THEM (#1029 §2, §5, W15).
//!
//! `phone.proto` states the shapes and why none of the four is a registered
//! command. This module is the core's half of them.
//!
//! # WHERE THE PAIRING STATE LIVES, AND WHY IT IS NOT A RUNG
//!
//! W17 handed W19 an exact column — `gateway_endpoint BLOB` (32 bytes,
//! nullable) "on whatever per-vault settings table W19 lands" — and W19 landed
//! [`005_the_cut.sql`](../../../contracts/migrations/005_the_cut.sql), which
//! lands no settings table. **The vault has none.** What it has is
//! `core_vault`, and `core_vault` is not that table: it is an ontology entity
//! in the replicated plane, with a `core_entity` foreign key, a `row_version`
//! and a place in every census a manifest carries.
//!
//! Putting a laptop's `EndpointId` there would make a DEVICE-LOCAL coordinate
//! into vault content: it would be sealed into a base, counted in a census,
//! shipped to the laptop, and — the half that is actually wrong — **handed back
//! to a restored phone as if it were a fact about that phone**. A restored
//! phone learns its laptop from the identity record it resolved or from the
//! endpoint its member typed ([`restore`]), which is exactly the coordinate it
//! has just proved it can reach. Inheriting the dead phone's would be inheriting
//! a claim rather than a reachable address.
//!
//! So the pairing lives in [`Laptop`], a file beside the vault, and this
//! paragraph is the "you say so" the brief asked for. It is **derived state**
//! like everything else under the backup home (§1, F5): lose it and the phone
//! re-pairs or re-resolves; it is not the vault's and it does not travel.
//!
//! # WHERE THE KEYS COME FROM, AND WHY THIS FILE HOLDS NONE
//!
//! A drain seals; sealing needs [`ObjectKeys`], which are the vault's identity
//! public key and its root key — both derived from the 24 words at this vault's
//! index (`centraid_identity::derive`). **This core does not write them down.**
//! `crates/vault/src/backup/mod.rs` deleted the recovery kit for exactly this
//! reason: "a file that carries keys is a file that can be copied".
//!
//! They arrive the way `CONTRACT.md` §4a already says a secret arrives — from
//! the shell's secure store, through the open configuration, as
//! [`crate::config::VaultSeed`]. A core opened without one reads and writes its
//! vault perfectly well and cannot drain, which is an honest state a shell
//! draws ("unlock to back up") and not a failure.

pub mod drain;
pub mod link;
pub mod restore;

use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::backup::{self, BackupHome};

use crate::error::{CoreError, Result};

/// EVERY KEY THIS CORE HOLDS FOR ONE VAULT, and none of them on disk.
///
/// Built at `centraid_open` from the seed and the device secret the shell
/// handed in (`CONTRACT.md` §4b), and dropped when the handle is. See
/// [`link`]'s header for why the device key is a separate secret from the seed
/// rather than derived from it.
pub struct Keyring {
    /// The vault's own keys, at its derivation index.
    pub vault: centraid_identity::VaultKeys,
    /// The two keys every sealed object is made with.
    pub objects: backup::ObjectKeys,
    /// The device secret, when the shell had one. `None` is a core that can
    /// seal and cannot sign — it drains nothing and says so.
    pub device_secret: Option<[u8; 32]>,
}

impl Keyring {
    /// Derive everything from a seed and an index.
    ///
    /// # Errors
    /// [`CoreError::InvalidRequest`] when the index is the reserved account
    /// index, which is the one thing `restore_vault_keys` refuses.
    pub fn derive(
        seed: &centraid_identity::Seed,
        index: u32,
        device_secret: Option<[u8; 32]>,
    ) -> Result<Self> {
        let vault =
            centraid_identity::derive::restore_vault_keys(seed, index).map_err(|error| {
                CoreError::InvalidRequest {
                    detail: format!("the vault seed will not derive: {error}"),
                }
            })?;
        let objects =
            backup::ObjectKeys::new(vault.identity.public().to_bytes(), *vault.root.as_bytes());
        Ok(Self {
            vault,
            objects,
            device_secret,
        })
    }
}

/// THE LAPTOP THIS PHONE BACKS UP TO, beside the vault file.
///
/// One file, because it is one fact: this device's relationship with one
/// laptop. Read at every drain and every status; written once at pairing.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Laptop {
    /// The laptop's iroh `EndpointId`, 64 lowercase hex characters.
    pub gateway_endpoint: String,
    /// The relay the laptop expects to be reachable through. `""` is a
    /// deployment that STATED it has none — the third state
    /// `CONTRACT.md` §4a already distinguishes, kept here for the same reason:
    /// absent is "not told" and relays stay on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// Dialling hints off the ticket. Never authority — iroh's TLS proves the
    /// endpoint id, so a tampered address reaches the right laptop or nothing.
    #[serde(default)]
    pub direct_addrs: Vec<String>,
    /// THIS DEVICE'S CERTIFICATE FOR THIS VAULT, hex, issued by the identity
    /// key at pair or at restore.
    ///
    /// It is here and **not in the vault** for W15-D1's reason with more force:
    /// a restored phone is a NEW device (F3), so a certificate inside the vault
    /// would be sealed into a base, shipped to the laptop, restored onto the
    /// new phone, and name a device key that phone has never held.
    ///
    /// The **public** half of a certificate is not a secret — it is a signed
    /// statement anybody may read — which is why it may live in a file while
    /// the device secret it names may not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_certificate: Option<String>,
    /// The epoch that certificate was issued at. Kept so a later restore can
    /// ask for one above it without a round trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// THE LAST MOMENT THE GATEWAY ACKED, on the GATEWAY's clock.
    ///
    /// The only moment a member may be shown as "last backed up" (#1029 §2). It
    /// is kept here rather than computed because a status read dials nothing,
    /// and a phone clock rendered in its place would be this module's own
    /// header, broken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_acked_at_ms: Option<i64>,
}

impl Laptop {
    /// Where the record sits for a vault at `vault_file`.
    #[must_use]
    pub fn path_for(vault_file: &Path) -> PathBuf {
        home_root(vault_file).join("laptop.json")
    }

    /// Read it, or `None` when this phone has not paired.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] when the file is there and will not parse —
    /// which is never treated as "not paired", because carrying on as an
    /// unpaired phone would silently stop backing a vault up.
    pub fn read(vault_file: &Path) -> Result<Option<Self>> {
        let path = Self::path_for(vault_file);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Ok(None);
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| CoreError::Invariant {
                context: format!(
                    "the laptop record at {} will not parse: {error}",
                    path.display()
                ),
            })
    }

    /// Write it, making the backup home if it is not there yet.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] when the file cannot be written.
    pub fn write(&self, vault_file: &Path) -> Result<()> {
        let path = Self::path_for(vault_file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| CoreError::Invariant {
                context: format!("making the backup home: {error}"),
            })?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|error| CoreError::Invariant {
            context: format!("encoding the laptop record: {error}"),
        })?;
        std::fs::write(&path, text).map_err(|error| CoreError::Invariant {
            context: format!("writing {}: {error}", path.display()),
        })
    }
}

/// The laptop's endpoint id, read as the Ed25519 key it is.
///
/// An iroh `EndpointId` **is** an Ed25519 public key, which is what lets a
/// safety number be computed over it and this phone's identity key with no
/// third value agreed in advance. `None` for anything that is not 32 bytes or
/// not a point on the curve.
fn laptop_identity(endpoint: &[u8]) -> Option<ed25519_dalek::VerifyingKey> {
    let raw: [u8; 32] = endpoint.try_into().ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&raw).ok()
}

/// THE BACKUP HOME IS UNDER THE VAULT'S OWN DIRECTORY, AND THE PATH IS STATED
/// HERE ONCE (#1029 W13, F5 rows 6-7).
///
/// `<the vault file's directory>/backup`, with `objects/`, `spool/` and
/// `scratch/` under it. W13's F5 rows 6 and 7 — the OS-backup exclusion the
/// mobile shell applies — name a directory, so a second call site that chose a
/// different one would be a directory the shell never excludes and the member's
/// iCloud backup quietly carries their sealed vault.
///
/// It is a free function rather than a method so the path is one expression
/// with one reader, which is what "say the path" means.
#[must_use]
pub fn home_root(vault_file: &Path) -> PathBuf {
    vault_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backup")
}

/// Open the backup home for a vault at `vault_file`.
///
/// # Errors
/// [`CoreError::Invariant`] when the directories cannot be made.
pub fn open_home(vault_file: &Path) -> Result<BackupHome> {
    BackupHome::open(home_root(vault_file)).map_err(|error| CoreError::Invariant {
        context: format!("opening the backup home: {error}"),
    })
}

/// What the spool holds and what the gateway last acked.
struct Local {
    pending_bytes: u64,
    acked_txid: Option<u64>,
}

fn read_local(vault_file: &Path) -> Result<Local> {
    let home = open_home(vault_file)?;
    let spool = home.spool().map_err(|error| CoreError::Invariant {
        context: format!("opening the spool: {error}"),
    })?;
    let pending_bytes = spool.bytes().map_err(|error| CoreError::Invariant {
        context: format!("measuring the spool: {error}"),
    })?;
    // THE ACKED TXID IS THE CURSOR'S AND NOT THE HEAD FILE'S. `head.json`
    // records the manifest a generation SEALED, which is a fact about this
    // phone; `SpoolCursor::acked_txid` is what a store acknowledged. The UI
    // never claims backup the gateway has not acked (#1029 §2), so the number
    // that reaches a screen is this one.
    let acked_txid = spool
        .cursor()
        .map_err(|error| CoreError::Invariant {
            context: format!("reading the spool cursor: {error}"),
        })?
        .map(|cursor| cursor.acked_txid)
        .filter(|txid| *txid > 0);
    Ok(Local {
        pending_bytes,
        acked_txid,
    })
}

/// **What the shell draws on the backup screen.** Local state only; it dials
/// nothing, because drawing a screen must not depend on somebody else's
/// network.
///
/// # Errors
/// [`CoreError::Invariant`] when the backup home cannot be read.
pub fn backup_status(vault_file: &Path) -> Result<wire::BackupStatusResponse> {
    let local = read_local(vault_file)?;
    let laptop = Laptop::read(vault_file)?;
    Ok(wire::BackupStatusResponse {
        acked_txid: local.acked_txid,
        // THE MOMENT IS THE GATEWAY'S OR IT IS ABSENT (#1029 §2). It is what
        // the last drain's `CommitAck` carried, written into the laptop record;
        // a phone clock in its place would be this module's own header, broken.
        acked_at_ms: laptop.as_ref().and_then(|one| one.last_acked_at_ms),
        pending_bytes: local.pending_bytes,
        laptop_paired: laptop.is_some(),
    })
}

/// **Run one drain pass.** The work is [`drain::run`]; this is the door.
///
/// # Errors
///
/// [`CoreError::Unavailable`] when this core holds no vault keys: sealing needs
/// them and they are the shell's to supply (see this module's header).
pub fn drain_now(
    vault: &centraid_vault::Vault,
    vault_file: &Path,
    keyring: Option<&Keyring>,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::DrainResponse> {
    let Some(keyring) = keyring else {
        return Err(CoreError::Unavailable {
            reason: "this core holds no vault keys, so it cannot seal; open it with a seed"
                .to_owned(),
        });
    };
    drain::run(vault, vault_file, keyring, request, runtime)
}

/// **Redeem the pairing payload the member scanned** (#1029 W17, W15-D3).
///
/// Parses the ticket, mints this device's key and certificate at epoch 1,
/// claims the lease to prove the laptop answers and has enrolled nobody higher,
/// keeps the coordinate and the certificate beside the vault, and publishes the
/// vault's identity record so a restore from another device can find the same
/// laptop by DNS.
///
/// # Errors
///
/// [`CoreError::InvalidRequest`] for a payload that is not a ticket, is not
/// version 1, or has expired — all three refused here rather than dialled on,
/// because a ticket is the one message with no handshake in front of it.
/// [`CoreError::Unavailable`] when the laptop cannot be reached.
pub fn pair(
    vault_file: &Path,
    keyring: Option<&Keyring>,
    request: &wire::PairRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::PairResponse> {
    let ticket = centraid_identity::ticket::decode(request.payload.trim()).ok_or_else(|| {
        CoreError::InvalidRequest {
            detail: "that is not a Centraid pairing code".to_owned(),
        }
    })?;
    if ticket.v != centraid_identity::ticket::TICKET_VERSION {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "this pairing code is version {}, and this build reads version {}",
                ticket.v,
                centraid_identity::ticket::TICKET_VERSION
            ),
        });
    }
    if ticket.gateway_endpoint.len() != 32 {
        return Err(CoreError::InvalidRequest {
            detail: "the pairing code names no laptop".to_owned(),
        });
    }
    let now_ms = u64::try_from(link::now_ms()).unwrap_or(0);
    if centraid_identity::ticket::is_expired(&ticket, now_ms) {
        return Err(CoreError::InvalidRequest {
            detail: "that pairing code has expired; show a new one on the laptop".to_owned(),
        });
    }
    let Some(keyring) = keyring else {
        return Err(CoreError::Unavailable {
            reason: "this core holds no vault keys, so it cannot certify a device".to_owned(),
        });
    };

    // A FRESH DEVICE, AT EPOCH 1. A phone that is pairing has never held this
    // vault's lease; a restore is the flow that takes it from somebody
    // (`restore`, and F3).
    let device = link::Device::mint(&keyring.vault.identity, 1)?;
    let record = Laptop {
        gateway_endpoint: hex::encode(&ticket.gateway_endpoint),
        relay_url: Some(ticket.relay_url.clone()),
        direct_addrs: ticket.direct_addrs.clone(),
        device_certificate: Some(device.certificate_hex()),
        epoch: Some(1),
        last_acked_at_ms: None,
    };

    // THE LAPTOP IS ASKED BEFORE ANYTHING IS KEPT. A record written for a
    // laptop that never answered is a phone that believes it is paired.
    runtime.block_on(async {
        let mut client = link::dial(&record, &device, link::vault_id_of(&keyring.vault)).await?;
        client
            .preflight(link::now_ms())
            .await
            .map_err(|error| CoreError::Unavailable {
                reason: format!("the laptop did not answer: {error}"),
            })?;
        client
            .claim_lease(link::now_ms())
            .await
            .map_err(|error| CoreError::Unavailable {
                reason: format!("the laptop refused this device: {error}"),
            })?;
        Ok::<(), CoreError>(())
    })?;
    record.write(vault_file)?;

    // THE NUMBER THE MEMBER READS ALOUD (#1029 W15-D5), over this vault's
    // identity key and the laptop's endpoint key. Both are Ed25519 verifying
    // keys and `safety_number` sorts them, so the phone and the laptop render
    // the same digits without agreeing on an order first.
    let safety_number =
        laptop_identity(&ticket.gateway_endpoint).map_or_else(String::new, |laptop| {
            centraid_identity::safety_number(&keyring.vault.identity.public(), &laptop).grouped()
        });

    Ok(wire::PairResponse {
        safety_number,
        gateway_endpoint: ticket.gateway_endpoint.clone(),
        // PUBLISHING IS NOT PART OF PAIRING'S SUCCESS. An unpublished record
        // costs a restore from a device that never scanned this QR, which is
        // why the shell is told rather than reassured.
        record_published: false,
        // HANDED OVER EXACTLY ONCE. See `phone.proto` and `link`'s header.
        device_secret: device.key.to_secret_bytes().to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        dir
    }

    /// **THE PATH, SAID OUT LOUD** (W13 F5 rows 6-7). The shell excludes a
    /// directory from OS backup; a second call site that chose another one is
    /// a member's sealed vault in somebody's iCloud.
    #[test]
    fn the_backup_home_is_under_the_vaults_own_directory() {
        let dir = scratch();
        let file = dir.join("vault.db");
        assert_eq!(home_root(&file), dir.join("backup"));
        assert_eq!(
            Laptop::path_for(&file),
            dir.join("backup").join("laptop.json")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unpaired_phone_has_no_laptop_and_says_so() {
        let dir = scratch();
        let file = dir.join("vault.db");
        let status = backup_status(&file).expect("a status reads");
        assert!(!status.laptop_paired);
        assert_eq!(status.pending_bytes, 0);
        assert_eq!(status.acked_txid, None);
        assert_eq!(
            status.acked_at_ms, None,
            "a moment that is not the gateway's is no moment at all"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_laptop_record_round_trips_beside_the_vault() {
        let dir = scratch();
        let file = dir.join("vault.db");
        Laptop {
            gateway_endpoint: hex::encode([0xAB_u8; 32]),
            relay_url: Some(String::new()),
            direct_addrs: vec!["10.0.0.2:41234".to_owned()],
            device_certificate: None,
            epoch: None,
            last_acked_at_ms: None,
        }
        .write(&file)
        .expect("it writes");
        let back = Laptop::read(&file).expect("it reads").expect("it is there");
        assert_eq!(back.gateway_endpoint, hex::encode([0xAB_u8; 32]));
        assert_eq!(back.relay_url.as_deref(), Some(""));
        assert!(backup_status(&file).expect("a status").laptop_paired);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A record that is there and will not parse is never read as "unpaired":
    /// that would silently stop backing a vault up.
    #[test]
    fn an_unreadable_laptop_record_is_a_refusal_and_not_an_unpaired_phone() {
        let dir = scratch();
        let file = dir.join("vault.db");
        std::fs::create_dir_all(home_root(&file)).expect("the home is made");
        std::fs::write(Laptop::path_for(&file), "{").expect("it writes");
        assert!(matches!(
            Laptop::read(&file),
            Err(CoreError::Invariant { .. })
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_phrase_that_is_not_twenty_four_good_words_is_refused_before_anything_is_derived() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime");
        let refusal = restore::run(
            Path::new("/tmp/centraid-w15-never-opened/vault.db"),
            &wire::RestoreRequest {
                phrase: "abandon abandon abandon".to_owned(),
                endpoint: None,
            },
            runtime.handle(),
        )
        .expect_err("three words are not a phrase");
        assert!(matches!(refusal, CoreError::InvalidRequest { .. }));
    }

    #[test]
    fn a_payload_that_is_not_a_ticket_is_refused_and_pairs_nothing() {
        let dir = scratch();
        let file = dir.join("vault.db");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime");
        let refusal = pair(
            &file,
            None,
            &wire::PairRequest {
                payload: "not-a-ticket".to_owned(),
            },
            runtime.handle(),
        )
        .expect_err("it refuses");
        assert!(matches!(refusal, CoreError::InvalidRequest { .. }));
        assert!(
            Laptop::read(&file).expect("it reads").is_none(),
            "a refused pairing wrote a laptop record"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
