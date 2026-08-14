# Centraid

**Personal software. Your data. Your apps. Your devices.**

Install an app and a local gateway runs it — on your desktop, browser, and phone — or add an automation that works your data in the background. Every app is a thin projection over one **vault** on your machine — a shared personal ontology where your people, money, documents and plans live once, accessed through grants you sign. App code is a folder of HTML + JS handlers versioned in a local git store; apps serve from the shipped release and update with it, and are authored through a harness (the builder that does that ships hidden for v1).

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
- **Automate your data** — automation templates (Google/Microsoft/GitHub/GitLab/Linear/Notion/Todoist/Slack/Dropbox connectors plus enrichers like photo captioner and document deadlines) that fire on a schedule, webhook, condition, or vault data change. Each is a saved conversation; its handler runs in a worker thread with a curated `ctx` surface (`ctx.vault`, `ctx.delegate`, `ctx.fetch`, KV state, run history). Templates still copy into the vault.
- **Connect Google without Cloud Console** — Centraid Assist uses a stateless public OAuth ceremony so desktop/PWA clients paired to a remote gateway can connect Calendar or Contacts without exposing that gateway. The browser carries only a short-lived code; tokens are sealed only on the gateway. BYO OAuth remains under Advanced. [Privacy and architecture](docs/oauth-assist.md).
- **Ask your vault** — a vault-wide assistant reads across every app through one tool register; each app also answers data questions on its own `/centraid/<id>/_turn` surface.
- **Explore the model** — **Vault Atlas** maps every kind, how kinds relate (a star centered on `core_party`), and a browsable table editor — every write going through the journalled command path.
- **Run it anywhere** — one gateway core, two hosts: a desktop-controlled local daemon or the standalone `centraid-gateway` daemon. Desktop and the installable web PWA share one React client (the PWA pairs with just a ticket over relay-only Iroh/WASM); mobile is an Expo client with native **Photos, Docs, and Agenda** over a consent-scoped offline replica, and the Centraid Companion extension adds explicit Locker fill plus web capture through a constrained paired-device profile.
- **Hosted or on-device** — databases, code, and consent stay with your gateway. Keep the vault **On this device**, or connect one storage provider for an encrypted **Hosted** copy where devices upload only framed ciphertext and the gateway verifies what the provider holds; a blank machine plus your recovery kit runs `recover` to bring the vault back, lazily.

## How it works (30 seconds)

```
  Electron desktop              Expo mobile
  (renderer = thin client)           │
        │        HTTP + Bearer       │
        ▼                            ▼
 ┌─────────────────── gateway ───────────────────────┐
 │ buildGateway() — same core, two hosts:            │
 │ desktop-controlled daemon · centraid-gateway      │
 │                                                   │
 │  app-engine        agent-runtime      automation  │
 │  declared-handler  ACP turn driver    cron+webhook│
 │  dispatcher        (one path, every   fire spine  │
 │      │             harness kind)           │      │
 │      ▼                                     ▼      │
 │  vault plane: vault.db + journal.db  scheduler    │
 │  (consent-checked commands, receipts)             │
 └───────────────────────────────────────────────────┘
```

