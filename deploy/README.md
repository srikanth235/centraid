# `deploy/` — every way a gateway gets onto a machine

One home for the artifacts that put `centraid-gateway` on a host — the container image, the OS service units and the VPS installer ([#1080][issue]). The protocol the gateway serves, its commands and its data directory are [docs/gateway.md](../docs/gateway.md).

**There is one gateway, and a phone reaches it one way**: HTTPS, straight to the machine, pinning the certificate the gateway minted at its first `serve` ([R-1080-1][r1]). A gateway is any machine the member controls — the laptop at home, a VPS, a NAS — and everything in this directory follows from that shape:

- **It listens, on one TCP port** (8443 unless `--bind` says otherwise), and it is the only thing in the product that does. Its listener is confined to `crates/gateway/src/server/serve.rs`, the one file `cargo xtask rules`' `no-listening-socket` allows; a second listener anywhere, that crate included, is a finding.
- **No reverse proxy that terminates TLS, no ACME, no certbot and no domain.** The phone compares the certificate it is shown against the pin it scanned, so a proxy that terminates TLS presents a certificate the phone refuses. A port forward or a TCP pass-through in front of a gateway is fine.
- **No credential in any unit.** The gateway is blind: its data directory holds its own TLS identity and sealed objects, and nothing that opens a vault, so there is no keystore secret to hand a service at start.
- **No backup cron.** The phone decides when to snapshot and what to upload; the gateway's purge and scrub sweeps run inside `serve` on their own timers.

| Path | What it is |
| --- | --- |
| `gateway/Dockerfile` | **The gateway image**: one `centraid-gateway` binary, an unprivileged user, the data directory at `/var/lib/centraid`, and the gateway's own `health` as the health check. |
| `gateway/README.md` | Running a gateway on a box you own: the shortest path, getting it reachable, a container, backing it up. |
| `vps/install.sh` | Download, verify, install, and _offer_ a service. |

## The service units

`centraid-gateway install --data-dir <dir> [--bind <addr>] [--dry-run]` renders a **systemd user unit** on Linux or a **launchd agent** on macOS, creates a missing data directory with mode 0700, writes the unit, and prints the command that starts it. **It never enables what it writes**: a background service that starts because a file was unpacked is a service nobody chose to run. `--dry-run` prints the unit and its path and touches nothing, which is what makes it checkable before it runs.

A user unit needs no root. The systemd unit sandboxes the process: it hides the home directory (`ProtectHome=tmpfs`) and binds back only the data directory and the binary, so a data directory under `~` works and nothing else in the member's home is visible to the process. It follows the login session, so on a headless Linux box that nobody logs in to, `loginctl enable-linger <user>` is what keeps it running. On macOS the agent runs while the member is logged in, which is when a laptop is awake to be backed up to.

## The container

```sh
docker build -f deploy/gateway/Dockerfile -t centraid-gateway .
docker run -d --name centraid-gateway --network host \
  -v centraid-gateway:/var/lib/centraid centraid-gateway
docker logs centraid-gateway        # the first pairing QR, at the first start
docker exec centraid-gateway centraid-gateway pair --data-dir /var/lib/centraid
```

The image runs `centraid-gateway serve --data-dir /var/lib/centraid` as an unprivileged user (uid 10001), and its health check is `centraid-gateway health` against the certificate in that directory. Two things about running it:

- **The data directory is the whole gateway** — its identity, its index and its objects. Mount a volume or a host path at `/var/lib/centraid`: a run without one loses all three when the container is removed, and every paired phone then refuses the gateway that replaces it. There is no anonymous `VOLUME` in the image, because an anonymous volume only makes that loss quieter.
- **Run it on the host's network** (`--network host`). The phone dials the addresses in the pairing QR, `pair` lists the addresses the gateway itself sees, and `serve` advertises itself on the LAN from the same view. Behind Docker's bridge (`-p 8443:8443`, with `--no-mdns`) the gateway still serves, but its QR names the container's own address, which no phone can dial — so host networking is the supported shape.

## The VPS installer

`vps/install.sh` verifies **before** it unpacks (`SHA256SUMS`), checks the installed `centraid` binary's identity stamp against the release that claims to have published it, installs `centraid-gateway` beside it when the tarball carries it, and **never installs an OS service silently**: `--with-service` prints the `centraid-gateway install` commands, only `--yes` runs them, and enabling — `systemctl --user enable --now dev.centraid.gateway`, with `loginctl enable-linger` on a box nobody logs in to — is always left to the operator. A tarball without `centraid-gateway` installs no gateway and refuses `--with-service`; the release's prebuilt-core lane builds `--bin centraid` alone today ([#1080][issue] open item).

[issue]: https://github.com/srikanth235/centraid/issues/1080
[r1]: ../docs/decisions.md#backups-from-first-principles-1080
