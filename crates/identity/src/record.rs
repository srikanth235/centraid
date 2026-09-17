//! THE SIGNED RECORD THAT MAKES A KEY FINDABLE (#1029 §0, "Resolution: iroh's
//! discovery, pkarr").
//!
//! Lane A made the keys. A key nobody can look up is an address nobody can
//! reach, and this is the half that closes that: each identity key publishes a
//! signed DNS record — a pkarr [`SignedPacket`] — under its own public key, and
//! anyone holding the key can read it back.
//!
//! ```text
//! _centraid.<z-base32 of the vault identity key>  TXT  "mailbox=<gateway base URL>"
//!                                                      "cert=<device certificate, base64url>"
//! _centraid.<z-base32 of the account key>         TXT  "gateway=<gateway base URL>"
//! ```
//!
//! ## WHY THERE IS NO ADDRESS ENTRY
//!
//! `cert=` names the device key, and **nothing dials a phone in v0** (#1029
//! §6). The certificate is here so a contact can tell a superseded phone from
//! the current one, not so anyone can open a connection to it. A record that
//! carried an IP or a relay URL for the phone would be the first half of an
//! inbound endpoint, and there is no second half to build.
//!
//! ## THE RECORD IS SIGNED TWICE, BY TWO DIFFERENT THINGS
//!
//! pkarr signs the whole packet with the key it is published under — that is
//! its own encoding and its own Ed25519 signature, and [`SignedPacket`] refuses
//! a packet whose signature does not hold before this module ever sees it. The
//! `cert=` payload carries a *second*, independent signature, the one
//! [`DeviceCertificate::verify`] checks. Both must hold, and they answer
//! different questions: the packet signature says "the holder of this key wrote
//! this record", the certificate signature says "this vault certifies that
//! device". [`IdentityRecord::read`] refuses a record where the two disagree
//! about which identity key they belong to — typed, with both keys named.
//!
//! ## WHAT THIS LAYER DOES NOT DO
//!
//! It does not order certificates. A record whose `cert=` carries a superseded
//! epoch is a perfectly valid record and is read back as one; [`DeviceTrust`]
//! is the layer that refuses it (#1029 F3). Keeping the two apart is what lets
//! a phone resolve a record, see an epoch below the one it trusts, and answer
//! `VAULT_MOVED` — rather than treating a stale record as corruption.
//!
//! [`DeviceTrust`]: crate::certificate::DeviceTrust

use base64::Engine as _;
use ed25519_dalek::VerifyingKey;
use pkarr::dns::rdata::{RData, TXT};
use pkarr::dns::{Name, ResourceRecord};
use pkarr::{Keypair, SignedPacket, Timestamp};

use crate::certificate::{CertificateError, DeviceCertificate};
use crate::derive::{AccountKey, VaultIdentityKey};

/// The owner name both records live at, relative to the key's own zone.
///
/// Underscore-prefixed, the convention for a name that carries service data
/// rather than a host — the same shape `_iroh` has on n0's side, so a zone can
/// hold both without either shadowing the other.
pub const RECORD_NAME: &str = "_centraid";

/// A vault's entry: where this identity's mailbox and backup live.
pub const MAILBOX_ENTRY: &str = "mailbox";

/// A vault's entry: which device key holds the vault now.
pub const CERT_ENTRY: &str = "cert";

/// The account record's entry.
///
/// Deliberately **not** `mailbox=`: an account has no mailbox. A mailbox is
/// addressed `/m/{identity_key}` and belongs to one vault; what the account
/// record names is the gateway that holds the account and can be asked for its
/// vault listing (#1029 §0, F2). Two names because they are two things — one
/// name reused would invite a reader to treat an account key as a vault key.
pub const GATEWAY_ENTRY: &str = "gateway";

/// How long a resolver may treat a record as fresh, in seconds.
///
/// Five minutes: records are refreshed on a timer and on every gateway or
/// device change (#1029 §0), so the window a stale `cert=` can be believed in
/// is the window an old phone keeps answering after a restore. Shorter costs
/// queries against a path that is already move-recovery and not per-message
/// (F9); longer is dead time on the one transition this record exists for.
pub const RECORD_TTL_SECONDS: u32 = 300;

/// The longest a single DNS character string may be, from RFC 1035 §3.3.14.
/// Somebody else's limit, so it is checked rather than assumed.
const MAX_CHARACTER_STRING: usize = 255;

