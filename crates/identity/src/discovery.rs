//! PUBLISH AND RESOLVE, OUTBOUND ONLY (#1029 §0, §6).
//!
//! [`crate::record`] says what a record *is*. This says how it gets onto a
//! server and back off one. Both directions are an outbound HTTP request to a
//! configured `iroh-dns-server` and nothing else: no endpoint, no ALPN, no
//! relay, no listener. The phone never accepts a connection, so "resolution" is
//! a query the phone makes and never a service the phone offers.
//!
//! That invariant is enforced one level down, in the manifest:
//! `pkarr`'s `dht` feature — which binds a mainline UDP socket and joins a
//! gossip overlay — is **off**, so the only backend compiled into this crate is
//! the relay client.
//!
//! ## THE SERVER IS CONFIGURABLE, AND N0'S IS THE DEFAULT
//!
//! #1029 §0 decided option (a): n0's `iroh-dns-server`, at
//! [`DEFAULT_DNS_SERVER`]. A self-hoster points [`Discovery::with_server`] at
//! their own and nothing else changes — the record, its signature and its
//! address are the same, because a pkarr record is authenticated by the key it
//! is published under and not by the server that held it.
//!
//! ## "UNREACHABLE", NEVER "UNKNOWN PERSON"
//!
//! A failed resolution says nothing about whether a person exists. Their server
//! may be down, the phone may be on a captive-portal Wi-Fi, the record may have
//! expired between refreshes. #1029 §0 is explicit that a phone treats a record
//! it cannot resolve as **unreachable**, and [`DiscoveryError`] has no variant
//! that says otherwise — there is deliberately no `NotFound` and no
//! `UnknownIdentity`. pkarr's own `NotFound` is folded into
//! [`DiscoveryError::Unreachable`] at the boundary, so a caller cannot render
//! the wrong sentence even by accident.
//!
//! ## RESOLUTION IS THE MOVE-RECOVERY PATH, NOT THE PER-MESSAGE LOOKUP (F9)
//!
//! A capability or a ticket already carries the gateway URL and the box key, so
//! sending a message does not resolve anything. Resolution happens when
//! something *moved* — a restore, a gateway switch, a contact who has gone
//! quiet. That is why every resolve here is `NetworkOnly`: the one situation
//! this path exists for is the one where a cached answer is the pre-move answer,
//! and a stale hit would defeat the whole mechanism. It is also why the API is
//! shaped around a key and not around a send.

use ed25519_dalek::VerifyingKey;
use pkarr::errors::{PublishError, ResolveError};
use pkarr::{Client, PublicKey, ResolvePolicy, SignedPacket};

use crate::derive::{AccountKey, VaultIdentityKey};
use crate::record::{AccountRecord, GatewayUrl, IdentityRecord, RecordError};

/// n0's `iroh-dns-server`, the default (#1029 §0: "Decided: option (a)").
///
/// A named constant rather than a literal at a call site because it is a
/// product decision with an owner — whose infrastructure every phone talks to
/// by default — and a setting a self-hoster overrides
/// ([`Discovery::with_server`]). It is the same URL `iroh` itself ships as
/// `N0_DNS_PKARR_RELAY_PROD`, so a Centraid record and an iroh record live in
/// the same zone under the same key.
pub const DEFAULT_DNS_SERVER: &str = "https://dns.iroh.link/pkarr";

/// What publishing or resolving refuses.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DiscoveryError {
    /// **The record could not be fetched. This says nothing about the person**
    /// (#1029 §0). Server down, phone offline, record expired between
    /// refreshes — all of them land here, and none of them means "no such
    /// identity".
    #[error("{key} is unreachable: {reason}")]
    Unreachable {
        /// The key that was queried, z-base32.
        key: String,
        /// What the resolver said, for a log line — never for the sentence
        /// shown to a person.
        reason: String,
    },
    /// The record was fetched but does not hold together.
    #[error(transparent)]
    Record(#[from] RecordError),
    /// The server would not take the record.
    #[error("the server would not accept the record for {key}: {reason}")]
    Publish {
        /// The key being published under, z-base32.
        key: String,
        /// What the server said.
        reason: String,
    },
    /// The configured DNS server is not a usable URL.
    #[error("{server} is not a usable DNS server: {reason}")]
    Server {
        /// The configured value.
        server: String,
        /// Why it was refused.
        reason: String,
    },
}

