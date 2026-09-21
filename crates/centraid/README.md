# `centraid` — the operator's binary

**Two verbs.** The vault is on the phone and the gateway is `centraid-gateway`
([`crates/gateway-server`](../gateway-server/README.md)); what is left here is what an operator runs
on a machine by hand — [#1029](https://github.com/srikanth235/centraid/issues/1029) and the [scope
amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795).

Everything this crate used to hold — `gateway` as a serving role, `seat`, `pair`, `backup`,
`export`, `recover`, `native-host`, `mcp`, `assist`, `automations`, `devices` — went with the seat
plane, the assistant plane and the shells that consumed them.

## Subcommands

| Verb | What it does |
| --- | --- |
| `centraid gateway install [--data-dir] [--dry-run] [--system] [--instance <name>]` | Writes an OS service unit for a gateway and prints the command that enables it. **It never enables it**: a background service that starts because a file was unpacked is a service nobody chose to run (D-1020-G1). `--dry-run` writes nothing. `--system` emits a templated systemd **system** unit — the VPS shape, because a user unit does not survive without a login session unless lingering is enabled. |
| `centraid doctor --data-dir <dir> [--json]` | Checks a vault file: pages, foreign keys, receipt pointers, the seal-key fingerprint. **Read-only and lock-free**, so it is safe against a serving process — which is why the container health check runs it. |

`centraid --version --json` prints the **artifact identity** (D-1020-G2): the version, the git sha,
the artifact digest, the vault schema version, and whether this is a development build. It is
intercepted before clap rather than modelled as a subcommand, because clap owns `--version` and
`centraid version --json` would be a second spelling for everyone outside this file.

`--log` (or `CENTRAID_LOG`) takes a `RUST_LOG`-style filter. **Diagnostics go to stderr and nothing
else does**, so stdout stays parseable.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | It worked. |
| `1` | The command ran and refused: a vault that will not open, a unit path that cannot be written. |
| `2` | The arguments were wrong. clap's own code, kept rather than remapped. |
| `3` | The verb exists and its implementation is not built yet. |

**Exit 3 is never a silent stub.** A verb that is not built prints what it is waiting on, cites the
issue, and exits 3 — a zero exit on work that did not happen is the failure this rule exists to
prevent.

## No listener

This binary opens **nothing**. The one listener in the workspace is
`crates/gateway-server/src/serve.rs`, and `cargo xtask gate --lane rules`' `no-listening-socket`
scans every other crate and every other file of that one. It catches more than a `TcpListener`: an
iroh endpoint that offers an ALPN or calls `accept` is a finding too, which a grep for a type name
could not see.

## Related

- [`crates/gateway-server`](../gateway-server/README.md) — the gateway a member runs on their laptop
- [`docs/gateway.md`](../../docs/gateway.md) — the protocol, self-hosting and versioning
- [`deploy/README.md`](../../deploy/README.md) — the container images and the service units