/// The base64url alphabet, unpadded — URL-safe because these bytes travel in a
/// TXT entry beside a URL, and unpadded because `=` is the entry separator and
/// a payload that ends in `=` is a payload a reader has to think about.
const CERT_BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// A gateway base URL, checked once at the edge.
///
/// A newtype rather than a `String` because this value is typed by a person on
/// the restore screen (the fallback source, #1029 §0) as often as it is read
/// off a resolved record, and both doors need the same check. `http` and
/// `https` only: a `file:` or `data:` "gateway" would be a local-file read
/// dressed as a network fetch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayUrl(url::Url);

impl GatewayUrl {
    /// Parse and normalise one.
    pub fn parse(text: &str) -> Result<Self, RecordError> {
        let url = url::Url::parse(text).map_err(|error| RecordError::NotAGatewayUrl {
            value: text.to_owned(),
            reason: error.to_string(),
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(RecordError::NotAGatewayUrl {
                value: text.to_owned(),
                reason: format!("scheme {} is not http or https", url.scheme()),
            });
        }
        if !url.has_host() {
            return Err(RecordError::NotAGatewayUrl {
                value: text.to_owned(),
                reason: "no host".to_owned(),
            });
        }
        Ok(Self(url))
    }

    /// The normalised URL. This, not the text that was parsed, is what is
    /// published — so a record round trips to the same bytes however the person
    /// typed it.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl core::fmt::Display for GatewayUrl {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.0.as_str())
    }
}

/// What reading or building a record refuses.
///
/// Every variant that can name a key names it in z-base32, which is the same
/// spelling the record's own DNS zone uses — so an error can be pasted straight
/// into a resolver query.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RecordError {
    /// The text is not an `http`/`https` base URL.
    #[error("{value} is not a gateway base URL: {reason}")]
    NotAGatewayUrl {
        /// The text that was offered.
        value: String,
        /// Why it was refused.
        reason: String,
    },
    /// A record carries no entry of this name.
    #[error("the record published under {key} carries no `{entry}=` entry")]
    MissingEntry {
        /// The key the record is published under, z-base32.
        key: String,
        /// The entry that is missing.
        entry: &'static str,
    },
    /// A record carries the same entry twice. Taking the first silently would
    /// let a publisher say two things and a reader believe one of them.
    #[error("the record published under {key} carries `{entry}=` more than once")]
    RepeatedEntry {
        /// The key the record is published under, z-base32.
        key: String,
        /// The entry that repeats.
        entry: &'static str,
    },
    /// An entry's value is not readable.
    #[error("the `{entry}=` entry of the record published under {key} is unreadable: {reason}")]
    UnreadableEntry {
        /// The key the record is published under, z-base32.
        key: String,
        /// The entry.
        entry: &'static str,
        /// What was wrong.
        reason: String,
    },
    /// The record's `cert=` names an identity key other than the key the record
    /// is published under. **This is the refusal the module header is about**:
    /// a genuine certificate for one vault, republished under another vault's
    /// key, is not a forgery of anything — it is a lie about whose record it is.
    #[error(
        "the record published under {key} carries a certificate for {certified}: \
         a record must be signed by the key its certificate names"
    )]
    ForeignCertificate {
        /// The key the record is published under, z-base32.
        key: String,
        /// The identity key the certificate names, z-base32.
        certified: String,
    },
    /// The `cert=` payload is not a device certificate, or does not verify.
    #[error("the certificate in the record published under {key} does not hold: {source}")]
    Certificate {
        /// The key the record is published under, z-base32.
        key: String,
        /// What the certificate layer said.
        source: CertificateError,
    },
    /// An entry does not fit in one DNS character string.
    #[error(
        "the `{entry}=` entry is {bytes} bytes and a DNS character string holds {MAX_CHARACTER_STRING}"
    )]
    EntryTooLong {
        /// The entry.
        entry: &'static str,
        /// How long it came out.
        bytes: usize,
    },
    /// The whole packet is over pkarr's size limit.
    #[error("this record does not fit in one signed packet: {reason}")]
    PacketTooLarge {
        /// What pkarr said.
        reason: String,
    },
}

/// What a vault publishes under its own identity key.
///
/// The identity key is taken from the certificate rather than stored beside it,
/// so a record cannot be built that disagrees with itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityRecord {
    mailbox: GatewayUrl,
    certificate: DeviceCertificate,
}

impl IdentityRecord {
    /// The record a phone publishes for one vault.
    pub const fn new(mailbox: GatewayUrl, certificate: DeviceCertificate) -> Self {
        Self {
            mailbox,
            certificate,
        }
    }

