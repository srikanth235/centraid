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
//! | byte store | a directory under the data dir | a home box has one disk, not a bucket |
//! | `presign` | **off** — bytes are proxied | a self-hoster's bucket is usually unreachable from a phone on cellular |
//! | `append_only` | **off** (Q24) | a household that never heard of it must not discover it as a backup that grows without bound |
//! | checksum mode | `read-and-hash` for a directory | a filesystem attests nothing; claiming `attest` over one would be claiming a check nobody ran |
//! | mirror | none | a second store is a decision about somebody else's disk |
//! | quota | a stated number, never "unlimited" | keys are free to mint, so an unbounded tier is unbounded Sybil storage (F13) |
//!
//! The file is JSON rather than TOML for one unglamorous reason: `serde_json`
//! is already in this workspace's graph and a TOML parser would be a dependency
//! bought for a config file.

use std::path::{Path, PathBuf};

use centraid_gateway_core::checksum::ChecksumMode;
use centraid_gateway_core::retention::Policy;
use serde::{Deserialize, Serialize};

use crate::bytes::sigv4::Credentials;

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
        #[serde(default = "default_filesystem_mode")]
        checksum_mode: Mode,
    },
    /// Anything S3-compatible.
    S3 {
        endpoint: String,
        bucket: String,
        access_key_id: String,
        secret_access_key: String,
        #[serde(default = "default_region")]
        region: String,
        #[serde(default)]
        virtual_host_style: bool,
        #[serde(default = "default_s3_mode")]
        checksum_mode: Mode,
        /// **Off by default**: bytes are proxied. See [`crate::bytes`].
        #[serde(default)]
        presign: bool,
    },
}

/// The checksum mode, in the spelling a config file uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// The store attests and the gateway never reads the bytes.
    Attest,
    /// The gateway reads the bytes and hashes them itself.
    ReadAndHash,
}

impl Mode {
    /// The rules' own type.
    #[must_use]
    pub const fn to_core(self) -> ChecksumMode {
        match self {
            Self::Attest => ChecksumMode::Attest,
            Self::ReadAndHash => ChecksumMode::ReadAndHash,
        }
    }
}

fn default_objects_dir() -> PathBuf {
    PathBuf::from("objects")
}

/// A DIRECTORY ATTESTS NOTHING, so the honest default over one is to read and
/// hash. Configuring `attest` over a filesystem would be configuring a check
/// nobody runs — the rule would pass on evidence the adapter made up.
const fn default_filesystem_mode() -> Mode {
    Mode::ReadAndHash
}

/// An S3-compatible store usually does attest, and `attest` is the mode that
/// costs no read per commit. An operator whose store turns out not to attest
/// gets refused commits with `GATEWAY_CHECKSUM_MISSING`, which is the rule
/// working and is the signal to switch to `read-and-hash`.
const fn default_s3_mode() -> Mode {
    Mode::Attest
}

fn default_region() -> String {
    "us-east-1".to_owned()
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
    /// The quota a redeemed invite creates its account with.
    #[serde(default)]
    pub default_quota: Quota,
    /// **Q24: OFF BY DEFAULT.** When on, devices cannot delete anything at all
    /// and the owner prunes from the admin CLI. A household that turned it on
    /// chose a backup that only grows; a household that never heard of it must
    /// not be given one.
    #[serde(default)]
    pub append_only: bool,
}

fn default_bind() -> String {
    "0.0.0.0:8443".to_owned()
}

fn default_store() -> StoreConfig {
    StoreConfig::Filesystem {
        path: default_objects_dir(),
        checksum_mode: default_filesystem_mode(),
    }
}

const fn default_tls() -> TlsConfig {
    TlsConfig::Terminated
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
            default_quota: Quota::default(),
            append_only: false,
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

    /// The S3 credentials of a store config, if it is one.
    #[must_use]
    pub fn credentials(store: &StoreConfig) -> Option<Credentials> {
        match store {
            StoreConfig::Filesystem { .. } => None,
            StoreConfig::S3 {
                access_key_id,
                secret_access_key,
                region,
                ..
            } => Some(Credentials {
                access_key_id: access_key_id.clone(),
                secret_access_key: secret_access_key.clone(),
                region: region.clone(),
            }),
        }
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
            config.default_quota.bytes > 0,
            "a quota is a number, never absent (F13)"
        );
        match config.store {
            StoreConfig::Filesystem { checksum_mode, .. } => assert_eq!(
                checksum_mode,
                Mode::ReadAndHash,
                "a directory attests nothing, so the honest mode over one is to \
                 read and hash"
            ),
            StoreConfig::S3 { .. } => panic!("the default store is a directory"),
        }
    }

    /// An S3 store that says nothing about presigning gets the proxy, because a
    /// self-hoster's bucket is usually unreachable from a phone.
    #[test]
    fn an_s3_store_does_not_presign_unless_it_was_asked_to() {
        let store: StoreConfig = serde_json::from_str(
            r#"{"kind":"s3","endpoint":"http://minio.lan:9000","bucket":"vault",
                "access_key_id":"k","secret_access_key":"s"}"#,
        )
        .expect("an S3 store with only its required fields");
        match store {
            StoreConfig::S3 {
                presign,
                checksum_mode,
                virtual_host_style,
                region,
                ..
            } => {
                assert!(!presign, "bytes are proxied by default");
                assert_eq!(checksum_mode, Mode::Attest);
                assert!(!virtual_host_style, "MinIO and Garage are path style");
                assert_eq!(region, "us-east-1");
            }
            StoreConfig::Filesystem { .. } => panic!("that was an S3 store"),
        }
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
