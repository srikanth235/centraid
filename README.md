# Centraid

**Personal software. Your data. Your apps. Your devices.**

Install an app and a local gateway runs it — on your desktop, browser, and phone — or add an agent that works your data in the background. Every app is a thin projection over one **vault** on your machine — a shared personal ontology where your people, money, documents and plans live once, borrowed through grants you sign. App code is a folder of HTML + JS handlers versioned in a local git store; apps serve from the shipped release and update with it, and are authored by agents (the builder that does that ships hidden for v1).

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

- **Install apps** — 8 blueprint apps (Docs, Photos, Notes, People, Locker, Tally, Agenda, Tasks). Installing writes a consent row and grants the scopes the app declares — nothing is copied; apps serve from the shipped release, upgrade with it, and uninstall keeps your data.
- **Automate your data** — 16 automation templates (Google/GitHub connectors plus enrichers like photo captioner and document deadlines) that fire on a schedule, webhook, condition, or vault data change. Each is a saved conversation; its handler runs in a worker thread with a curated `ctx` surface (`ctx.vault`, `ctx.agent`, `ctx.fetch`, KV state, run history). Templates still copy into the vault.
- **Ask your vault** — a vault-wide assistant reads across every app through one tool register; each app also answers data questions on its own `/centraid/<id>/_turn` surface.
- **Explore the model** — **Vault Atlas** maps every kind, how kinds relate (a star centered on `core_party`), and a browsable table editor — every write going through the journalled command path.
- **Run it anywhere** — one gateway core, two hosts: embedded in Electron or the standalone `centraid-gateway` daemon. Desktop and the installable web PWA share one React client (the PWA pairs with just a ticket over relay-only Iroh/WASM); mobile is an Expo client with native **Photos, Docs, and Agenda** over a consent-scoped offline replica, and the Centraid Companion extension adds explicit Locker fill plus web capture through a constrained paired-device profile.
- **Hosted or on-device** — databases, code, and consent stay with your gateway. Keep the vault **On this device**, or connect one storage provider for an encrypted **Hosted** copy where devices upload only framed ciphertext and the gateway verifies what the provider holds; a blank machine plus your recovery kit runs `recover` to bring the vault back, lazily.

## How it works (30 seconds)

```
  Electron desktop              Expo mobile
  (renderer = thin client)           │
        │        HTTP + Bearer       │
        ▼                            ▼
 ┌─────────────────── gateway ───────────────────────┐
 │ buildGateway() — same core, two hosts:            │
 │ desktop embed · centraid-gateway daemon           │
 │                                                   │
 │  app-engine        agent-runtime      automation  │
 │  declared-handler  ACP turn driver    cron+webhook│
 │  dispatcher        (one path, every   fire spine  │
 │      │             runner kind)            │      │
 │      ▼                                     ▼      │
 │  vault plane: vault.db + journal.db  scheduler    │
 │  (consent-checked commands, receipts)             │
 └───────────────────────────────────────────────────┘
```

