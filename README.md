# Centraid

**Personal software. Your data. Your devices.**

Centraid is a personal, local-first **superapp**: one shell wrapping many first-party apps over one **vault** — a shared personal ontology where your people, money, documents and plans live once. In v0 that vault lives on your **phone**, which is its sole authority and sole writer, and a machine you control — your laptop, a VPS, a NAS — runs a **gateway** that holds an encrypted backup it cannot read. Recovery is 24 words. There is no account, no subscription and no Centraid-operated service ([#1029](https://github.com/srikanth235/centraid/issues/1029), [scope amendment 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795), [#1080](https://github.com/srikanth235/centraid/issues/1080)).

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

- **First-party apps** — Docs, Photos, Notes, People, Locker, Tally, Agenda and Tasks, one crate each under [`crates/apps`](crates/apps). They ship in the release and update with it; an app holds no database of its own and reads and writes the vault through typed commands.
- **The phone is the vault** — the Rust core on your phone holds `vault.db` and is its only writer. It works fully offline because there is nothing to be offline _from_.
- **Backed up to hardware you own** — every gateway you pair holds a sealed copy of the vault and of every photograph, video and file in it, and can open none of it: no key, no plaintext, no schema. The phone reaches it over HTTPS straight to the machine, pinning the certificate the gateway's QR names; on an iPhone the system keeps uploading while Centraid is closed. Pair by scanning a QR the gateway prints.
- **Recoverable from 24 words** — every key derives from one BIP39 phrase. A fresh install plus the phrase brings the vault back. There is no kit file, no password and no escrow.
- **Nothing hosted** — no account, no subscription, no Centraid-operated service, no sharing plane. See the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795).

## How it works (30 seconds)

```
   phone (KMP + SwiftUI/Compose)
   core via core-ffi
 ┌───────────────────────── the vault, and its only writer ─────────────────────┐
 │  vault: vault.db, the one writable connection, typed commands, receipts,     │
 │         custody, and the backup plane — snapshot, ranges, ledger, spool      │
 │  apps: tally · photos · notes · docs · people · locker · agenda · tasks      │
 │  blobs: the content store       identity: 24 words → every key               │
 └──────────────────────────────────────────────────────────────────────────────┘
        │  uploads sealed parts: it DIALS, and accepts nothing
        │  HTTPS straight to the gateway, its certificate pinned at pairing
        ▼
 ┌──────── centraid-gateway, on a machine you control (laptop, VPS, NAS) ───────┐
 │  a blind store: sealed parts under names it cannot invert, the head under a  │
 │  compare-and-set, the writer epoch, purge and scrub                          │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- **Apps are crates**: a read plane of queries as pure folds over paged reads, and an action table whose writes are the vault's typed commands. An app crate holds no SQL and no connection; SQL is confined to the vault, ontology and search crates and the app kit by a gate rule.
- **The gateway is a protocol, not a program**: [`crates/gateway`](crates/gateway)'s `rules` hold every decision with no I/O, with a conformance suite that runs in memory and over the wire, and the server is one adapter over them. See [docs/gateway.md](docs/gateway.md).
- **The phone opens nothing**: `no-listening-socket` is a structural gate rule, and it refuses a listener or an accept anywhere but the gateway's one serve file.

## Get started

Prereqs: a Rust toolchain (the version is pinned in [`rust-toolchain.toml`](rust-toolchain.toml)); [Bun](https://bun.sh) for `packages/design` and repository tooling; a JDK and the Android SDK or Xcode for the mobile shells ([mobile/README.md](mobile/README.md)).

```sh
# the gateway: mints its identity, listens on 8443, and prints a pairing QR
cargo run -p centraid-gateway --bin centraid-gateway -- serve --data-dir ./gw-data

# another QR, beside a running serve
cargo run -p centraid-gateway --bin centraid-gateway -- pair --data-dir ./gw-data
```

Scan the QR from a phone build, then compare the safety number the phone shows with the `safety` line `serve` prints once it pairs. A QR admits one phone's vault, once, within a day, so a second phone needs a second `pair`. Recovery from a bad pairing: [docs/recovery/pairing.md](docs/recovery/pairing.md).

## Layout

| Path | What it is |
| --- | --- |
| `crates/` | The Rust core: the identity model, the vault and its backup plane, the ontology, the gateway protocol and its one deployment, the byte plane, one crate per app, the five-symbol C ABI, the protobuf schema workspace and the `xtask` gate. A line per crate is in [ARCHITECTURE.md](ARCHITECTURE.md#the-crates). |
| `contracts/` | The layer every language reads: the frozen golden vault, the DDL, the schema registries, the migration ladder, one frozen parity bundle per app, the screen fixtures, the crypto vectors and the down-only ledgers. |
| `mobile/` | The KMP shared module over the C ABI, the Jetpack Compose shell, the SwiftUI shell, and the Maestro flows. **The only shell.** |
| `packages/design`, `packages/test-kit` | The design tokens every surface lowers, and shared TypeScript test helpers. |
| `design/`, `copy/` | Emitted artifacts — the native theme and one copy leaf per app — written by one command and gated against drift. |
| `deploy/` | The container images, the OS service units and the installer. |
| `centraid-city/` | A static, explorable 3D model of how Centraid works. |

## Gateway install

The gateway is the `centraid-gateway` binary, on any machine you control; [deploy/README.md](deploy/README.md) is the whole story, and the protocol it serves is [docs/gateway.md](docs/gateway.md).

- **VPS / Linux:** [`deploy/vps/install.sh`](deploy/vps/install.sh) verifies the release's `SHA256SUMS` and the binary's identity stamp before installing, and never installs an OS service silently (`--with-service` prints the commands; `--yes` writes the unit; enabling is left to you).
- **Service units:** `centraid-gateway install` writes a systemd user unit or a macOS LaunchAgent and never enables it (`--dry-run` writes nothing). No credential goes in any unit: the gateway is blind, and its data directory holds nothing that opens a vault.
- **Docker:** run on the host's network and mount durable storage at the data directory — a bare run loses the gateway's identity with the container, and every paired phone then refuses its replacement. The phone dials the addresses the pairing QR lists, which a container's own network would not make reachable.

**Nothing goes in front of it.** The phone opens HTTPS straight to the gateway and pins the certificate the gateway minted, so there is no reverse proxy, no TLS termination, no domain and no certificate authority; a port forward or a VPN is how a gateway away from home is reached ([docs/gateway.md](docs/gateway.md#self-hosting)).

## Build / check

The tree is gated by **one command**, and it is the entrypoint CI runs:

```sh
cargo xtask gate --profile local      # the edit-run loop, warm, under 2 minutes
cargo xtask gate --profile pr         # what every pull request satisfies
cargo xtask gate --profile nightly    # pr + the device lanes and the deeper suites
cargo xtask gate --profile release    # nightly + the restore drill + the VPS smoke
cargo xtask gate --profile mobile-jvm # the Kotlin JVM suites and the generated-artifact drift check
cargo xtask rules                     # the structural rules alone
cargo xtask repo-root                 # which tree the path-based rules will scan
cargo xtask measure --write           # the edit-run loop, into the compile-time ledger
```

Budgets and what each profile proves: [TESTING.md](TESTING.md#the-v1-gate-profiles-1020) and [docs/toolchain.md](docs/toolchain.md#v1-cargo-xtask-gate-1020). **Give every worktree its own `CARGO_TARGET_DIR`** — sharing one silently hands generated Rust between them ([docs/traps/shared-cargo-target.md](docs/traps/shared-cargo-target.md)).

The product's binaries:

```sh
# a gateway
cargo run -p centraid-gateway --bin centraid-gateway -- serve    --data-dir ./gw-data
cargo run -p centraid-gateway --bin centraid-gateway -- pair     --data-dir ./gw-data
cargo run -p centraid-gateway --bin centraid-gateway -- pairings --data-dir ./gw-data
cargo run -p centraid-gateway --bin centraid-gateway -- scrub    --data-dir ./gw-data
cargo run -p centraid-gateway --bin centraid-gateway -- health   --data-dir ./gw-data
cargo run -p centraid-gateway --bin centraid-gateway -- install  --data-dir ./gw-data --dry-run

# the operator's binary
cargo run -p centraid -- doctor --data-dir ./gw-data --json   # read-only, lock-free
```

The vault itself has no CLI: it lives on the phone, and every verb that used to reach it — `seat`, `pair`, `backup`, `export`, `recover`, `native-host` — went with the seat plane.

The full verb table, with what each one's state is in this build, is [`crates/centraid/README.md`](crates/centraid/README.md#subcommands).

The shells:

```sh
cd mobile && ./gradlew mobileJvm                    # the shared module's JVM suites + the drift check
cd mobile && ANDROID_HOME=… ./gradlew -Pcentraid.android=true :androidApp:assembleDebug
bun install
```

iOS needs an Apple toolchain and is an owner hand-off — the exact commands are in [`mobile/README.md`](mobile/README.md) and in [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md).

Formatting, linting and the TypeScript that remains (`packages/design`, `packages/test-kit` and the tooling under `scripts/`) run through the root scripts: `bun run format`, `bun run lint`, `bun run typecheck`. Governance runs as `bun run governance`. See [docs/toolchain.md](docs/toolchain.md) and [docs/dev-environment.md](docs/dev-environment.md).

## Documentation

The docs ([centraid.dev/docs](https://centraid.dev/docs/)) are Astro-built static HTML in [`scripts/docs-site`](scripts/docs-site/) — two personas, three pillars:

|  |  |
| --- | --- |
| [Start](https://centraid.dev/docs/start/) | Install → vault → first app → pair a phone → always-on → key backup |
| [Data](https://centraid.dev/docs/data/) | The vault, consent & the outbox, sealed columns, connections & sync, automations, the assistant, blobs, search |
| [Apps](https://centraid.dev/docs/apps/) | The eight first-party apps, app anatomy, the install model, attach & link, the harness surface, mobile |
| [Devices](https://centraid.dev/docs/devices/) | Pairing, the gateway, and the mobile client. **Pending a rewrite for [#1080](https://github.com/srikanth235/centraid/issues/1080)** — the site still describes the iroh carrier |
| [Ontology](https://centraid.dev/docs/ontology/) | The full logical model — schemas, entity map, ownership matrix, gateway contract, rules |
| [Privacy](https://centraid.dev/docs/privacy/) | What Centraid holds and where. **Pending a rewrite for v0** — its Google/Assist sections describe a path this release does not offer |
| [Terms](https://centraid.dev/docs/terms/) | Terms for Centraid. **Pending a rewrite for v0**, for the same reason |

[AGENTS.md](AGENTS.md) maps the durable docs agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
