# `centraid` — the one binary

One program, two roles ([#1020](https://github.com/srikanth235/centraid/issues/1020)). Desktop bundles it, Docker wraps it, cargo-dist releases it, phones link the same crates as a static library, and the browser extension reaches it as a native-messaging host.

## The CLI is a client, not a privileged path

`centraid devices revoke`, `centraid backup now` and every other admin verb send the same `Command` messages an owner seat sends, over the same plane, and produce the same receipts. There is **no privileged code path here to audit separately**, and "revoke a lost phone from the desktop" is the same command as from the terminal. A headless gateway has no admin UI on purpose.

That is why `centraid.core.v1`'s `admin.proto` defines command _inputs_ rather than a second envelope: the CLI has no vocabulary of its own.

## Subcommands

| Verb | What it does | State in this build |
| --- | --- | --- |
| `gateway [--data-dir] [--print-qr] [--vault-name] [--relay <url> \| --no-relay]` | Runs the vault's authority: the iroh endpoint, the device allowlist and the pairing lane. Headless. | **runs** |
| `pair --mint [--no-relay]` | Mints one pair ticket and prints it. | **runs** (the ticket is not redeemable — see below) |
| `seat pair <ticket>` | Redeems a ticket against its gateway and enrols this device. | **runs** |
| `seat [--data-dir] [--thin]` | Runs a seat: replica, applier, outbox, app queries and commands. | exit 3 — `crates/seat`, wave 2 lane D2 |
| `devices list \| revoke <id>` | The device register. | exit 3 — needs `crates/vault`'s authority and receipts, wave 2 lane D1 |
| `backup now [--force]` | Takes a generation: the snapshot, the sealed WAL tail, the manifest. | **runs** (wave 2 lane R) |
| `gateway install [--dry-run] [--system] [--instance <name>] [--data-dir]` | Writes an OS service unit for this gateway and prints the command that enables it. **Never enables it**, and `--dry-run` writes nothing. | **runs** (wave 3 lane G; `deploy/README.md`) |
| `doctor --data-dir <dir> [--json]` | Checks a vault: pages, foreign keys, receipt pointers, the seal-key fingerprint. Read-only and lock-free, so it is safe against a serving gateway — which is why the container health check runs it. | **runs** (wave 3 lane G) |
| `recover --kit <file> --password-file <file> --data-dir <dir> [--at] [--full] [--yes]` | Restores from a recovery kit. | **runs** (wave 2 lane R) |
| `export [--out] [--password-file]` | Writes a portable copy: a snapshot generation plus a password-wrapped recovery kit. | **runs** (wave 2 lane R; content blobs are still owed — see that lane's receipt section) |
| `native-host` | The browser extension's native-messaging host. Launched by the browser, never by a person. | exit 3 — wave 4 |

`--log` (or `CENTRAID_LOG`) takes a `RUST_LOG`-style filter. **Diagnostics go to stderr and nothing else does**, so stdout stays parseable: the ready line, the ticket and the QR are the only things on it.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | It worked. |
| `1` | The command ran and refused: a bad ticket, a device that is not enrolled, a vault that will not open. |
| `2` | The arguments were wrong. clap's own code, kept rather than remapped. |
| `3` | The verb exists and its implementation lands in a later lane. |

**Exit 3 is never a silent stub.** A verb that is not built prints the wave and lane that owns it, cites the issue, and exits 3 — a zero exit on work that did not happen is the failure this rule exists to prevent, and it matters most for `native-host`, where a browser would otherwise believe it has a working host. `tests/no_listener.rs::every_unimplemented_verb_exits_three_and_names_its_lane` is what holds it.

## No listening TCP port

iroh is QUIC over UDP, and `centraid gateway` binds no TCP listener. Two things hold it, at two different layers:

- `cargo xtask gate` runs the `no-listening-socket` structural rule over `crates/**`, which catches the _shape_ of the mistake (`TcpListener::bind` outside a `#[cfg(feature = "blob-door")]` item).
- `tests/no_listener.rs::a_running_gateway_owns_no_listening_tcp_socket` spawns this binary, waits for its ready line, and reads the kernel's own answer out of `/proc/net/tcp` and `/proc/net/tcp6`, matching sockets to the process by inode against `/proc/<pid>/fd`. A dependency could open a listener without the string ever appearing in this repository, and only the running process can say.

On a platform with no `/proc/net/tcp` the test **skips with its reason** rather than passing silently.

The only listener this product may ever have is the wave 3 HTTPS blob door, off by default until the physical-iPhone measurement rules on it (#1020 open question 3).

## What is not durable yet

`--data-dir` is accepted and **not yet honoured**, and the gateway says so on startup. The device allowlist is a trait with an in-memory implementation in `crates/net`; the durable SQLite one lands in `crates/vault` (wave 2 lane D1) because #1020's `sql-confinement` invariant keeps SQL out of `crates/net` — see **D-1020-C8** in `crates/net/README.md`. Until then every pairing in a run is lost on exit, which is stated on stderr rather than discovered on restart.

`centraid pair --mint` has the same shape and one more caveat: it mints from a process that immediately exits, so nothing can redeem the ticket. Use `centraid gateway --print-qr` for a ticket a device can actually use.

## The ready line

`centraid gateway` prints `centraid gateway ready endpoint=<hex>` on stdout once the UDP socket is bound. A wrapper — a systemd unit, a Docker health check, the no-listener test — waits for that exact prefix. `open` never blocks on the network (#1020), so the line appears before any relay has been reached and the endpoint's first connectivity state is `OFFLINE`.
