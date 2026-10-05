# Canonical log locations (F5)

Every debugging session (human or agent) starts here. Do not invent alternate paths in issues or skills.

## The binaries (first stop)

The operator binary, `centraid`, writes its diagnostics to **stderr** — `tracing` events one line each, plus the plain `centraid: …` refusals some verbs print — so stdout stays parseable (`crates/centraid/src/run.rs`, `install_tracing`). The filter is `--log <filter>` or `CENTRAID_LOG`, in `tracing`'s `EnvFilter` syntax; the default is `centraid=info`, and a filter that does not parse falls back to `info`.

A gateway, `centraid-gateway`, logs through `tracing` to stderr under `RUST_LOG` (default `info`). Its **stdout is its interface**, not a log: `serve` prints its `gateway`, `pin` and `listening` lines once it is bound — scripts and service units wait on `listening` — the pairing QR while nothing has paired, and a `paired` line and a `safety` line each time a phone pairs.

```sh
centraid --log centraid=debug doctor --data-dir <dir>
RUST_LOG=centraid_gateway=debug centraid-gateway serve --data-dir <dir>
```

Where a gateway's output lands depends on who started it:

| Host | Where |
| --- | --- |
| A terminal | the terminal |
| macOS agent (`centraid-gateway install`) | `<data-dir>/logs/gateway.log` and `gateway.err.log` |
| Linux user unit (`centraid-gateway install`) | the user journal: `journalctl --user -u <the unit install named>` |
| A container ([deploy/README.md](../deploy/README.md)) | the container's output: `docker logs <container>` |
| A Rust integration test | nowhere, unless the test installs a subscriber. Note that `tracing` caches one `Interest` per callsite **process-wide**, so a thread-local dispatcher another test registered can leave a callsite cached at `never` — `rebuild_interest_cache` is the fix ([#1029](https://github.com/srikanth235/centraid/issues/1029) W20) |

`centraid doctor --data-dir <dir> [--json]` is read-only and lock-free, so it never changes the file it judges; it is the first thing to run against a vault file that is misbehaving — a copy off the phone, or a drill's restore (a gateway holds no vault file). A gateway's sweeps log **counts only**, because a blind store may say how many objects it read and never which ([gateway.md](gateway.md#the-sweeps)); `centraid-gateway pairings` and `health` are its state, printed on demand.

## Mobile

The phone links the core through `centraid-core-ffi`, which emits `tracing` events but **installs no subscriber**, so those events are dropped on a device. What a failing call carries back is the error the C ABI returns to the shell.

What the shells write to the platform log:

| Platform | Line | Where to read it |
| --- | --- | --- |
| Android | `Log.w("Centraid", "could not place <name>: …")` — a demo fixture could not be copied into `filesDir` (`mobile/androidApp/.../MainActivity.kt`) | `adb logcat -s Centraid` |
| iOS | `NSLog("centraid: the secure store refused a write (OSStatus %d)")` (`mobile/shared/src/iosMain/.../PlatformServices.ios.kt`) | the Xcode console, or Console.app filtered on `centraid` |
| iOS, the backup the OS runs | the background session `dev.centraid.uploads` and the windows `dev.centraid.upload-pass` and `dev.centraid.sync-pass`, in Centraid's and `nsurlsessiond`'s lines | `log collect --device`, then `log show` filtered on `process == "Centraid" OR process == "nsurlsessiond"` ([`backup-measurement.md`](../mobile/maestro/backup-measurement.md)) |

Everything else a pass knows is state the shell draws, not a log line: the backup line and the Backup screen read the core's backup status — what is confirmed, what waits and why, when each gateway was last seen ([mobile-offline.md](mobile-offline.md#the-pass)). On iOS, an upload the operating system ran settles with a code rather than a sentence — the gateway's refusal code, or the shell's own `PIN_MISMATCH`, `CANCELLED`, `TRANSPORT_<n>`, `HTTP_<status>`, `HANDOFF_NOT_HTTPS` or `SPOOL_FILE_MISSING` ([R-1080-E10](decisions.md#the-native-shells-backup-half-1080)). The Kotlin JVM suites write their reports under `mobile/**/build/reports/`.

## Gate and CI

| Context | Path |
| --- | --- |
| A failing `cargo xtask gate` step | `target/xtask/<profile>/<step>/` — `command.txt`, `stdout.log`, `stderr.log`, or `findings.txt` for the internal steps. The step's one line names the directory |
| Passing-run timings | `target/xtask/<profile>/release-build/timing.json` and `target/xtask/<profile>/restore-drill/timing.json` — evidence, not ceilings |

CI uploads, from the gate workflows:

| Workflow | Artifact | Contents | When |
| --- | --- | --- | --- |
| [`gate.yml`](../.github/workflows/gate.yml) | `gate-pr-artifacts` | `target/xtask/**` | on failure, kept 7 days |
| [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml) | `gate-nightly-artifacts` | `target/xtask/**` | on failure, kept 7 days |
| `gate-nightly.yml` | `gate-mobile-jvm-artifacts` | `target/xtask/**` and `mobile/**/build/reports/**` | on failure, kept 7 days |
| `gate-nightly.yml` | `device-lane-<lane>` | `target/xtask/**` | always, kept 14 days |

The job log itself is on GitHub Actions; every gate step prints exactly one line unless it fails.

## What is not a log

| Path | Role |
| --- | --- |
| The phone's `vault.db` | Data plus the audit band — query a copy with tools, or `centraid doctor`; never treat it as a greppable log, and never copy the live file ([traps/wal-checkpoint.md](traps/wal-checkpoint.md)) |
| The phone's `<stem>.backup.db` | The backup ledger — destinations, the queue, confirmations, snapshots. A cache of the gateways' truth, and it holds the gateways' tokens: never copy it into a ticket |
| A gateway's `state.db` | Its index — vaults, epochs, heads, the object list. Read it with `pairings`, not by hand |
| A gateway's `tls.key` | Its identity: every paired phone pins the certificate it signs. Never copy it into a ticket |

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) — on-disk layout
- [recovery/](recovery/) — mid-flight recovery
- [AGENTS.md](../AGENTS.md) — pointer for agents