- **Apps are folders**: `index.html` + `queries/*.js` + `actions/*.js` + `automations/<id>/` + `app.json`. No migrations and no private database — handlers reach the vault through `ctx.vault` under granted scopes (a declared **ext band** inside `vault.db` covers genuinely app-local tables). Code lives in a per-vault git store; drafts are session branches; Publish fast-forwards `main`.
- **One harness tool family** — the vault register: `vault_sql` (read-only SQL over the whole vault), `vault_invoke` (typed commands, including every app's declared handlers), `vault_content` (document text). UI buttons dispatch to the same handlers `vault_invoke` does — one calling convention.
- **Live data, no plumbing**: every action invalidates the tables it touched and subscribers re-read — bundled apps render inline in the shell and refresh off the device replica; served apps (builder preview, mobile WebViews) tail SSE on `/centraid/<id>/_changes`.

## Get started (60 seconds)

Prereqs: [Bun](https://bun.sh) ≥ 1.3, Node ≥ 24 (built-in `node:sqlite`).

```sh
bun install
bun run dev:desktop    # Electron shell; starts the local gateway by default
bun run dev:web        # installable browser client; connect it to a gateway
```

Headless / always-on instead:

```sh
bun run build
# Pair a device from the box that owns the data dir (the first pairing gets the
# revocable `owner` admin tier — there is no shared admin token, issue #505):
centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 8765
centraid-gateway pair --data-dir ./gw-data          # one-time ticket for a client
```

For Pi-class always-on hosts, prefer f2fs/btrfs or a USB SSD and mount the data volume with `noatime`. ext4 does not provide reflink clones on common Pi kernels, so daily recovery bases fall back to a full database copy; the gateway detects that fallback and logs a storage-wear warning.

Mobile companion: `bun run dev:mobile` (Expo dev build), then pair it from desktop Household → Devices with a one-time ticket or QR.

Optional model capabilities are self-contained in their recognition automation handlers. Install the local runtime dependencies and model assets with `bun run --cwd packages/model-runtime setup`; handlers load those assets directly (or from `CENTRAID_AUTOMATION_RUNTIME_DIR`) and use `ctx.vault.content` / `ctx.vault.invoke` for vault I/O. No enrichment service or gateway inference primitive is configured. The transcript recipe decodes bounded audio/video locally and runs its bundled Whisper model through the same automation path.

The PWA connects with only a pairing ticket over relay-only Iroh/WASM, so a gateway URL is not required. A standalone gateway can also serve the PWA as a same-host web origin; remote gateway connections remain ticket-only Iroh. Generated apps receive separate, single-app sessions and cannot call shell/admin routes.

Full tour: [Get started](https://centraid.dev/docs/start/) — install → vault → first app → phone → always-on, in one page.

## Layout

| Path | What it is |
| --- | --- |
| `apps/desktop` | Electron host for the shared React client; controls a detached local gateway by default and supports an in-process test path. |
| `apps/extension` | MV3 Centraid Companion for explicit Locker fill and web capture over paired Iroh/WASM. |
| `apps/web` | Vite PWA host plus its application-specific Iroh/WASM transport; embeds no gateway. |
| `apps/mobile` | Expo app for iOS / Android / web. Connects to a gateway over HTTP; embeds nothing. |
| `apps/oauth-worker` | Stateless Cloudflare Worker for Centraid Assist callback, confidential exchange, and refresh; no per-user storage. |
| `packages/client` | Browser-safe gateway client plus the React shell/UI shared by desktop and web. |
| `packages/gateway` | Host-agnostic gateway: wires everything below against injected paths/secrets. Ships the `centraid-gateway` daemon. |
| `packages/vault` | The personal ontology: `vault.db` + `journal.db` DDL, consent gateway, typed commands, sealed columns, sync/outbox spine. |
| `packages/app-engine` | Runtime engine: handler loader, declared-handler dispatcher, conversation ledger, `/centraid` HTTP surface. |
| `packages/agent-runtime` | Drives one turn through the Agent Client Protocol — the single path for every harness kind, with first-party adapters for CLIs that don't speak ACP ([docs/harnesses.md](docs/harnesses.md)); ships the vault-register tools and the `centraid` CLI. The package name is retained in v0 even though “agent” is now reserved for principals. |
| `packages/automation` | Manifest schema, fire spine, in-process scheduler, webhook ingress, worker-thread handler runner. |
| `packages/tunnel` | iroh QUIC wire protocol — device tunnel + one-time pairing; the TS reference the Swift/Kotlin mobile ports mirror. |
| `packages/blueprints` | Template gallery: 8 blueprint apps + 27 automation templates, plus blank-app scaffolders. Renders on the kit layer of `packages/design`. |
| `packages/design` | The design system in two layers: the **token** vocabulary (colors, type, spacing, app metadata, icons) shared across desktop and mobile, and the **kit** (`kit.css` / `kit.ts`) served to every blueprint app surface. |

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
- **CI:** `.github/workflows/lane-release-gateway-npm.yml` (the `gateway-npm` lane of `release.yml`) builds native on Linux/macOS/Windows, merges into pack; publishes only when `NPM_TOKEN` is set.
- **Service:** opt-in only (`--with-service` prints the command; never auto-writes unit files outside `centraid-gateway service install`).

### Pair clients after install (VPS / headless)

Start the gateway — a fresh data dir **auto-founds** one **Personal** vault at construction (issue #603). There is no founding ceremony, no founding ticket, and no first-run wall; shared vaults are created later by an explicit owner action. The only ticket concept left is the **pair ticket**, which always means _join an existing gateway_. An existing data dir is never modified.

```sh
# Fresh VPS: serve creates Personal silently, then keeps serving.
centraid-gateway serve --data-dir "$DATA_DIR"

# Mint a one-time pair ticket for a phone / PWA / desktop.
# No --vault → the registry default, the owner's Personal vault.
centraid-gateway pair --data-dir "$DATA_DIR"
centraid-gateway pair --data-dir "$DATA_DIR" --qr

# Or name a target vault explicitly.
centraid-gateway pair --data-dir "$DATA_DIR" --vault Personal
```

| Client | How to enroll |
| --- | --- |
| **Desktop** | First run offers **Start fresh on this Mac** or **Connect with a ticket**; a registered desktop pastes the ticket into **Add vault** |
| **PWA** | Ticket only — paste the one-line ticket into the first-run flow or **Add vault** |
| **Phone** | Scan the `--qr` terminal QR, **or** paste the same ticket under Settings → Desktop link |

Tickets burn on first successful redeem; a wrong secret is rejected without consuming the ticket. See [docs/recovery/pairing.md](docs/recovery/pairing.md).

## Gateway Docker (standalone)

Gateway-only image (control-plane HTTP). Build from the monorepo root:

```sh
docker build -t centraid-gateway .
# Durable vault/data and the independent wrapping credential are both required
# for real use (bare runs lose them with the container).
# Named volumes (recommended; work with non-root uid 10001):
docker volume create centraid-data
docker volume create centraid-custody
docker run --rm -p 8787:8787 \
  -v centraid-data:/data \
  -v centraid-custody:/config \
  -e CENTRAID_ALLOWED_HOSTS=gateway.example \
  centraid-gateway
# Host bind-mount: chown for uid 10001 (or chmod a+rwx for local smoke only):
#   mkdir -p "$HOME/centraid-data" "$HOME/centraid-custody"
#   chown 10001:10001 "$HOME/centraid-data" "$HOME/centraid-custody"
#   docker run ... -v "$HOME/centraid-data:/data" -v "$HOME/centraid-custody:/config" ...
```

- **Data and custody durability:** always use independent **named volumes** or bind-mounts at `/data` and `/config`. `/data` holds the wrapped gateway state; `/config` holds the external `0600` wrapping credential. Back them up separately—the data volume alone cannot decrypt `keys/`. The image declares both volumes, but anonymous volumes are easy to lose on recreate.
- **User:** process runs as UID/GID `10001`. Named volumes are created with compatible ownership; host bind-mounts need `chown 10001:10001` (or world-writable only for local smoke).
- **Host allowlist:** loopback `Host` values always work. For a public hostname in `Host`, set `CENTRAID_ALLOWED_HOSTS` or pass `--allowed-host` via a custom entrypoint. See [SECURITY.md](SECURITY.md) (control-plane subsection).
- **Tunnel:** the image **builds the native iroh relay** (`packages/tunnel/native`) into `centraid-tunnel-native.<platform>-<arch>.node`. Remote devices dial over QUIC; Docker sets `CENTRAID_REQUIRE_NATIVE_TUNNEL=1` so a missing cargo toolchain fails the image build.
- **Smoke:** path-filtered CI builds the image and probes it with a mounted `/data` (`scripts/gateway-package/smoke.mjs --base-url …`). Host-side: `bun run gateway:package:smoke`.

## Build / check

Turborepo + Bun. **Before every push**, run the early PR gates locally so CI does not burn minutes on format/lint/type errors:

```sh
bun run check:push     # the pre-push gate — the hook runs it for you (~55s)
```

`check:push` runs every push-tier gate **concurrently** and reports _all_ failures in one pass: affected tests, affected typecheck, `format:check`, `lint`, Knip, package policy, and the repo policy checks. Wall clock is bounded by the affected tests; everything else finishes inside that window. Vitest alone is not enough — package `typecheck` includes test files and catches TS errors tests still run under.

`check:pr` is the full local mirror of the CI PR gate: `check:push` plus the four gates CI recomputes authoritatively (full `typecheck`, `lint:types`, `lint:workflow-pins`, diff coverage). Run it when you want CI's answer without waiting for CI; you do not need it to push. GitHub `ci` runs `static` and `verify` in parallel (`verify` = build, native tunnel, data-plane, gateway perf, coverage), then a thin required `check` aggregator. On **main** only, `publish-report` deploys the public HTML test-health report: `https://srikanth235.github.io/centraid/test-report/main/`.

```sh
bun run build          # all apps + packages
bun run check:fast     # edit loop: format + lint + affected typecheck
bun run check:full     # shared infra: dependents + coverage + e2e
bun run test           # per-package vitest (hundreds of test files)
bun run coverage       # repo-wide v8 coverage
bun run typecheck      # turbo typecheck + tests/ tsc (check:pr; push tier uses typecheck:affected)
bun run lint:types     # type-aware lint (check:pr and CI, not the push tier)
bun run toolchain:doctor # non-mutating Ultracite/config drift check
bun run ci             # alias of check:pr
```

See [docs/toolchain.md](docs/toolchain.md) for the stable command API, rule rubric, runtime profiles, safe-fix policy, and dedicated-upgrade contract.

Desktop e2e: 55 Playwright tests across the current desktop specs, driving the real Electron app against local and remote gateway paths — see [apps/desktop/tests/e2e](apps/desktop/tests/e2e/README.md).

Web e2e: `bun run --cwd apps/web build && bun run --cwd apps/web e2e` drives the production PWA against a real gateway and verifies pairing, preview/publish, app execution, and session isolation.

Companion: `bun run --cwd apps/extension package` emits Chrome and Firefox ZIPs; its real-browser pairing/fill/revoke flow lives in [tests/agent-e2e-pairing/flows/extension-companion.md](tests/agent-e2e-pairing/flows/extension-companion.md).

## Documentation

The docs ([centraid.dev/docs](https://centraid.dev/docs/)) are Astro-built static HTML in [`scripts/docs-site`](scripts/docs-site/) — two personas, three pillars:

|  |  |
| --- | --- |
| [Start](https://centraid.dev/docs/start/) | Install → vault → first app → pair a phone → always-on → key backup |
| [Data](https://centraid.dev/docs/data/) | The vault, consent & the outbox, sealed columns, connections & sync, automations, the assistant, blobs, search |
| [Apps](https://centraid.dev/docs/apps/) | The eight blueprints, app anatomy, the install model, attach & link, the harness surface, mobile |
| [Devices](https://centraid.dev/docs/devices/) | Star topology, (gateway, vault) addressing, pairing, iroh, desktop & mobile clients, harness runtimes |
| [Ontology](https://centraid.dev/docs/ontology/) | The full logical model — schemas, entity map, ownership matrix, gateway contract, rules |
| [Privacy](https://centraid.dev/docs/privacy/) | Google user-data use, OAuth custody, retention, sharing, and deletion |
| [Terms](https://centraid.dev/docs/terms/) | Terms for Centraid and the optional Assist ceremony service |

[AGENTS.md](AGENTS.md) maps the durable docs agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
