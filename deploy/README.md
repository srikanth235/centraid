# `deploy/` — every way a gateway gets onto a machine

One home for the artifacts that put `centraid-gateway` on a host — the container image, the OS service units and the VPS installer ([#1080][issue]). The protocol the gateway serves, its commands and its data directory are [docs/gateway.md](../docs/gateway.md).

**There is one gateway, and a phone reaches it one way**: HTTPS, straight to the machine, pinning the certificate the gateway minted at its first `serve` ([R-1080-1][r1]). A gateway is any machine the member controls — the laptop at home, a VPS, a NAS — and everything in this directory follows from that shape:

- **It listens, on one TCP port** (8443 unless `--bind` says otherwise), and it is the only thing in the product that does. Its listener is confined to `crates/gateway/src/server/serve.rs`, the one file `cargo xtask rules`' `no-listening-socket` allows; a second listener anywhere, that crate included, is a finding.
- **No reverse proxy that terminates TLS, no ACME, no certbot and no domain.** The phone compares the certificate it is shown against the pin it scanned, so a proxy that terminates TLS presents a certificate the phone refuses. A port forward or a TCP pass-through in front of a gateway is fine.
- **No credential in any unit.** The gateway is blind: its data directory holds its own TLS identity and sealed objects, and nothing that opens a vault, so there is no keystore secret to hand a service at start.
- **No backup cron.** The phone decides when to snapshot and what to upload; the gateway's purge and scrub sweeps run inside `serve` on their own timers.

## The service units

`centraid-gateway install --data-dir <dir> [--bind <addr>] [--dry-run]` renders a **systemd user unit** on Linux or a **launchd agent** on macOS, writes it, and prints the command that starts it. **It never enables what it writes**: a background service that starts because a file was unpacked is a service nobody chose to run. `--dry-run` prints the unit and its path and touches nothing, which is what makes it checkable before it runs.

A user unit needs no root and confines the process to its data directory. It follows the login session, so on a headless Linux box that nobody logs in to, `loginctl enable-linger <user>` is what keeps it running. On macOS the agent runs while the member is logged in, which is when a laptop is awake to be backed up to.

## The container

The image runs `centraid-gateway serve` as an unprivileged user. Two things about running it:

- **The data directory is the whole gateway** — its identity, its index and its objects. Mount durable storage there: a run without a volume loses all three when the container is removed, and every paired phone then refuses the gateway that replaces it.
- **Run it on the host's network** (`docker run --network host …`). The phone dials the addresses in the pairing QR, `pair` lists the addresses the gateway itself sees, and `serve` advertises itself on the LAN from the same view — inside a container's own network those are addresses no phone can reach.

## The VPS installer

`vps/install.sh` verifies **before** it unpacks (`SHA256SUMS`), checks the installed binary's identity stamp against the release that claims to have published it, and **never installs an OS service silently**: `--with-service` prints the commands, only `--yes` runs them, and enabling is always left to the operator.

[issue]: https://github.com/srikanth235/centraid/issues/1080
[r1]: ../docs/decisions.md#backups-from-first-principles-1080
