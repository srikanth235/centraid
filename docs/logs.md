# Canonical log locations (F5)

Every debugging session (human or agent) starts here. Do not invent alternate paths in issues or skills.

## The `centraid` binary (first stop)

Every verb of the one binary — `gateway`, `seat`, `pair`, `backup`, `doctor`, `recover`, `export`, `native-host` — writes its diagnostics to **stderr** — `tracing` events one line each, plus the plain `centraid: …` refusals some verbs print — so stdout stays parseable (`crates/centraid/src/run.rs`, `install_tracing`). The filter is `--log <filter>` or `CENTRAID_LOG`, in `tracing`'s `EnvFilter` syntax; the default is `centraid=info,centraid_net=info`, and a filter that does not parse falls back to `info`.

```sh
centraid --log centraid=debug,centraid_net=debug,iroh=debug gateway --data-dir <dir>
CENTRAID_LOG=centraid_seat_link=debug centraid seat pair <ticket>
```

One stdout line is a contract rather than a log: `centraid-gateway serve` prints its `endpoint` line once it can accept. Scripts and service units wait on it.

Where stderr lands depends on who started the process:

| Host | Where |
| --- | --- |
| A terminal | the terminal |
| macOS service (`centraid gateway install`, [`deploy/launchd`](../deploy/launchd)) | `~/Library/Logs/Centraid/gateway.out.log` and `gateway.err.log` |
| Linux per-user service ([`deploy/systemd/centraid-gateway.service`](../deploy/systemd/centraid-gateway.service)) | `~/.local/state/centraid/gateway.out.log` and `gateway.err.log` |
| Linux system service ([`deploy/systemd/system`](../deploy/systemd/system)) | the journal: `journalctl -u centraid-gateway@<instance>` — a `DynamicUser` unit cannot write to a path it does not own ([deploy/README.md](../deploy/README.md)) |
| Docker ([`deploy/docker/Dockerfile`](../deploy/docker/Dockerfile)) | the container's output: `docker logs <container>`. The health check runs `centraid doctor --data-dir /data` |
| A Rust integration test | nowhere, unless the test installs a subscriber. Note that `tracing` caches one `Interest` per callsite **process-wide**, so a thread-local dispatcher another test registered can leave a callsite cached at `never` — `rebuild_interest_cache` is the fix ([#1029](https://github.com/srikanth235/centraid/issues/1029) W20) |

The unit paths are written by `crates/centraid/src/cmd/gateway_install.rs` through `crates/centraid/src/cmd/units.rs`.

`centraid doctor --data-dir <dir> [--json]` is read-only and lock-free, so it is safe against a serving gateway; it is the first thing to run against a vault that is misbehaving. The laptop's gateway logs through the same filter; its sweeps log **counts only**, because a blind store may say how many objects it read and never which ([gateway.md](gateway.md#the-sweeps)).

## Mobile

The phone links the core through `centraid-core-ffi`, which emits `tracing` events but **installs no subscriber**, so those events are dropped on a device. What a failing call carries back is the error the C ABI returns to the shell.

What the shells write to the platform log:

| Platform | Line | Where to read it |
| --- | --- | --- |
| Android | `Log.w("Centraid", "could not place <name>: …")` — a demo fixture could not be copied into `filesDir` (`mobile/androidApp/.../MainActivity.kt`) | `adb logcat -s Centraid` |
| iOS | `NSLog("centraid: the secure store refused a write (OSStatus %d)")` (`mobile/shared/src/iosMain/.../PlatformServices.ios.kt`) | the Xcode console, or Console.app filtered on `centraid` |

Everything else a sync pass knows is state the shell draws, not a log line: how to tell a stale seat from a healthy one is in [mobile-offline.md](mobile-offline.md#the-seat-is-stale-how-to-tell). The Kotlin JVM suites write their reports under `mobile/**/build/reports/`.

## Gate and CI

| Context | Path |
| --- | --- |
| A failing `cargo xtask gate` step | `target/xtask/<profile>/<step>/` — `command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the internal steps. The step's one line names the directory |
| Passing-run timings | `target/xtask/<profile>/release-build/timing.json` and `target/xtask/release/restore-drill/timing.json` — evidence, not ceilings |
| A failing simulation seed | the `sim` step's output prints `SIM_SEED=<n>` and its schedule; replay with `SIM_SEED=<n> cargo test -p centraid-sim` |

CI uploads, from the gate workflows:

| Workflow | Artifact | Contents | When |
| --- | --- | --- | --- |
| [`gate.yml`](../.github/workflows/gate.yml) | `gate-pr-artifacts` | `target/xtask/**` | on failure, kept 7 days |
| [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml) | `gate-nightly-artifacts` | `target/xtask/**` | on failure, kept 7 days |
| `gate-nightly.yml` | `gate-mobile-jvm-artifacts` | `target/xtask/**` and `mobile/**/build/reports/**` | on failure, kept 7 days |
| `gate-nightly.yml` | `device-lane-<lane>` | `target/xtask/**` | always, kept 14 days |

The job log itself is on GitHub Actions; every gate step prints exactly one line unless it fails.

## Centraid Assist Worker

Cloudflare Analytics Engine dataset `centraid_oauth` is the canonical Assist edge signal. It stores only route, outcome, HTTP status, and count. The Worker emits no console events.

Keep Workers Logs, invocation logs, and automatic traces disabled for `oauth.centraid.dev`: callback query strings contain authorization code/state, and automatic traces retain full URLs. Any zone Logpush dataset must omit or redact query strings, headers, and request bodies. Never paste a raw start/bind/callback/exchange/refresh request into a ticket. Failure-ratio/429/5xx alert setup and incident handling are in [recovery/oauth-assist.md](recovery/oauth-assist.md).

## What is not a log

| Path | Role |
| --- | --- |
| `<data-dir>/vault/<vaultId>/vault.db` | Data plus the audit and ledger bands — query with tools, do not treat as greppable logs |
| `<data-dir>/wal/pending.jsonl` | The WAL capture tick's pending-tail index for the next backup generation, not a log ([traps/wal-checkpoint.md](traps/wal-checkpoint.md)) |
| `<data-dir>/keys/` | Key custody; never copy it into a ticket |

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
- [recovery/](recovery/) — mid-flight recovery
- [AGENTS.md](../AGENTS.md) — pointer for agents