    /// The vault identity key this record belongs under — the vault id and the
    /// address (#1029 §0).
    pub const fn identity(&self) -> &VerifyingKey {
        self.certificate.identity()
    }

    /// Where this identity's mailbox and backup live.
    pub const fn mailbox(&self) -> &GatewayUrl {
        &self.mailbox
    }

    /// Which device key holds the vault, according to this record. Read it
    /// through a [`DeviceTrust`](crate::certificate::DeviceTrust): this
    /// certificate is genuine but not necessarily current.
    pub const fn certificate(&self) -> &DeviceCertificate {
        &self.certificate
    }

    /// Sign and encode, at the current time.
    pub fn sign(&self, identity: &VaultIdentityKey) -> Result<SignedPacket, RecordError> {
        self.sign_at(identity, Timestamp::now())
    }

    /// Sign and encode at a caller-chosen timestamp.
    ///
    /// pkarr orders a key's records by this value — a republish with a lower
    /// timestamp is refused by the server as not the most recent — so it is the
    /// caller's clock, and the tests' fixed value, and never hidden.
    pub fn sign_at(
        &self,
        identity: &VaultIdentityKey,
        timestamp: Timestamp,
    ) -> Result<SignedPacket, RecordError> {
        let public = identity.public();
        if &public != self.identity() {
            return Err(RecordError::ForeignCertificate {
                key: z32(&public),
                certified: z32(self.identity()),
            });
        }
        let cert = format!(
            "{CERT_ENTRY}={}",
            CERT_BASE64.encode(self.certificate.to_bytes())
        );
        let mailbox = format!("{MAILBOX_ENTRY}={}", self.mailbox);
        sign_txt(
            &keypair(identity.signing()),
            &[
                (MAILBOX_ENTRY, mailbox.as_str()),
                (CERT_ENTRY, cert.as_str()),
            ],
            timestamp,
        )
    }

    /// Read a record back.
    ///
    /// The packet's own Ed25519 signature has already been checked by pkarr —
    /// [`SignedPacket`] cannot be constructed from bytes that fail it. What is
    /// added here is that the certificate inside verifies **and names this very
    /// key**.
    pub fn read(packet: &SignedPacket) -> Result<Self, RecordError> {
        let key = packet.public_key().to_z32();
        let entries = entries(packet);
        let mailbox = GatewayUrl::parse(&one(&entries, &key, MAILBOX_ENTRY)?)?;

        let raw = one(&entries, &key, CERT_ENTRY)?;
        let bytes = CERT_BASE64
            .decode(raw)
            .map_err(|error| RecordError::UnreadableEntry {
                key: key.clone(),
                entry: CERT_ENTRY,
                reason: error.to_string(),
            })?;
        let certificate =
            DeviceCertificate::from_bytes(&bytes).map_err(|source| RecordError::Certificate {
                key: key.clone(),
                source,
            })?;

        if certificate.identity() != packet.public_key().verifying_key() {
            return Err(RecordError::ForeignCertificate {
                key,
                certified: z32(certificate.identity()),
            });
        }
        certificate
            .verify()
            .map_err(|source| RecordError::Certificate {
                key: key.clone(),
                source,
            })?;

        Ok(Self {
            mailbox,
            certificate,
        })
    }
}

/// What an account publishes under its own account key: the gateway that holds
/// the account, and nothing else.
///
/// **Nothing about the person's vaults is in here** (#1029 F2, F9). The listing
/// of "which vaults belong to this account" is fetched *from* the gateway this
/// record names, signed by the account key — see [`crate::account`]. Putting
/// the listing in DNS would publish, to anyone who ever learns the account key,
/// exactly the set of vault addresses that a person's vaults were kept separate
/// to hide from each other.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountRecord {
    account: VerifyingKey,
    gateway: GatewayUrl,
}

impl AccountRecord {
    /// The record the phone publishes for the account.
    pub const fn new(account: VerifyingKey, gateway: GatewayUrl) -> Self {
        Self { account, gateway }
    }

    /// The account key this record belongs under.
    pub const fn account(&self) -> &VerifyingKey {
        &self.account
    }

    /// The gateway holding the account, and therefore its vault listing.
    pub const fn gateway(&self) -> &GatewayUrl {
        &self.gateway
    }

    /// Sign and encode, at the current time.
    pub fn sign(&self, account: &AccountKey) -> Result<SignedPacket, RecordError> {
        self.sign_at(account, Timestamp::now())
    }