/// Where a gateway URL came from.
///
/// The restore path has **one** code path and two sources (#1029 §0). A caller
/// tries [`Self::Published`]; if that comes back
/// [`DiscoveryError::Unreachable`] it asks the person for the URL and calls the
/// same function again with [`Self::Typed`]. Two functions would be two places
/// for the rest of the restore to diverge, and the restore is the path that has
/// to work on the worst day someone has had.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolutionSource {
    /// Resolve the signed record through the configured DNS server.
    Published,
    /// A gateway base URL the person typed, because resolution failed.
    Typed(GatewayUrl),
}

/// Which source actually answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceUsed {
    /// A signed record, resolved and verified.
    Published,
    /// A URL a person typed. **Nothing was verified**: no signature was
    /// checked, because there was no record to check one on. The gateway must
    /// still prove itself to whatever is done next — this value says only that
    /// the person, not the network, is the reason this URL is being used.
    Typed,
}

/// A gateway that has been found, however it was found.
///
/// The typed result is the same either way, which is the whole point of
/// [`ResolutionSource`]: the caller that fetches the vault listing does not
/// branch on how the URL was obtained, it reads [`Self::source`] only when it
/// wants to say so.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    key: VerifyingKey,
    gateway: GatewayUrl,
    source: SourceUsed,
}

impl Located {
    /// The key that was being located.
    pub const fn key(&self) -> &VerifyingKey {
        &self.key
    }

    /// The gateway base URL.
    pub const fn gateway(&self) -> &GatewayUrl {
        &self.gateway
    }

    /// Which source answered.
    pub const fn source(&self) -> SourceUsed {
        self.source
    }
}

/// A pkarr client pointed at one `iroh-dns-server`.
///
/// Holds the HTTP client, so it is built once and kept — not per resolve.
#[derive(Debug, Clone)]
pub struct Discovery {
    client: Client,
    server: String,
}

impl Discovery {
    /// Point at n0's server, [`DEFAULT_DNS_SERVER`].
    pub fn new() -> Result<Self, DiscoveryError> {
        Self::with_server(DEFAULT_DNS_SERVER)
    }

    /// Point at a self-hoster's own `iroh-dns-server`.
    pub fn with_server(server: &str) -> Result<Self, DiscoveryError> {
        let refuse = |reason: String| DiscoveryError::Server {
            server: server.to_owned(),
            reason,
        };
        let mut builder = Client::builder();
        builder
            .relays(&[server])
            .map_err(|error| refuse(error.to_string()))?;
        Ok(Self {
            client: builder.build().map_err(|error| refuse(error.to_string()))?,
            server: server.to_owned(),
        })
    }

    /// The server this client publishes to and resolves against.
    pub fn server(&self) -> &str {
        &self.server
    }

    /// Publish a vault's record under its identity key.
    ///
    /// Called on a timer and on every gateway or device change (#1029 §0) — and
    /// on a restore, where the reissued certificate at `epoch + 1` is what
    /// tells a contact which phone holds the vault now.
    pub async fn publish_identity(
        &self,
        record: &IdentityRecord,
        identity: &VaultIdentityKey,
    ) -> Result<(), DiscoveryError> {
        self.put(&record.sign(identity)?).await
    }

    /// Publish the account's own record, naming the gateway that holds its
    /// vault listing (F2).
    pub async fn publish_account(
        &self,
        record: &AccountRecord,
        account: &AccountKey,
    ) -> Result<(), DiscoveryError> {
        self.put(&record.sign(account)?).await
    }

    /// Resolve a vault by its identity key — which is its address and its
    /// `vault_id`, so this is the whole of "find this person".
    pub async fn resolve_identity(
        &self,
        identity: &VerifyingKey,
    ) -> Result<IdentityRecord, DiscoveryError> {
        Ok(IdentityRecord::read(&self.get(identity).await?)?)
    }

    /// Resolve an account's own record.
    pub async fn resolve_account(
        &self,
        account: &VerifyingKey,
    ) -> Result<AccountRecord, DiscoveryError> {
        Ok(AccountRecord::read(&self.get(account).await?)?)
    }

