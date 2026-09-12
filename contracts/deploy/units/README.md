# `contracts/deploy/units/` — the service units, as bytes

Three fixtures. They are the contract between v0's unit generators and v1's, and between v1's generator and the reference copies checked in under `deploy/`.

| Fixture | Produced by | What it proves |
| --- | --- | --- |
| `centraid-gateway.user.service.expected` | **v0's** `buildSystemdUnit` | the Rust port emits the same systemd user unit v0 installs today |
| `dev.centraid.gateway.plist.expected` | **v0's** `buildLaunchdPlist` | the same, for the macOS LaunchAgent |
| `centraid-gateway@.system.service.expected` | **v1's** generator | a regression fixture only — the templated system unit has no v0 ancestor |

## Why two of them come from v0

The unit semantics are load-bearing and invisible in a diff: `Restart=on-failure` with `RestartSec=5`, `After=network.target`, `WantedBy=default.target`, and launchd's `KeepAlive { SuccessfulExit = false }`, which restarts on a crash and not after a clean SIGTERM. A port that _looked_ right could have changed any one of them and nothing would have noticed until a gateway stopped coming back. So the port is proved by bytes: the two fixtures above were written by running v0's own pure generators over the v1 exec line, and `crates/centraid/src/cmd/units.rs`'s tests assert the Rust generator reproduces them exactly.

Regenerate them — only when v0's generator itself changes, which until wave 6 it should not — with:

```bash
bun run contracts/deploy/units/export-v0-units.ts
bun run format
```

The third fixture is different and the table says so. Nothing outside this repository has ever run those bytes, so it is a regression fixture rather than a port proof; the first real VPS install is what confirms it (an owner hand-off in `docs/release.md`).

## The exec line in the fixtures is v1's

`/usr/local/bin/centraid gateway --data-dir …` — one executable, not an interpreter plus an entry script. v0's generator took `nodeBin` + `cliEntry` + `args` and joined them, so passing it the v1 command line produces exactly the unit v1 needs while still exercising v0's quoting, escaping and ordering.

See `deploy/README.md` for the two systemd shapes and why the keystore secret is in neither unit file. [#1020](https://github.com/srikanth235/centraid/issues/1020)
