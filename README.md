# Centraid

**Personal software. Your data. Your devices.**

Centraid is a personal, local-first **superapp**: one shell wrapping many first-party apps — on your desktop and phone, with a browser Companion — plus automations that work your data in the background. Every app is a thin projection over one **vault** — a shared personal ontology where your people, money, documents and plans live once, accessed through grants you sign — and every device you pair can hold a full copy of it. The apps ship in the release and update with it; nothing serves app code. Automations are the one thing you author yourself: a template is cloned into a user-owned folder of JS handlers, versioned in a local git store, and the compile harness edits it.

[Docs](https://centraid.dev/docs/) · [Get started](https://centraid.dev/docs/start/) · [Architecture](ARCHITECTURE.md) · [Agents map](AGENTS.md) · [Contributing](CONTRIBUTING.md)

## Maintainer and support (F4)

Centraid is **solo-maintained**. Coding agents do much of the implementation; review and release confidence are the scarce resources.

| Expectation | Reality |
| --- | --- |
| Issue response | Best-effort; no SLA. Bugs with clear repro and security reports jump the queue. |
| Feature requests | Prefer a focused [proposal](.github/ISSUE_TEMPLATE/proposal.yml); large unsolicited PRs may close. |
| Fastest support | Search [docs](https://centraid.dev/docs/), then file a **bug** with logs from [docs/logs.md](docs/logs.md). Security: [SECURITY.md](SECURITY.md) only. |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) — one focused change, linked issue, test evidence. |

## What it does

- **First-party apps** — Docs, Photos, Notes, People, Locker, Tally, Agenda and Tasks, one crate each under [`crates/apps`](crates/apps). They ship in the release and update with it; an app holds no database of its own and reads and writes the vault through typed commands under the member's grants.
- **Automate your data** — automation templates (Google/Microsoft/GitHub/GitLab/Linear/Notion/Todoist/Slack/Dropbox connectors plus enrichers like photo captioner and document deadlines) that fire on a schedule, webhook, condition, or vault data change. Each is a saved conversation; its handler runs in a worker thread with a curated `ctx` surface (`ctx.vault`, `ctx.delegate`, `ctx.fetch`, KV state, run history). Templates still copy into the vault.
- **Connect Google without Cloud Console** — Centraid Assist uses a stateless public OAuth ceremony so clients paired to a remote gateway can connect Calendar or Contacts without exposing that gateway. The browser carries only a short-lived code; tokens are sealed only on the gateway. BYO OAuth remains under Advanced. [Privacy and architecture](docs/oauth-assist.md).
- **Ask your vault** — a vault-wide assistant reads across every app through one tool register.
- **Run it anywhere** — one `centraid` binary is either the **gateway** (the vault's authority, on a VPS, a NAS or your laptop, with no open TCP port) or a **seat** (a full offline replica). Phones run a Kotlin Multiplatform shell with native SwiftUI and Compose views; the desktop is an Electron window over a `centraid seat` sidecar; the Companion extension adds explicit Locker fill through native messaging.
- **Backed up and recoverable** — the gateway writes sealed snapshot generations and a WAL stream; a blank machine plus your recovery kit runs `centraid recover` to bring the vault back.

## How it works (30 seconds)

```
   phone (KMP + SwiftUI/Compose)      desktop (Electron)        browser Companion
   core via core-ffi                  renderer ── local socket   native messaging
        │ seat                             │                          │
        │                          centraid seat (sidecar) ◄──────────┘
        │                                  │
        └──────────── iroh QUIC (no TCP listener) ─────────────┐
                                                               ▼
 ┌──────────────────────────── centraid gateway ────────────────────────────┐
 │  net: endpoint · device allowlist · pairing      blobs: BLAKE3 byte plane │
 │  vault: vault.db, the one writable connection, typed commands, receipts, │
 │         the replica log, custody, backup                                  │
 │  apps: tally · photos · notes · docs · people · locker · agenda · tasks   │
 └───────────────────────────────────────────────────────────────────────────┘
```

- **Apps are crates**: a read plane of queries as pure folds over paged reads, and an action table whose writes are the vault's typed commands. An app crate holds no SQL and no connection; SQL is confined to the vault, ontology, seat and search crates by a gate rule.
- **Every device holds the vault**: a seat bootstraps from a sanitised snapshot and then tails the gateway's replica log; offline writes are idempotent intents in the seat's own outbox, settled by the single writer.
- **One binary, no admin UI**: the CLI verbs are clients of the same command plane an owner device uses.

## Get started

Prereqs: a Rust toolchain (the version is pinned in [`rust-toolchain.toml`](rust-toolchain.toml)); [Bun](https://bun.sh) for the desktop, the extension and repository tooling; a JDK and the Android SDK or Xcode for the mobile shells ([mobile/README.md](mobile/README.md)).

```sh
cargo run -p centraid -- gateway --data-dir ./gw-data --print-qr   # a gateway, plus a one-shot pair QR
```

Scan the QR from a phone build, or redeem the ticket with `centraid seat pair "<ticket>"`. Tickets are one-shot: redemption burns them, so `--print-qr 2` mints two for two devices. Without `--data-dir` the gateway runs in memory and every pairing is lost on exit. Recovery from a bad pairing: [docs/recovery/pairing.md](docs/recovery/pairing.md).

## Layout

| Path | What it is |
| --- | --- |
| `crates/` | The Rust core. One crate family, two roles — gateway and seat — plus one crate per app, the five-symbol C ABI, the protobuf schema workspace, the iroh endpoint, the deterministic simulation and the `xtask` gate. The table with a line per crate is in [ARCHITECTURE.md](ARCHITECTURE.md#the-crates). |
| `contracts/` | The layer every language reads: the frozen golden vault, the DDL, the schema registries, the baseline migration, one frozen parity bundle per app, the screen fixtures, the desktop socket catalogue, and the down-only ledgers. |
| `mobile/` | The KMP shared module over the C ABI, the Jetpack Compose shell, the SwiftUI shell, and the Maestro flows. |
| `desktop/` | The Electron seat: one window, one `centraid seat` child, one mode-0600 local socket. |
| `extension/` | The MV3 Companion over native messaging to the `centraid` binary. No WASM, no iroh, no network of its own. |
| `packages/design`, `packages/test-kit` | The design tokens every surface lowers, and shared TypeScript test helpers. |
| `design/`, `copy/` | Emitted artifacts — the native theme and one copy leaf per app — written by one command and gated against drift. |
| `deploy/` | The container image, the OS service units and the VPS installer. |
| `centraid-city/` | A static, explorable 3D model of how Centraid works. |

## Gateway install

The gateway is the `centraid` binary; [deploy/README.md](deploy/README.md) is the whole story.

- **VPS / Linux:** [`deploy/vps/install.sh`](deploy/vps/install.sh) verifies the release's `SHA256SUMS` and the binary's identity stamp before installing, and never installs an OS service silently (`--with-service` prints the commands; `--yes` writes the unit; enabling is left to you).
- **Service units:** `centraid gateway install` writes a systemd user unit or a macOS LaunchAgent and never enables it (`--dry-run` writes nothing). The templated system unit for a server is [`deploy/systemd/system/centraid-gateway@.service`](deploy/systemd/system/centraid-gateway@.service). The keystore secret is never in a unit file: the command prints the `systemd-creds` (Linux) or Keychain (macOS) step.
- **Docker:** build from the repository root with `docker build -f deploy/docker/Dockerfile -t centraid-gateway .`, and mount durable storage at `/data` — a bare run loses its state with the container. The image runs as uid `10001`, publishes no port (iroh is QUIC over UDP), and its health check is `centraid doctor --data-dir /data`.

There is no reverse proxy, no TLS termination and no backup cron to add: the gateway binds no TCP listener, and backup is its own scheduler.

## Build / check

The tree is gated by **one command**, and it is the entrypoint CI runs:

```sh
cargo xtask gate --profile local      # the edit-run loop, warm, under 2 minutes
cargo xtask gate --profile pr         # what every pull request satisfies
cargo xtask gate --profile nightly    # pr + the deep sim, desktop and extension e2e, the device lanes
cargo xtask gate --profile release    # nightly + the restore drill + the VPS smoke
cargo xtask gate --profile mobile-jvm # the Kotlin JVM suites and the generated-artifact drift check
cargo xtask rules                     # the structural rules alone
cargo xtask repo-root                 # which tree the path-based rules will scan
cargo xtask measure --write           # the edit-run loop, into the compile-time ledger
```

Budgets and what each profile proves: [TESTING.md](TESTING.md#the-v1-gate-profiles-1020) and [docs/toolchain.md](docs/toolchain.md#v1-cargo-xtask-gate-1020). **Give every worktree its own `CARGO_TARGET_DIR`** — sharing one silently hands generated Rust between them ([docs/traps/shared-cargo-target.md](docs/traps/shared-cargo-target.md)).

The product, as one binary:

```sh
cargo run -p centraid -- gateway --data-dir ./gw-data --print-qr   # the vault's authority + a pair QR
cargo run -p centraid -- seat pair "<ticket>"                      # enrol this device
cargo run -p centraid -- seat --data-dir ./seat-data               # a full replica
cargo run -p centraid -- doctor --data-dir ./gw-data --json        # read-only, lock-free, safe against a serving gateway
cargo run -p centraid -- backup now --data-dir ./gw-data
cargo run -p centraid -- recover --kit kit.json --password-file pw --data-dir ./restored
cargo run -p centraid -- gateway install --dry-run                 # writes a unit; never enables it
```

The full verb table, with what each one's state is in this build, is [`crates/centraid/README.md`](crates/centraid/README.md#subcommands).

The shells:

```sh
cd mobile && ./gradlew mobileJvm                    # the shared module's JVM suites + the drift check
cd mobile && ANDROID_HOME=… ./gradlew -Pcentraid.android=true :androidApp:assembleDebug
bun install
bun run --cwd desktop/electron build                # the Electron seat
bun run --cwd desktop/electron test                 # its unit suites; `e2e` needs a display (xvfb-run on Linux)
bun run --cwd extension lint && bun run --cwd extension build
```

iOS needs an Apple toolchain and is an owner hand-off — the exact commands are in [`mobile/README.md`](mobile/README.md) and in [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md).

Formatting, linting and the TypeScript that remains (`packages/design`, `packages/test-kit`, `desktop/`, `extension/`, tooling) run through the root scripts: `bun run format`, `bun run lint`, `bun run typecheck`. Governance runs as `bun run governance`. See [docs/toolchain.md](docs/toolchain.md) and [docs/dev-environment.md](docs/dev-environment.md).

## Documentation

The docs ([centraid.dev/docs](https://centraid.dev/docs/)) are Astro-built static HTML in [`scripts/docs-site`](scripts/docs-site/) — two personas, three pillars:

|  |  |
| --- | --- |
| [Start](https://centraid.dev/docs/start/) | Install → vault → first app → pair a phone → always-on → key backup |
| [Data](https://centraid.dev/docs/data/) | The vault, consent & the outbox, sealed columns, connections & sync, automations, the assistant, blobs, search |
| [Apps](https://centraid.dev/docs/apps/) | The eight first-party apps, app anatomy, the install model, attach & link, the harness surface, mobile |
| [Devices](https://centraid.dev/docs/devices/) | Star topology, (gateway, vault) addressing, pairing, iroh, desktop & mobile clients, harness runtimes |
| [Ontology](https://centraid.dev/docs/ontology/) | The full logical model — schemas, entity map, ownership matrix, gateway contract, rules |
| [Privacy](https://centraid.dev/docs/privacy/) | Google user-data use, OAuth custody, retention, sharing, and deletion |
| [Terms](https://centraid.dev/docs/terms/) | Terms for Centraid and the optional Assist ceremony service |

[AGENTS.md](AGENTS.md) maps the durable docs agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
