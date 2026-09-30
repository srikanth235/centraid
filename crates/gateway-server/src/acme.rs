//! A CERTIFICATE, WITH NO SECOND DAEMON AND NO INBOUND PORT 80 (#1029 §3).
//!
//! A self-hoster should not have to learn certbot to run a backup server. This
//! wraps `tokio-rustls-acme`: it registers an ACME account, orders a
//! certificate, answers the challenge in-process and renews in the background,
//! caching the account key and the certificate under the data directory.
//!
//! # WHY TLS-ALPN-01 AND NOT HTTP-01 OR DNS-01
//!
//! - **HTTP-01** needs inbound port 80. A home box behind a consumer router
//!   often cannot have it, and a box behind a Cloudflare Tunnel or a Tailscale
//!   Funnel *definitely* cannot: nothing is listening on 80 at the public name
//!   at all.
//! - **DNS-01** needs an API token for the member's DNS provider — a
//!   credential that can rewrite their domain, handed to a backup server, for a
//!   certificate. That is a worse trade than the certificate is worth.
//! - **TLS-ALPN-01** is answered on the same 443 the server is already
//!   listening on, with a certificate the ACME client mints for one handshake.
//!   Nothing else is needed and nothing else is asked for.
//!
//! # AND WHY `Terminated` IS STILL THE DEFAULT
//!
//! Most self-hosters will run this behind something that already has a
//! certificate. `TlsConfig::Terminated` is the default for that reason
//! (`crate::config`), and this module is what the other arm reaches.
//!
//! **No private key here ever belongs to a vault.** The gateway is blind; the
//! only key this crate has is the server's own TLS key, which is exactly as
//! secret as any web server's and protects nothing a member sealed.

use std::path::Path;

use tokio_rustls_acme::{AcmeConfig, caches::DirCache};

/// Let's Encrypt's production directory.
pub const LETS_ENCRYPT: &str = "https://acme-v02.api.letsencrypt.org/directory";
/// Let's Encrypt's staging directory.
///
/// **A first run should use it.** Production has a rate limit measured in
/// certificates per week per domain, and a misconfigured `origin` burns them
/// quietly; staging issues an untrusted certificate that proves the whole path
/// works and costs nothing.
pub const LETS_ENCRYPT_STAGING: &str = "https://acme-staging-v02.api.letsencrypt.org/directory";

/// The ACME state a server holds while it runs.
pub type Acme = AcmeConfig<std::io::Error, std::io::Error>;

/// Build the ACME configuration for these names.
///
/// The cache is a directory under the data directory, so a restart reuses the
/// account and the certificate rather than ordering a new one — which is both
/// polite and the difference between a restart loop and a rate-limit ban.
#[must_use]
pub fn configure(domains: &[String], contact_email: &str, cache: &Path, staging: bool) -> Acme {
    install_provider();
    AcmeConfig::new(domains.iter().map(String::as_str))
        .contact_push(format!("mailto:{contact_email}"))
        .cache(DirCache::new(cache.to_path_buf()))
        .directory(if staging {
            LETS_ENCRYPT_STAGING
        } else {
            LETS_ENCRYPT
        })
}

/// Install the `ring` provider once, before any rustls type is built.
///
/// rustls refuses to guess when more than one provider could be linked and
/// **panics** at the first `ServerConfig::builder()` if none was installed. A
/// panic on a first `serve` is a self-hoster staring at a backtrace, so the
/// install happens here, where every path into rustls goes through.
///
/// `install_default` returns an error when one is already installed, which is
/// not a failure: a second call is exactly what happens when the ACME config is
/// built twice in one process.
pub fn install_provider() {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A FIRST RUN MUST BE ABLE TO BE HARMLESS. Production's rate limit is per
    /// domain per week and a misconfigured origin burns it quietly, so the
    /// staging directory is reachable from the config rather than being a thing
    /// an operator has to know to ask for.
    #[test]
    fn the_two_directories_are_different_and_staging_is_named() {
        assert_ne!(LETS_ENCRYPT, LETS_ENCRYPT_STAGING);
        assert!(LETS_ENCRYPT_STAGING.contains("staging"));
        assert!(LETS_ENCRYPT.starts_with("https://"));
        assert!(LETS_ENCRYPT_STAGING.starts_with("https://"));
    }

    /// The cache is under the data directory, so the unit's single
    /// `ReadWritePaths` covers it and a restart does not re-order.
    #[test]
    fn the_cache_lives_where_the_service_unit_can_write() {
        let config =
            crate::config::Config::defaults(Path::new("/srv/vault"), "https://vault.example.org");
        assert!(config.acme_cache().starts_with(&config.data_dir));
    }

    #[test]
    fn a_configuration_builds_for_one_name() {
        let directory = tempfile::tempdir().expect("a temporary cache");
        let _ = configure(
            &["vault.example.org".to_owned()],
            "ada@example.org",
            directory.path(),
            true,
        );
    }
}