- **Apps are folders**: `index.html` + `queries/*.js` + `actions/*.js` + `automations/<id>/` + `app.json`. No migrations and no private database — handlers reach the vault through `ctx.vault` under granted scopes (a declared **ext band** inside `vault.db` covers genuinely app-local tables). Code lives in a per-vault git store; drafts are session branches; Publish fast-forwards `main`.
- **One agent tool family** — the vault register: `vault_sql` (read-only SQL over the whole vault), `vault_invoke` (typed commands, including every app's declared handlers), `vault_content` (document text). UI buttons dispatch to the same handlers `vault_invoke` does — one calling convention.
- **Live data, no plumbing**: every action invalidates the tables it touched and pushes SSE on `/centraid/<id>/_changes`; subscribed iframes re-fetch.

## Get started (60 seconds)

Prereqs: [Bun](https://bun.sh) ≥ 1.3, Node ≥ 24 (built-in `node:sqlite`).

```sh
bun install
bun run dev:desktop    # Electron shell with the local gateway embedded
bun run dev:web        # installable browser client; connect it to a gateway
```

Headless / always-on instead:

```sh
bun run build
centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 8765
centraid-gateway print-token --data-dir ./gw-data   # Bearer token for clients
```

For Pi-class always-on hosts, prefer f2fs/btrfs or a USB SSD and mount the data volume with
`noatime`. ext4 does not provide reflink clones on common Pi kernels, so daily recovery bases
fall back to a full database copy; the gateway detects that fallback and logs a storage-wear
warning.

Mobile companion: `bun run dev:mobile` (Expo dev build), then pair it via Settings → Phone on the desktop (one-time QR).

Optional device-local transcription: run an OpenAI-compatible file-ASR service such as whisper.cpp on the desktop and set `CENTRAID_DEVICE_ASR_URL` to its loopback `/v1/audio/transcriptions` endpoint. `CENTRAID_DEVICE_ASR_TOKEN` and `CENTRAID_DEVICE_ASR_MODEL` are optional. Centraid advertises the transcript work capability only while that loopback adapter answers; media and credentials stay in the Electron main process.

The PWA can connect with only a pairing ticket over relay-only Iroh/WASM, so a gateway URL is not required. Direct HTTP remains available as a fallback; in that mode the standalone gateway serves the PWA on a dedicated origin and exchanges the short-lived credential for an Origin-bound HttpOnly session. Generated apps receive separate, single-app sessions and cannot call shell/admin routes on either transport.

Full tour: [Get started](https://centraid.dev/docs/start/) — install → vault → first app → phone → always-on, in one page.

## Layout

| Path | What it is |
|---|---|
| `apps/desktop` | Electron host for the shared React client. Embeds the gateway in-process. |
| `apps/extension` | MV3 Centraid Companion for explicit Locker fill and web capture over paired Iroh/WASM. |
| `apps/web` | Vite PWA host plus its application-specific Iroh/WASM transport; embeds no gateway. |
| `apps/mobile` | Expo app for iOS / Android / web. Connects to a gateway over HTTP; embeds nothing. |
| `packages/client` | Browser-safe gateway client plus the React shell/UI shared by desktop and web. |
| `packages/gateway` | Host-agnostic gateway: wires everything below against injected paths/secrets. Ships the `centraid-gateway` daemon. |
| `packages/vault` | The personal ontology: `vault.db` + `journal.db` DDL, consent gateway, typed commands, sealed columns, sync/outbox spine. |
| `packages/app-engine` | Runtime engine: handler loader, declared-handler dispatcher, conversation ledger, `/centraid` HTTP surface. |
| `packages/agent-runtime` | Drives one turn through the Agent Client Protocol — the single path for every runner kind, with first-party adapters for CLIs that don't speak ACP ([docs/runners.md](docs/runners.md)); ships the vault-register tools and the `centraid` CLI. |
| `packages/automation` | Manifest schema, fire spine, in-process scheduler, webhook ingress, worker-thread handler runner. |
| `packages/tunnel` | iroh QUIC wire protocol — device tunnel + one-time pairing; the TS reference the Swift/Kotlin mobile ports mirror. |
| `packages/blueprints` | Template gallery: 8 blueprint apps + 16 automation templates, plus blank-app scaffolders. |
| `packages/design-tokens` | Colors, type, spacing, app metadata, icons — shared across desktop and mobile. |

## Gateway install (npm / curl|bash)

Host **gateway only** (not desktop/mobile). OpenClaw-style stages: Node ≥ 22 → npm install `@centraid/gateway` → `centraid-gateway` on PATH. **No silent OS service** — use `centraid-gateway service install` when you want H5.

### Platforms

| OS | Arch | Install | First-party tunnel NAPI |
| --- | --- | --- | --- |
| **Linux** | x64 | curl\|bash or `npm i -g @centraid/gateway` | **Required** in published packs |
| **Linux** | arm64 | same | Best-effort CI (`ubuntu-24.04-arm`) |
| **macOS** | arm64 (Apple Silicon) | curl\|bash or npm | **Required** |
| **macOS** | x64 (Intel) | curl\|bash or npm | Best-effort CI (`macos-15-intel`); preferred over `@number0/iroh` (no darwin-x64 iroh package) |
| **Windows** | x64 | **npm** (see below) | **Required** |
| **Windows** | arm64 | npm | Optional / not in default matrix |

Runtime loads `packages/tunnel/native/centraid-tunnel-native.<platform>-<arch>.node`. If missing, falls back to `@number0/iroh` when that platform package exists. Publish CI merges multi-OS natives into one `@centraid/tunnel` tarball (#511).

### Unix (macOS / Linux)

```sh
# After packages are on npm (secret-gated publish on tags / workflow_dispatch):
curl -fsSL --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/srikanth235/centraid/main/scripts/install-gateway.sh \
  | bash -s -- --no-global
# Or from a clone:
bash scripts/install-gateway.sh --help
bash scripts/install-gateway.sh --prefix "$HOME/.centraid" --version latest
# Offline / CI smoke from local packs:
bun run gateway:npm:pack
bash scripts/install-gateway.sh --prefix /tmp/centraid-gw --from-pack-dir artifacts/npm-packs
```

### Windows

Use Node 22+ and npm (PowerShell or cmd). The curl\|bash installer is Unix-oriented.

```powershell
npm install -g @centraid/gateway
centraid-gateway --help
# Prefix install (no global):
npm install --prefix $env:USERPROFILE\.centraid @centraid/gateway
```

- **Publish set:** `scripts/gateway-npm/publish-set.json` (gateway + workspace deps). Pack: `bun run gateway:npm:pack`. Publish: `bun run gateway:npm:publish` (requires `NPM_TOKEN`; dry-runs without it).
- **CI:** `.github/workflows/npm-gateway-publish.yml` builds native on Linux/macOS/Windows, merges into pack; publishes only when `NPM_TOKEN` is set.
- **Service:** opt-in only (`--with-service` prints the command; never auto-writes unit files outside `centraid-gateway service install`).

### Pair clients after install (VPS / headless)

Gateway must be serving so `endpoint.json` exists, then mint a one-time ticket:

```sh
# Create a vault if needed, then mint a ticket (desktop paste):
centraid-gateway vault create --data-dir "$DATA_DIR" --name Family
centraid-gateway pair --data-dir "$DATA_DIR" --vault Family
# Phone-friendly: same ticket + UTF-8 block QR over SSH:
centraid-gateway pair --data-dir "$DATA_DIR" --vault Family --qr
```

| Client | How to enroll |
| --- | --- |
| **Desktop / PWA** | Paste the one-line ticket into **Add gateway** |
| **Phone** | Scan the `--qr` terminal QR, **or** paste the same ticket under Settings → Gateway link |

Tickets burn on first successful redeem (or wrong secret). See [docs/recovery/pairing.md](docs/recovery/pairing.md).

## Gateway Docker (standalone)

Gateway-only image (control-plane HTTP). Build from the monorepo root:

```sh
docker build -t centraid-gateway .
# Durable vault/data — required for real use (bare runs lose /data with the container).
# Named volume (recommended; works with non-root uid 10001):
docker volume create centraid-data
docker run --rm -p 8787:8787 \
  -v centraid-data:/data \
  -e CENTRAID_ALLOWED_HOSTS=gateway.example \
  centraid-gateway
# Host bind-mount: chown for uid 10001 (or chmod a+rwx for local smoke only):
#   mkdir -p "$HOME/centraid-data" && chown 10001:10001 "$HOME/centraid-data"
#   docker run ... -v "$HOME/centraid-data:/data" ...
```

- **Data durability:** always use a **named volume** or bind-mount at `/data`. The image declares `VOLUME /data` but anonymous volumes are easy to lose on recreate.
- **User:** process runs as UID/GID `10001`. Named volumes are created with compatible ownership; host bind-mounts need `chown 10001:10001` (or world-writable only for local smoke).
- **Host allowlist:** loopback `Host` values always work. For a public hostname in `Host`, set `CENTRAID_ALLOWED_HOSTS` or pass `--allowed-host` via a custom entrypoint. See [SECURITY.md](SECURITY.md) (control-plane subsection).
- **Tunnel:** the image **builds the native iroh relay** (`packages/tunnel/native`) into `centraid-tunnel-native.<platform>-<arch>.node`. Remote devices dial over QUIC; Docker sets `CENTRAID_REQUIRE_NATIVE_TUNNEL=1` so a missing cargo toolchain fails the image build.
- **Smoke:** path-filtered CI builds the image and probes it with a mounted `/data` (`scripts/gateway-package/smoke.mjs --base-url …`). Host-side: `bun run gateway:package:smoke`.

## Build / check

Turborepo + Bun. **Before every push**, run the early PR gates locally so CI
does not burn minutes on format/lint/type errors:

```sh
bun run check:pr       # REQUIRED before push (mirrors ci.yml early steps)
```

`check:pr` is: `format:check` → `oxlint` → turbo `lint` → `typecheck` →
`lint:types` → `lint:css` → `test:matrix` (the GitHub `static` job). Vitest
alone is not enough — package `typecheck` includes test files and catches TS
errors tests still run under. GitHub `ci` runs `static` and `verify` in
parallel (`verify` = build, native tunnel, data-plane, gateway perf,
coverage), then a thin required `check` aggregator. On **main** only,
`publish-report` deploys the public HTML test-health report:
`https://srikanth235.github.io/centraid/test-report/main/`.

```sh
bun run build          # all apps + packages
bun run test           # per-package vitest (hundreds of test files)
bun run coverage       # repo-wide v8 coverage
bun run typecheck      # turbo typecheck + tests/ tsc (included in check:pr)
bun run check          # format:check + oxlint + turbo lint only
bun run lint:types     # type-aware lint (included in check:pr)
bun run ci             # alias of check:pr
```

Desktop e2e: Playwright tests across 14 scenario sections, driving the real Electron app against a mock gateway — see [apps/desktop/tests/e2e](apps/desktop/tests/e2e/README.md).

Web e2e: `bun run --cwd apps/web build && bun run --cwd apps/web e2e` drives the production PWA against a real gateway and verifies pairing, preview/publish, app execution, and session isolation.

Companion: `bun run --cwd apps/extension package` emits Chrome and Firefox ZIPs; its real-browser pairing/fill/revoke flow lives in [tests/agent-e2e-pairing/flows/extension-companion.md](tests/agent-e2e-pairing/flows/extension-companion.md).

## Documentation

The docs ([centraid.dev/docs](https://centraid.dev/docs/)) are Astro-built static HTML in [`scripts/docs-site`](scripts/docs-site/) — two personas, three pillars:

| | |
|---|---|
| [Start](https://centraid.dev/docs/start/) | Install → vault → first app → pair a phone → always-on → key backup |
| [Data](https://centraid.dev/docs/data/) | The vault, consent & the outbox, sealed columns, connections & sync, automations, the assistant, blobs, search |
| [Apps](https://centraid.dev/docs/apps/) | The eight blueprints, app anatomy, the install model, attach & link, the agent surface, mobile |
| [Devices](https://centraid.dev/docs/devices/) | Star topology, (gateway, vault) addressing, pairing, iroh, desktop & mobile clients, agent runtimes |
| [Ontology](https://centraid.dev/docs/ontology/) | The full logical model — schemas, entity map, ownership matrix, gateway contract, rules |

[AGENTS.md](AGENTS.md) maps the durable docs agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
