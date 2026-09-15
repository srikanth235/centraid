# `deploy/` — every way a gateway gets onto a machine

One home for the artifacts that put a Centraid gateway on a host: the container image, the OS service units, and the VPS installer. Before this directory existed they were a root `Dockerfile`, a pair of TypeScript generators inside `packages/server`, and two scripts under `scripts/` ([#1020][issue], wave 3).

| Path | What it is |
| --- | --- |
| `docker/Dockerfile` | The **v1** gateway image: a Rust build stage on the pinned toolchain, a debian-slim runtime carrying one stripped `centraid` binary. |
| `docker/gateway-v0.Dockerfile` | The **v0** bun/node gateway image, moved here unchanged. It is still what `lane-release-gateway-image.yml` builds and ships, and it retires with v0 — not before. |
| `systemd/centraid-gateway.service` | The per-**user** unit: a desktop or a laptop, where somebody logs in. |
| `systemd/system/centraid-gateway@.service` | The templated **system** unit: `DynamicUser`, `StateDirectory`, `multi-user.target`. **This is the VPS default.** |
| `launchd/dev.centraid.gateway.plist` | The macOS LaunchAgent. |
| `vps/install.sh` | Download, verify, install, and _offer_ a service. |

## There is no reverse proxy, no TLS termination and no backup cron here, and that is not an omission

Nobody should add nginx, Caddy, certbot or a cron line to this directory, so the reason is written down rather than left to be rediscovered:

- **No reverse proxy and no TLS.** The gateway binds **no TCP listener at all**. It is an [iroh][iroh] QUIC endpoint over UDP, dialled by node id, with its own transport encryption and its own authorisation (the device allowlist). There is no HTTP origin to put a proxy in front of, no certificate to terminate, and no port to publish — which is also why `docker/Dockerfile` has no `EXPOSE`. The claim is enforced, not asserted: `cargo xtask`'s `no-listening-socket` structural rule refuses a `TcpListener::bind` anywhere outside the `blob-door` feature, and `crates/centraid/tests/no_listener.rs` spawns the real binary and reads `/proc/net/tcp*` to prove the process owns no LISTEN socket.
- **No backup cron.** Backup is the gateway's own scheduler, inside the process that holds the one writable connection and the keys (`crates/vault/src/backup`). An external cron job running `centraid backup now` against a live vault would be a second writer with its own idea of what is committed. `centraid backup now` exists for an operator who wants one _now_, not for a crontab.

## The two systemd shapes

They are different artifacts and neither is a variant of the other.

The **user** unit lives at `~/.config/systemd/user/centraid-gateway.service` and is what `centraid gateway install` writes by default. It follows the session: on a host with no logged-in user it does not run at all unless `loginctl enable-linger` is set. That is correct for a desktop and wrong for a server.

The **system** unit is a template at `/etc/systemd/system/centraid-gateway@.service`. `systemctl enable --now centraid-gateway@home` starts an instance whose data directory is `/var/lib/centraid/home`, under a uid systemd allocates (`DynamicUser=yes`) and a directory systemd owns (`StateDirectory=`). One host can run several vaults as several instances of one file. Its output goes to the journal rather than to a log path, because a `DynamicUser` service cannot write to a file it does not own — a unit with `StandardOutput=append:` under `DynamicUser` fails at start.

The keystore secret is in **neither** unit file. A unit file is world-readable and an `Environment=` value is in `/proc/<pid>/environ`, so the secret is sealed with `systemd-creds encrypt` and handed over at start through `LoadCredentialEncrypted=`. `centraid gateway install` prints the exact `systemd-creds` command; on macOS it prints the Keychain command instead, because there is no `systemd-creds` there and printing one would be a lie that looks like an instruction.

## One generator, and a test that says so

The unit files in this directory are **byte-identical copies** of what `centraid gateway install` emits — `crates/centraid/src/cmd/units.rs`'s `the_deploy_tree_copies_are_the_generator_output` test is what keeps them that way. Two copies of a unit, one documented and one installed, is how the documented one stops being true.

The generator itself is a port of v0's `packages/server/src/cli/service-unit.ts`, proved by bytes rather than by reading: `contracts/deploy/units/` holds fixtures produced by **v0's own generator** and the Rust tests reproduce them exactly. See `contracts/deploy/units/README.md` for the command.

## Installing, and the one thing this tree never does

`vps/install.sh` verifies before it unpacks (`SHA256SUMS`), checks the installed binary's identity stamp against the release that claims to have published it, and **never installs an OS service silently**. `--with-service` prints the commands; only `--yes` writes the unit, and even then enabling is left to the operator. `centraid gateway install --dry-run` writes nothing at all.

That rule is the one the release smoke depends on: `cargo xtask gate --profile release`'s `vps-smoke` step installs through this very script inside a clean container, and a smoke that enabled services would be mutating the host it is measuring.

[issue]: https://github.com/srikanth235/centraid/issues/1020
[iroh]: https://www.iroh.computer/
