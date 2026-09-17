# `contracts/deploy/units/` — the service units, as bytes

Three fixtures: the byte-exact units `crates/centraid/src/cmd/units.rs` must generate, and the reference the copies checked in under `deploy/` are held to.

| Fixture | Origin | What it proves |
| --- | --- | --- |
| `centraid-gateway.user.service.expected` | **frozen golden** from the TypeScript tree's `buildSystemdUnit` | the Rust generator emits the systemd user unit byte for byte |
| `dev.centraid.gateway.plist.expected` | **frozen golden** from the TypeScript tree's `buildLaunchdPlist` | the same, for the macOS LaunchAgent |
| `centraid-gateway@.system.service.expected` | the Rust generator's own output | a regression fixture only — the templated system unit has no independent ancestor |

## Why two of them are frozen goldens

The unit semantics are load-bearing and invisible in a diff: `Restart=on-failure` with `RestartSec=5`, `After=network.target`, `WantedBy=default.target`, and launchd's `KeepAlive { SuccessfulExit = false }`, which restarts on a crash and not after a clean SIGTERM. A generator that _looked_ right could change any one of them and nothing would notice until a gateway stopped coming back. So the generator is held to bytes: the two fixtures above were written by an independent implementation's pure generators over the current exec line before the TypeScript tree was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020), and `crates/centraid/src/cmd/units.rs`'s tests assert the Rust generator reproduces them exactly. Their generator went with that tree, so a change to either file is a reviewed change to the unit's semantics.

The third fixture is different and the table says so. Nothing outside this repository has ever run those bytes, so it is a regression fixture rather than an independent proof; the first real VPS install is what confirms it (an owner hand-off in `docs/release.md`).

## The exec line

`/usr/local/bin/centraid gateway --data-dir …` — one executable, not an interpreter plus an entry script.

See `deploy/README.md` for the two systemd shapes and why the keystore secret is in neither unit file.
