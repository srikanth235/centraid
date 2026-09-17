# Canonical log locations (F5)

Every debugging session (human or agent) starts here. Do not invent alternate paths in issues or skills.

## The `centraid` binary (first stop)

Every verb of the one binary — `gateway`, `seat`, `pair`, `backup`, `doctor`, `recover`, `export`, `native-host` — writes its diagnostics to **stderr** — `tracing` events one line each, plus the plain `centraid: …` refusals some verbs print — so stdout stays parseable (`crates/centraid/src/run.rs`, `install_tracing`). The filter is `--log <filter>` or `CENTRAID_LOG`, in `tracing`'s `EnvFilter` syntax; the default is `centraid=info,centraid_net=info`, and a filter that does not parse falls back to `info`.

```sh
centraid --log centraid=debug,centraid_net=debug,iroh=debug gateway --data-dir <dir>
CENTRAID_LOG=centraid_seat_link=debug centraid seat pair <ticket>
```

Two stdout lines are contracts rather than logs: `centraid gateway ready` and `centraid seat ready`, printed once the process can accept. Scripts and the desktop shell wait on them.

Where stderr lands depends on who started the process:

| Host | Where |
| --- | --- |
| A terminal | the terminal |
| macOS service (`centraid gateway install`, [`deploy/launchd`](../deploy/launchd)) | `~/Library/Logs/Centraid/gateway.out.log` and `gateway.err.log` |
| Linux per-user service ([`deploy/systemd/centraid-gateway.service`](../deploy/systemd/centraid-gateway.service)) | `~/.local/state/centraid/gateway.out.log` and `gateway.err.log` |
| Linux system service ([`deploy/systemd/system`](../deploy/systemd/system)) | the journal: `journalctl -u centraid-gateway@<instance>` — a `DynamicUser` unit cannot write to a path it does not own ([deploy/README.md](../deploy/README.md)) |
| Docker ([`deploy/docker/Dockerfile`](../deploy/docker/Dockerfile)) | the container's output: `docker logs <container>`. The health check runs `centraid doctor --data-dir /data` |
| The desktop's seat sidecar | the Electron main process's stdout — see [Desktop](#desktop) |
| A Rust integration test | nowhere, unless the test installs a subscriber. `crates/centraid/tests/walking_skeleton.rs` and `seat_identity.rs` install one reading `RUST_LOG` (default `warn`) |

The unit paths are written by `crates/centraid/src/cmd/gateway_install.rs` through `crates/centraid/src/cmd/units.rs`.

`centraid doctor --data-dir <dir> [--json]` is read-only and lock-free, so it is safe against a serving gateway; it is the first thing to run against a vault that is misbehaving. `centraid recover` prints facts to stderr and one JSON report, naming each phase, to stdout.

## Desktop

The Electron main process (`desktop/electron/src/main.ts`) writes its log to **its own stdout** — there is no log file. Run the app from a terminal to read it. Lines are prefixed by source:

| Prefix | Means |
| --- | --- |
| `[sidecar]` | the exact `centraid seat …` command line, and one `exited (<kind>): <detail>` line when the child ends |
| `[sidecar:err]` | the seat's own stderr, line by line — its `tracing` output |
| `[seat]` | notifications, `closing:` and `disconnected:` reasons from the socket, and `not revived:` when a restart was refused |
| `[startup]` | the seat did not start |
| `[quit]` | the quit sequence's steps |
| `[updater]` | the update-signature verdict (`console.info` when trusted, `console.error` when not) |

The sidecar's stdio is **piped, never ignored** (`desktop/electron/src/main/sidecar.ts`): the last 8 KiB of its stderr are kept, and `classifyExit` in `sidecar-supervisor-core.ts` reads the last three lines of that tail to explain an exit as `clean`, `refused` (exit 1), `usage` (exit 2), `signalled` or `crashed`. That tail is also what the crash-loop sentence the member sees quotes as "Last error", and what a ready-line timeout reports. A seat that died with "nothing on stderr" says so in those words.

`CENTRAID_LOG` is inherited by the sidecar from the shell's environment, so `CENTRAID_LOG=centraid=debug bun run --cwd desktop/electron start` turns the seat's debug lines on under `[sidecar:err]`.

## Mobile

The phone links the core through `centraid-core-ffi`, which emits `tracing` events (for example "this seat has no network" and the endpoint-identity refusal in `attach_network`) but **installs no subscriber**, so those events are dropped on a device. What a failing call carries back is the error the C ABI returns to the shell.

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
| Desktop Playwright under `CI` | `artifacts/test-results/desktop-seat-playwright.json`; both Playwright configs keep traces on failure (`trace: "retain-on-failure"`) |

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
| Browser devtools console (desktop renderer, extension) | Ephemeral client noise; useful but not canonical |

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
- [recovery/](recovery/) — mid-flight recovery
- [AGENTS.md](../AGENTS.md) — pointer for agents