    /// Sign and encode at a caller-chosen timestamp. See
    /// [`IdentityRecord::sign_at`].
    pub fn sign_at(
        &self,
        account: &AccountKey,
        timestamp: Timestamp,
    ) -> Result<SignedPacket, RecordError> {
        let public = account.public();
        if public != self.account {
            return Err(RecordError::ForeignCertificate {
                key: z32(&public),
                certified: z32(&self.account),
            });
        }
        let gateway = format!("{GATEWAY_ENTRY}={}", self.gateway);
        sign_txt(
            &keypair(account.signing()),
            &[(GATEWAY_ENTRY, gateway.as_str())],
            timestamp,
        )
    }

    /// Read one back.
    pub fn read(packet: &SignedPacket) -> Result<Self, RecordError> {
        let key = packet.public_key().to_z32();
        let entries = entries(packet);
        Ok(Self {
            account: *packet.public_key().verifying_key(),
            gateway: GatewayUrl::parse(&one(&entries, &key, GATEWAY_ENTRY)?)?,
        })
    }
}

/// z-base32, the spelling a pkarr zone uses for a key.
fn z32(key: &VerifyingKey) -> String {
    pkarr::PublicKey::from(*key).to_z32()
}

/// pkarr's keypair from one of ours. Both are `ed25519_dalek::SigningKey`
/// underneath — the workspace resolves one `ed25519-dalek`, so this is a
/// re-wrap and never a re-derivation.
fn keypair(signing: &ed25519_dalek::SigningKey) -> Keypair {
    Keypair::from_secret_key(&signing.to_bytes())
}

