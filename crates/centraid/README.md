# `centraid` — the operator's binary

**One verb.** The vault is on the phone and the gateway is `centraid-gateway` ([`crates/gateway`](../gateway/README.md)), which writes its own service unit; what is left here is what an operator runs over a vault file by hand — [#1029](https://github.com/srikanth235/centraid/issues/1029), the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795) and [#1080](https://github.com/srikanth235/centraid/issues/1080).

Everything this crate used to hold — `gateway` as a serving role, `seat`, `pair`, `backup`, `export`, `recover`, `native-host`, `mcp`, `assist`, `automations`, `devices` — went with the seat plane, the assistant plane and the shells that consumed them, and `gateway install` went with the iroh gateway (#1080): the units it wrote ran a `centraid gateway` verb that no longer existed, and `centraid-gateway install` writes the gateway's own.

## Subcommands

| Verb | What it does |
| --- | --- |
| `centraid doctor --data-dir <dir> [--json]` | Checks a vault file: pages, foreign keys, receipt pointers (`centraid_vault::backup::restore::restore_check`). **Read-only and lock-free**, so it never changes the file it judges. The vault lives on the phone, so what it checks is a copy or a drill's restore. |

`centraid --version --json` prints the **artifact identity** (D-1020-G2): the version, the git sha, the artifact digest, the vault schema version, and whether this is a development build. It is intercepted before clap rather than modelled as a subcommand, because clap owns `--version` and `centraid version --json` would be a second spelling for everyone outside this file.

`--log` (or `CENTRAID_LOG`) takes a `RUST_LOG`-style filter. **Diagnostics go to stderr and nothing else does**, so stdout stays parseable.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | It worked. |
| `1` | The command ran and refused: no vault, a vault that will not open, or a dirty report. |
| `2` | The arguments were wrong. clap's own code, kept rather than remapped. |
| `3` | The verb exists and its implementation is not built yet. |

**Exit 3 is never a silent stub.** A verb that is not built prints what it is waiting on, cites the issue, and exits 3 — a zero exit on work that did not happen is the failure this rule exists to prevent.

## No listener

This binary opens **nothing**. The one listener in the workspace is `crates/gateway/src/server/serve.rs`, and `cargo xtask gate --lane rules`' `no-listening-socket` scans every other crate and every other file of that one. It catches more than a `TcpListener`: an endpoint that offers an ALPN or calls `accept` is a finding too, which a grep for a type name could not see.

## Related

- [`crates/gateway`](../gateway/README.md) — the gateway a member runs on their own machine
- [`docs/gateway.md`](../../docs/gateway.md) — the protocol, self-hosting and versioning
- [`deploy/README.md`](../../deploy/README.md) — the gateway image, its service unit and the VPS installer
