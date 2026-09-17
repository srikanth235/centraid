//! What each subcommand does.
//!
//! **The gateway is gone** ([#1029](https://github.com/srikanth235/centraid/issues/1029)
//! §1, §3, §6). `centraid gateway`, `centraid pair --mint` and `centraid seat
//! pair` ran the iroh endpoint, the device allowlist and the pairing lane —
//! and with no paired client there is nothing to accept, nothing to pair and
//! nothing for a second host to replicate. The phone is the vault; this binary
//! is what is left of the operator-facing verbs over a vault directory.
//!
//! What is left here is the process-wide setup every subcommand shares.

/// One line on stderr, so stdout stays parseable. `RUST_LOG`-style filters
/// through `--log` / `CENTRAID_LOG`.
pub fn install_tracing(filter: Option<&str>) {
    let env = tracing_subscriber::EnvFilter::try_new(filter.unwrap_or("centraid=info"))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env)
        .with_writer(std::io::stderr)
        .try_init();
}