    /// **The restore path**: find the gateway holding an account, from either
    /// source.
    ///
    /// One function, two sources. A typed URL is not a second-class answer —
    /// it is the answer when the network cannot give one, and #1029 §0 requires
    /// that it be enough to proceed.
    pub async fn locate_account(
        &self,
        account: &VerifyingKey,
        source: &ResolutionSource,
    ) -> Result<Located, DiscoveryError> {
        match source {
            ResolutionSource::Published => {
                let record = self.resolve_account(account).await?;
                Ok(Located {
                    key: *account,
                    gateway: record.gateway().clone(),
                    source: SourceUsed::Published,
                })
            }
            ResolutionSource::Typed(gateway) => Ok(Located {
                key: *account,
                gateway: gateway.clone(),
                source: SourceUsed::Typed,
            }),
        }
    }

    async fn put(&self, packet: &SignedPacket) -> Result<(), DiscoveryError> {
        let key = packet.public_key().to_z32();
        self.client
            .publish(packet)
            .await
            .map(|_| ())
            .map_err(|error| match error {
                // The server holds a newer record for this key than the one
                // offered. That is not a transport failure and not a refusal of
                // the key: it is this phone being behind, which is what an old
                // phone republishing after a restore looks like.
                PublishError::NotMostRecent => DiscoveryError::Publish {
                    key,
                    reason: "the server holds a more recent record for this key".to_owned(),
                },
                other => DiscoveryError::Publish {
                    key,
                    reason: other.to_string(),
                },
            })
    }

    /// Every resolver failure becomes [`DiscoveryError::Unreachable`]. See the
    /// module header: there is no variant that could be rendered as "no such
    /// person", so none can be.
    async fn get(&self, key: &VerifyingKey) -> Result<SignedPacket, DiscoveryError> {
        let public = PublicKey::from(*key);
        self.client
            .resolve(&public, ResolvePolicy::NetworkOnly)
            .await
            .map_err(|error| DiscoveryError::Unreachable {
                key: public.to_z32(),
                reason: match error {
                    ResolveError::NotFound => "no record was returned for this key".to_owned(),
                    other => other.to_string(),
                },
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    #[test]
    fn the_default_server_is_n0s_and_is_a_usable_url() {
        assert_eq!(DEFAULT_DNS_SERVER, "https://dns.iroh.link/pkarr");
        let discovery = Discovery::new().expect("the default builds");
        assert_eq!(discovery.server(), DEFAULT_DNS_SERVER);
    }

    #[test]
    fn a_self_hoster_points_at_their_own_server() {
        let discovery = Discovery::with_server("http://dns.example:8080/pkarr").expect("builds");
        assert_eq!(discovery.server(), "http://dns.example:8080/pkarr");
    }

    #[test]
    fn a_server_that_is_not_a_url_is_refused_by_name() {
        let error = Discovery::with_server("not a url").expect_err("refused");
        assert!(matches!(
            error,
            DiscoveryError::Server { ref server, .. } if server == "not a url"
        ));
    }

    /// THE TYPED-URL FALLBACK (#1029 §0). No network is touched, and the result
    /// is the same type a successful resolution returns.
    #[tokio::test]
    async fn a_typed_gateway_url_locates_an_account_without_the_network() {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let account = AccountKey::derive(&seed).public();
        let typed = GatewayUrl::parse("https://typed.example/").expect("a gateway URL");

        let located = Discovery::new()
            .expect("builds")
            .locate_account(&account, &ResolutionSource::Typed(typed.clone()))
            .await
            .expect("the typed source always answers");

        assert_eq!(located.key(), &account);
        assert_eq!(located.gateway(), &typed);
        assert_eq!(located.source(), SourceUsed::Typed);
    }

    /// A key nobody has published is UNREACHABLE. The server here is a port
    /// nothing listens on, which is the offline case and not a "no such
    /// person" case — and the type system has no way to say the latter.
    #[tokio::test]
    async fn an_unresolvable_key_is_unreachable_and_never_unknown() {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let account = AccountKey::derive(&seed).public();
        let discovery = Discovery::with_server("http://127.0.0.1:1/pkarr")
            .expect("a syntactically fine server");

        let error = discovery
            .locate_account(&account, &ResolutionSource::Published)
            .await
            .expect_err("nothing is listening");
        assert!(
            matches!(error, DiscoveryError::Unreachable { .. }),
            "a failed resolution must be unreachable, never unknown: {error:?}"
        );
    }
}
