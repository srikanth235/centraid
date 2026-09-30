//! What an operator wrote down, and what happens if they wrote nothing
//! (#1029 §3).
//!
//! **The defaults are the deliverable.** A self-hoster who runs
//! `centraid-gateway serve --data-dir ~/vault` and nothing else must get a
//! server that is correct and safe, because that is the command most of them
//! will ever type. So every default here is the conservative arm:
//!
//! | Setting | Default | Why that way round |
//! |---|---|---|
//! | byte store | a directory under the data dir | the machine a member runs this on has a disk |
//! | `append_only` | **off** (Q24) | a household that never heard of it must not discover it as a backup that grows without bound |
//! | mirror | none | a second store is a decision about somebody else's disk |
//! | quota | a stated number, never "unlimited" | keys are free to mint, so an unbounded tier is unbounded Sybil storage (F13) |
//!
//! The file is JSON rather than TOML for one unglamorous reason: `serde_json`
//! is already in this workspace's graph and a TOML parser would be a dependency
//! bought for a config file.

use std::path::{Path, PathBuf};

use centraid_gateway_core::retention::Policy;
use serde::{Deserialize, Serialize};

/// A gibibyte, the unit an operator writes a quota in.
pub const GIB: u64 = 1_024 * 1_024 * 1_024;

/// Where the bytes go.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StoreConfig {
    /// A directory. The default.
    Filesystem {
        /// Relative to the data directory unless absolute.
        #[serde(default = "default_objects_dir")]
        path: PathBuf,
    },
}

fn default_objects_dir() -> PathBuf {
    PathBuf::from("objects")
}

/// WHICH CARRIER THIS SERVER IS DIALLED OVER.
///
/// **iroh is the default** ([scope amendment 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)):
/// v0's gateway is a laptop, and a laptop has no domain, no certificate and no
/// forwarded port. The TCP arm stays for the self-hoster who has all three —
/// it is the same router either way, and [`crate::serve`] is where that is
/// kept true.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ListenerConfig {
    /// **The default.** HTTP/1.1 over one iroh bidirectional stream under
    /// `centraid-gateway/1`.
    Iroh(IrohConfig),
    /// A TCP socket at [`Config::bind`], with [`Config::tls`] deciding whether
    /// this process holds the certificate.
    Tcp,
}

/// The two coordinates a self-hoster may point at their own infrastructure.
///
/// **Both default to n0's**, because a phone on a foreign network has to be
/// able to reach a laptop behind NAT and that is what the relay mesh and the
/// DNS address-lookup service are for. #1029 §0 already says a self-hoster may
/// run their own `iroh-dns-server`; this says the same about the relay.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IrohConfig {
    /// A relay to use instead of n0's mesh. `None` is n0's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// A pkarr/DNS origin to publish to and resolve from instead of n0's.
    /// `None` is n0's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns_origin: Option<String>,
    /// **No relay and no address lookup at all.**
    ///
    /// A household whose phone and laptop are only ever on the same network,
    /// and who would rather nothing of theirs reached n0's mesh or n0's DNS
    /// server. The cost is stated rather than implied: an endpoint id alone is
    /// then not dialable, so the phone reaches this laptop only by the direct
    /// addresses the pairing ticket carries, and only from the same network.
    ///
    /// It is also the shape `tests/wire_iroh.rs` binds, which is why it is a
    /// setting and not a test-only constructor: the one test that moves real
    /// bytes drives the same code an operator does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local_only: bool,
    /// Bind the UDP socket here rather than on every interface. `None` is
    /// iroh's default; `127.0.0.1:0` is what a test wants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_addr: Option<String>,
}

/// How this server is reached, and whether it terminates TLS itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TlsConfig {
    /// **The default.** Plain HTTP on the bind address, with TLS terminated in
    /// front — a reverse proxy, a Cloudflare Tunnel or a Tailscale Funnel.
    /// None of those needs an inbound port on the home network, which is why
    /// this is the default rather than ACME.
    Terminated,
    /// ACME (RFC 8555) here, over TLS-ALPN-01. Needs the bind address to be
    /// reachable on 443 from the internet; needs no port 80 and no DNS token.
    Acme {
        /// The names on the certificate.
        domains: Vec<String>,
        /// Where a renewal notice goes.
        contact_email: String,
        /// Let's Encrypt's staging directory, for a first run that must not
        /// burn a rate limit.
        #[serde(default)]
        staging: bool,
    },
}

/// One household member's allowance, as the owner writes it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Quota {
    /// **Never `None`.** Zero is a real free tier and is not "no limit" — the
    /// distinction is F13's and `gateway-core`'s `Plan` has no unbounded arm.
    pub bytes: u64,
}

impl Default for Quota {
    fn default() -> Self {
        Self { bytes: 64 * GIB }
    }
}

