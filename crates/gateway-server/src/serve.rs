//! THE LISTENER, AND IT IS THE ONLY ONE IN THIS WORKSPACE (#1029 §3).
//!
//! Everything else Centraid ships is a client: the phone opens no inbound
//! socket, the desktop talks to a sidecar over stdio, the browser Companion
//! talks to a native host. `cargo xtask rules`' `no-listening-socket` exists to
//! keep that true, and it predates #1029 §3 — which introduces, deliberately,
//! **a server anyone can self-host**. A gateway that did not listen would not
//! be a gateway.
//!
//! So the bind is confined to this one file, and the rule was repointed rather
//! than relaxed: it still scans every other crate, and inside this crate it
//! still scans every other file. A listener anywhere else in the workspace is
//! still a finding, which is the property the rule was written for.
//!
//! # WHAT THIS FILE IS ALLOWED TO DO
//!
//! Accept connections, hand them to the router, and shut down when asked.
//! It makes no decision about a request: [`crate::http`] does the decoding and
//! `centraid-gateway-core` does the deciding.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context as _;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::config::{Config, TlsConfig};
use crate::http::{Server, Shared};

/// A bound listener and the address it actually got.
///
/// The address is returned because `:0` is how a test binds a free port, and a
/// test that had to guess one would be a test that fails when a machine is
/// busy.
#[derive(Debug)]
pub struct Bound {
    pub listener: TcpListener,
    pub address: SocketAddr,
}

/// Bind the configured address.
///
/// # Errors
///
/// If the address cannot be parsed or the port cannot be bound.
pub async fn bind(bind_address: &str) -> anyhow::Result<Bound> {
    let listener = TcpListener::bind(bind_address)
        .await
        .with_context(|| format!("binding {bind_address}"))?;
    let address = listener.local_addr().context("reading the bound address")?;
    Ok(Bound { listener, address })
}

/// Wrap a server in the handle the handlers take.
#[must_use]
pub fn shared(server: Server) -> Shared {
    Arc::new(Mutex::new(server))
}

/// Serve plain HTTP on an already-bound listener.
///
/// This is the `TlsConfig::Terminated` arm and the default: a reverse proxy, a
/// Cloudflare Tunnel or a Tailscale Funnel is holding the certificate. It is
/// also the arm the tests run, because a conformance run should not need an
/// ACME server.
///
/// # Errors
///
/// If the server stops with an error.
pub async fn serve_plain(bound: Bound, server: Shared) -> anyhow::Result<()> {
    axum::serve(bound.listener, crate::http::router(server))
        .await
        .context("serving")
}

/// Serve with a certificate this process obtains and renews itself.
///
/// # Errors
///
/// If ACME cannot be started or the server stops with an error.
pub async fn serve_acme(bound: Bound, server: Shared, config: &Config) -> anyhow::Result<()> {
    let TlsConfig::Acme {
        domains,
        contact_email,
        staging,
    } = &config.tls
    else {
        anyhow::bail!("serve_acme was called for a server that terminates TLS in front");
    };
    std::fs::create_dir_all(config.acme_cache()).context("creating the ACME cache")?;
    let mut state =
        crate::acme::configure(domains, contact_email, &config.acme_cache(), *staging).state();
    let acceptor = state.acceptor();

    // The resolver is the ACME state's own; the rest of the TLS configuration
    // is ordinary. `http/1.1` only, because ALPN is how the challenge is
    // distinguished and an `h2` entry here would advertise a protocol this
    // server does not speak.
    let mut rustls_config = tokio_rustls::rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(state.resolver());
    rustls_config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let rustls_config = Arc::new(rustls_config);

    // The ACME state machine is a stream of events, and an operator needs to
    // see them: a renewal that has been failing for a month is the failure mode
    // that ends with an expired certificate and no warning.
    tokio::spawn(async move {
        use futures::StreamExt as _;
        while let Some(event) = state.next().await {
            match event {
                Ok(ok) => tracing::info!(event = ?ok, "acme"),
                Err(error) => tracing::error!(%error, "acme"),
            }
        }
    });

    axum::serve(
        AcmeListener {
            listener: bound.listener,
            acceptor,
            rustls_config,
        },
        crate::http::router(server),
    )
    .await
    .context("serving")
}

/// A listener that answers the ACME challenge and hands on a TLS stream.
///
/// `axum::serve` takes a `Listener`, and a handshake that turns out to be a
/// TLS-ALPN-01 challenge is **not** a connection to serve — the ACME acceptor
/// answers it and yields nothing. So this loops until a real stream comes out,
/// which is what keeps the challenge invisible to everything above.
struct AcmeListener {
    listener: TcpListener,
    acceptor: tokio_rustls_acme::AcmeAcceptor,
    rustls_config: Arc<tokio_rustls::rustls::ServerConfig>,
}

impl axum::serve::Listener for AcmeListener {
    type Io = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let Ok((stream, address)) = self.listener.accept().await else {
                continue;
            };
            match self.acceptor.accept(stream).await {
                // A challenge handshake. Answered, and there is nothing to
                // serve over it.
                Ok(None) => continue,
                Ok(Some(start)) => {
                    if let Ok(stream) = start.into_stream(Arc::clone(&self.rustls_config)).await {
                        return (stream, address);
                    }
                }
                Err(error) => tracing::debug!(%error, "a handshake failed"),
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `:0` gets a free port and says which, so a test never guesses one.
    #[tokio::test]
    async fn binding_port_zero_reports_the_port_it_got() {
        let bound = bind("127.0.0.1:0").await.expect("a free port");
        assert!(bound.address.port() > 0);
        assert!(bound.address.ip().is_loopback());
    }

    /// A bind that cannot work fails with the address in the message, because
    /// "binding failed" on a home box is otherwise unactionable.
    #[tokio::test]
    async fn a_bad_address_names_itself_in_the_error() {
        let error = bind("not-an-address").await.expect_err("cannot bind");
        assert!(format!("{error}").contains("not-an-address"), "{error}");
    }
}