/// One TXT resource record at [`RECORD_NAME`], one character string per entry,
/// in the order given. The order is part of the encoding the golden vectors
/// pin.
fn sign_txt(
    keypair: &Keypair,
    strings: &[(&'static str, &str)],
    timestamp: Timestamp,
) -> Result<SignedPacket, RecordError> {
    let mut txt = TXT::new();
    for (entry, text) in strings {
        if text.len() > MAX_CHARACTER_STRING {
            return Err(RecordError::EntryTooLong {
                entry,
                bytes: text.len(),
            });
        }
        txt.add_string(text)
            .map_err(|error| RecordError::UnreadableEntry {
                key: keypair.public_key().to_z32(),
                entry,
                reason: error.to_string(),
            })?;
    }

    SignedPacket::builder()
        .record(ResourceRecord::new(
            Name::new_unchecked(RECORD_NAME),
            pkarr::dns::CLASS::IN,
            RECORD_TTL_SECONDS,
            RData::TXT(txt),
        ))
        .timestamp(timestamp)
        .sign(keypair)
        .map_err(|error| RecordError::PacketTooLarge {
            reason: error.to_string(),
        })
}

/// Every `key=value` pair under [`RECORD_NAME`], in wire order, with repeats
/// kept so the reader can refuse them.
fn entries(packet: &SignedPacket) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for record in packet.resource_records(RECORD_NAME) {
        let RData::TXT(txt) = &record.rdata else {
            continue;
        };
        for (key, value) in txt.iter_raw() {
            let (Ok(key), Ok(value)) = (
                core::str::from_utf8(key),
                core::str::from_utf8(value.unwrap_or_default()),
            ) else {
                continue;
            };
            found.push((key.to_owned(), value.to_owned()));
        }
    }
    found
}

/// Exactly one value for `entry`, or a typed refusal naming the key.
fn one(
    entries: &[(String, String)],
    key: &str,
    entry: &'static str,
) -> Result<String, RecordError> {
    let mut matching = entries.iter().filter(|(name, _)| name == entry);
    let first = matching.next().ok_or_else(|| RecordError::MissingEntry {
        key: key.to_owned(),
        entry,
    })?;
    if matching.next().is_some() {
        return Err(RecordError::RepeatedEntry {
            key: key.to_owned(),
            entry,
        });
    }
    Ok(first.1.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::certificate::{DeviceKey, DeviceTrust, Epoch};
    use crate::derive::{VaultKeys, VaultMint};
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    const GATEWAY: &str = "https://gateway.example/";

    fn vault(index: u32) -> VaultKeys {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        VaultMint::fresh().mint(&seed, index).expect("a vault")
    }

    fn record(keys: &VaultKeys, epoch: Epoch) -> (IdentityRecord, DeviceKey) {
        let device = DeviceKey::generate().expect("OS entropy");
        let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), epoch);
        (
            IdentityRecord::new(
                GatewayUrl::parse(GATEWAY).expect("a gateway URL"),
                certificate,
            ),
            device,
        )
    }

    #[test]
    fn a_record_round_trips_through_its_signed_packet() {
        let keys = vault(0);
        let (built, device) = record(&keys, Epoch::new(3));
        let packet = built.sign(&keys.identity).expect("signs");

        assert_eq!(packet.public_key().verifying_key(), &keys.identity.public());
        let read = IdentityRecord::read(&packet).expect("reads back");
        assert_eq!(read, built);
        assert_eq!(read.mailbox().as_str(), GATEWAY);
        assert_eq!(read.certificate().device(), &device.public());
        assert_eq!(read.certificate().epoch(), Epoch::new(3));
    }

    /// The packet travels as bytes and comes back as bytes; the round trip has
    /// to survive that, not only the in-memory value.
    #[test]
    fn a_record_survives_the_wire_bytes() {
        let keys = vault(0);
        let (built, _) = record(&keys, Epoch::FIRST);
        let bytes = built.sign(&keys.identity).expect("signs").serialize();
        let parsed = SignedPacket::deserialize(&bytes).expect("a signed packet");
        assert_eq!(IdentityRecord::read(&parsed).expect("reads"), built);
    }

    /// A record for one vault, republished under another vault's key. The
    /// packet signature is genuine — the attacker owns that key — and the
    /// certificate is genuine too. What does not hold is that they belong
    /// together.
    #[test]
    fn a_certificate_for_another_vault_is_refused_with_both_keys_named() {
        let mine = vault(0);
        let theirs = vault(1);
        let (built, _) = record(&theirs, Epoch::FIRST);

        assert_eq!(
            built.sign(&mine.identity),
            Err(RecordError::ForeignCertificate {
                key: z32(&mine.identity.public()),
                certified: z32(&theirs.identity.public()),
            })
        );
    }

    /// The same refusal from the reading side, built by hand so the packet's
    /// own signature is valid and only the pairing is wrong.
    #[test]
    fn a_record_carrying_a_foreign_certificate_does_not_read_back() {
        let mine = vault(0);
        let theirs = vault(1);
        let device = DeviceKey::generate().expect("OS entropy");
        let foreign =
            DeviceCertificate::issue(&theirs.identity, &device.public(), Epoch::FIRST).to_bytes();

        let packet = sign_txt(
            &keypair(mine.identity.signing()),
            &[
                (MAILBOX_ENTRY, &format!("{MAILBOX_ENTRY}={GATEWAY}")),
                (
                    CERT_ENTRY,
                    &format!("{CERT_ENTRY}={}", CERT_BASE64.encode(foreign)),
                ),
            ],
            Timestamp::now(),
        )
        .expect("signs");

        assert_eq!(
            IdentityRecord::read(&packet),
            Err(RecordError::ForeignCertificate {
                key: z32(&mine.identity.public()),
                certified: z32(&theirs.identity.public()),
            })
        );
    }

    #[test]
    fn a_record_whose_certificate_does_not_verify_is_refused() {
        let keys = vault(0);
        let (built, _) = record(&keys, Epoch::new(9));
        let mut bytes = built.certificate().to_bytes();
        // The epoch's low byte: genuine keys, genuine signature, moved counter.
        bytes[71] ^= 1;

        let packet = sign_txt(
            &keypair(keys.identity.signing()),
            &[
                (MAILBOX_ENTRY, &format!("{MAILBOX_ENTRY}={GATEWAY}")),
                (
                    CERT_ENTRY,
                    &format!("{CERT_ENTRY}={}", CERT_BASE64.encode(bytes)),
                ),
            ],
            Timestamp::now(),
        )
        .expect("signs");

        assert_eq!(
            IdentityRecord::read(&packet),
            Err(RecordError::Certificate {
                key: z32(&keys.identity.public()),
                source: CertificateError::BadSignature,
            })
        );
    }

    /// WHICH LAYER REFUSES WHAT (#1029 F3). A record carrying a superseded
    /// epoch is a valid record: it reads back, because the certificate in it is
    /// genuine. The refusal belongs one layer up, where the order lives.
    #[test]
    fn a_superseded_epoch_reads_as_a_record_and_is_refused_by_device_trust() {
        let keys = vault(0);
        let (old, _) = record(&keys, Epoch::new(4));
        let (new, new_device) = record(&keys, Epoch::new(5));

        let old_packet = old.sign(&keys.identity).expect("signs");
        let read = IdentityRecord::read(&old_packet).expect("the RECORD layer accepts it");
        assert_eq!(read.certificate().epoch(), Epoch::new(4));

        let mut trust = DeviceTrust::new(keys.identity.public());
        trust.accept(new.certificate()).expect("the restore");
        assert_eq!(
            trust.accept(read.certificate()),
            Err(CertificateError::Superseded {
                offered: 4,
                seen: 5
            }),
            "the record layer reads it; DeviceTrust is what refuses it"
        );
        assert_eq!(trust.trusted_device(), Some(&new_device.public()));
    }

    #[test]
    fn a_record_missing_an_entry_names_the_key_and_the_entry() {
        let keys = vault(0);
        let packet = sign_txt(
            &keypair(keys.identity.signing()),
            &[(MAILBOX_ENTRY, &format!("{MAILBOX_ENTRY}={GATEWAY}"))],
            Timestamp::now(),
        )
        .expect("signs");

        assert_eq!(
            IdentityRecord::read(&packet),
            Err(RecordError::MissingEntry {
                key: z32(&keys.identity.public()),
                entry: CERT_ENTRY,
            })
        );
    }

    /// Two `mailbox=` entries are a publisher saying two things. Taking the
    /// first would make which gateway a contact reaches depend on wire order.
    #[test]
    fn a_repeated_entry_is_refused_rather_than_resolved_by_order() {
        let keys = vault(0);
        let (built, _) = record(&keys, Epoch::FIRST);
        let packet = sign_txt(
            &keypair(keys.identity.signing()),
            &[
                (MAILBOX_ENTRY, &format!("{MAILBOX_ENTRY}={GATEWAY}")),
                (MAILBOX_ENTRY, &format!("{MAILBOX_ENTRY}=https://other/")),
                (
                    CERT_ENTRY,
                    &format!(
                        "{CERT_ENTRY}={}",
                        CERT_BASE64.encode(built.certificate().to_bytes())
                    ),
                ),
            ],
            Timestamp::now(),
        )
        .expect("signs");

        assert_eq!(
            IdentityRecord::read(&packet),
            Err(RecordError::RepeatedEntry {
                key: z32(&keys.identity.public()),
                entry: MAILBOX_ENTRY,
            })
        );
    }

    #[test]
    fn only_http_and_https_are_gateway_urls() {
        assert!(GatewayUrl::parse("https://gateway.example").is_ok());
        assert!(GatewayUrl::parse("http://127.0.0.1:8080/pkarr").is_ok());
        for refused in [
            "file:///etc/passwd",
            "data:text/plain,hi",
            "gateway.example",
            "",
        ] {
            assert!(
                matches!(
                    GatewayUrl::parse(refused),
                    Err(RecordError::NotAGatewayUrl { .. })
                ),
                "{refused} was accepted as a gateway URL"
            );
        }
    }

    /// The published form is the normalised one, so the same gateway typed two
    /// ways is one record and not two.
    #[test]
    fn a_gateway_url_is_published_normalised() {
        assert_eq!(
            GatewayUrl::parse("https://gateway.example").expect("parses"),
            GatewayUrl::parse("https://gateway.example/").expect("parses")
        );
    }

    #[test]
    fn an_account_record_round_trips_and_names_only_a_gateway() {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let account = AccountKey::derive(&seed);
        let built = AccountRecord::new(
            account.public(),
            GatewayUrl::parse(GATEWAY).expect("a gateway URL"),
        );
        let packet = built.sign(&account).expect("signs");

        assert_eq!(AccountRecord::read(&packet).expect("reads"), built);
        assert_eq!(
            entries(&packet)
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec![GATEWAY_ENTRY],
            "an account record says where the account is and nothing else"
        );
    }

    /// F2, at the byte level. A contact resolves a vault's record; the account
    /// key is the one key whose publication would link a person's vaults, so it
    /// must not be anywhere in what a contact receives.
    #[test]
    fn a_vault_record_carries_no_trace_of_the_account_key() {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let account = AccountKey::derive(&seed).public();
        let keys = vault(0);
        let (built, _) = record(&keys, Epoch::FIRST);
        let bytes = built.sign(&keys.identity).expect("signs").serialize();

        assert!(
            !bytes
                .windows(32)
                .any(|window| window == account.to_bytes().as_slice()),
            "the account key's bytes are in a contact-facing record"
        );
        assert!(
            !String::from_utf8_lossy(&bytes).contains(&z32(&account)),
            "the account key's z-base32 is in a contact-facing record"
        );
    }
}