/// Everything a `serve` needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// The state file, the object store and the ACME cache live under here.
    pub data_dir: PathBuf,
    /// `0.0.0.0:8443`, or `127.0.0.1:8443` behind a tunnel on the same box.
    #[serde(default = "default_bind")]
    pub bind: String,
    /// The origin a phone reaches this server on, e.g.
    /// `https://vault.example.org`. It is what a proxied upload target is built
    /// from, so it is the one setting a self-hoster behind a tunnel must get
    /// right.
    pub origin: String,
    #[serde(default = "default_store")]
    pub store: StoreConfig,
    /// An optional second store the scrub repairs from.
    #[serde(default)]
    pub mirror: Option<StoreConfig>,
    #[serde(default = "default_tls")]
    pub tls: TlsConfig,
    /// **Which carrier this server is dialled over. iroh by default.**
    #[serde(default = "default_listener")]
    pub listener: ListenerConfig,
    /// The quota a redeemed invite creates its account with.
    #[serde(default)]
    pub default_quota: Quota,
    /// **Q24: OFF BY DEFAULT.** When on, devices cannot delete anything at all
    /// and the owner prunes from the admin CLI. A household that turned it on
    /// chose a backup that only grows; a household that never heard of it must
    /// not be given one.
    #[serde(default)]
    pub append_only: bool,
    /// **HOW OFTEN THE SWEEPS RUN** (#1029 W15-4). Purge hourly, scrub
    /// quarterly; either may be set to `0` to turn it off. See
    /// [`crate::sweeps`].
    #[serde(default)]
    pub sweeps: crate::sweeps::Schedule,
}

fn default_bind() -> String {
    "0.0.0.0:8443".to_owned()
}

fn default_store() -> StoreConfig {
    StoreConfig::Filesystem {
        path: default_objects_dir(),
    }
}

const fn default_tls() -> TlsConfig {
    TlsConfig::Terminated
}

/// IROH IS THE DEFAULT CARRIER (scope amendment 2026-09-21). A laptop has no
/// domain and no certificate; a self-hoster who has both sets `listener` to
/// `tcp` and keeps the `bind`/`tls` settings above.
fn default_listener() -> ListenerConfig {
    ListenerConfig::Iroh(IrohConfig::default())
}

impl Config {
    /// The config a bare `serve --data-dir <dir>` produces.
    #[must_use]
    pub fn defaults(data_dir: &Path, origin: &str) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            bind: default_bind(),
            origin: origin.to_owned(),
            store: default_store(),
            mirror: None,
            tls: default_tls(),
            listener: default_listener(),
            default_quota: Quota::default(),
            append_only: false,
            sweeps: crate::sweeps::Schedule::default(),
        }
    }

    /// Read a config file.
    ///
    /// # Errors
    ///
    /// If the file cannot be read or is not the shape above.
    pub fn read(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&text)?)
    }

    /// The iroh settings, when iroh is the carrier.
    #[must_use]
    pub const fn iroh(&self) -> Option<&IrohConfig> {
        match &self.listener {
            ListenerConfig::Iroh(iroh) => Some(iroh),
            ListenerConfig::Tcp => None,
        }
    }

    /// The state file.
    #[must_use]
    pub fn state_path(&self) -> PathBuf {
        self.data_dir.join("gateway.sqlite")
    }

    /// Where ACME caches its account and certificate.
    #[must_use]
    pub fn acme_cache(&self) -> PathBuf {
        self.data_dir.join("acme")
    }

    /// The retention policy. **The defaults are `gateway-core`'s**, not this
    /// crate's: an operator may tighten them and the rules do not care which,
    /// but the numbers themselves are a rule and are not restated here.
    #[must_use]
    pub fn retention(&self) -> Policy {
        Policy::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE THREE DEFAULTS A SELF-HOSTER NEVER TYPES, AND EACH IS THE
    /// CONSERVATIVE ARM.
    #[test]
    fn the_bare_defaults_proxy_bytes_do_not_append_only_and_bound_the_quota() {
        let config = Config::defaults(Path::new("/srv/vault"), "https://vault.example.org");
        assert!(
            !config.append_only,
            "Q24: append-only is off unless a household turned it on"
        );
        assert!(config.mirror.is_none());
        assert!(matches!(config.tls, TlsConfig::Terminated));
        assert!(
            config.iroh().is_some(),
            "iroh is the default carrier: a laptop has no domain and no \
             certificate (scope amendment 2026-09-21)"
        );
        assert!(
            config.default_quota.bytes > 0,
            "a quota is a number, never absent (F13)"
        );
        // THE ATTESTED CHECKSUM IS GONE and there is no mode to configure: the
        // gateway reads what it stores and hashes it (scope amendment
        // 2026-09-21). A directory attested nothing, which is why the honest
        // default over one was always read-and-hash; now it is the only rule.
        assert!(matches!(config.store, StoreConfig::Filesystem { .. }));
    }

    /// A config round-trips, so an operator can read back what the installer
    /// wrote.
    #[test]
    fn a_config_round_trips_through_its_file() {
        let config = Config::defaults(Path::new("/srv/vault"), "https://vault.example.org");
        let text = serde_json::to_string_pretty(&config).expect("serialises");
        let back: Config = serde_json::from_str(&text).expect("parses");
        assert_eq!(back.origin, config.origin);
        assert_eq!(back.bind, config.bind);
        assert_eq!(back.state_path(), config.state_path());
    }
}
