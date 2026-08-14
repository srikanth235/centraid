# Dev environment (G1)

Stand up Centraid development without tribal knowledge. **Do not invent a new manifest format** — promote `.claude/launch.json` when present; otherwise use the patterns below ([decisions.md](decisions.md)).

## Prerequisites

- [Bun](https://bun.sh) matching root `packageManager` (pinned in `package.json`)
- Node 24.4.1 — `.node-version` and `package.json#engines.node` must agree, and CI runs exactly this version. Locally a different Node only **warns** (#668); match it with `nvm use` if you hit a toolchain difference
- For desktop: platform deps for Electron
- For mobile: Xcode / Android SDK as needed
- Optional: Docker for `tests/agent-e2e-pairing` cross-network relay

## Fresh clone

```sh
git clone <repo-url> centraid && cd centraid
git config core.hooksPath .githooks   # once per clone
bun install
bun run build                         # packages emit dist/; blueprints regenerate manifest/vendors as needed
```

`CLAUDE.md` is a symlink to `AGENTS.md` (`ln -sf AGENTS.md CLAUDE.md`), so every agent CLI reads one manual with no sync burden. Restore the symlink if a tool ever replaces it with a copy.

Smoke:

```sh
bun run dev:desktop    # Electron + local gateway
bun run dev:web        # Vite PWA
# headless:
bun run build && centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 8765
```

## Named services and ports

| Name | Command | Default bind | Notes |
| --- | --- | --- | --- |
| **desktop** | `bun run dev:desktop` | Electron window; detached local gateway on `127.0.0.1:17832` by default | Set `CENTRAID_EMBEDDED_GATEWAY=1` only for the in-process test/E2E path |
| **web** | `bun run dev:web` | Vite default (see `apps/web`) | Needs a reachable gateway or ticket path |
| **mobile** | `bun run dev:mobile` | Metro **8081** | Pair with a ticket minted in desktop Household → Devices |
| **gateway-daemon** | `centraid-gateway serve --data-dir <dir> --host 127.0.0.1 --port 8765` | **8765** (example) | No `print-token` (retired #505). **Do not pin `CENTRAID_GATEWAY_TOKEN`** — see below. A fresh `<dir>` auto-founds `Shared` + `Personal` (#603); `centraid-gateway pair` mints a device ticket |
| **product CLI** | `centraid status --url http://127.0.0.1:8765 --token <hex>` | (client) | Wire client (`@centraid/cli`); auth via `--token` / `CENTRAID_TOKEN` / `CENTRAID_GATEWAY_TOKEN` |
| **docs site** | `bun run docs:serve` | **4173** on 127.0.0.1 | After `docs:build` / `docs:bundle` |

Parameterize ports via CLI flags / env documented on each package; do not hardcode foreign ports into other apps without a single config owner.

### `CENTRAID_GATEWAY_TOKEN`: do not pin it by hand

The daemon's loopback bearer is **derived from custody, not minted per boot**: `HMAC(endpoint-key.bin, "centraid/landlord-http/v1")` ([SECURITY.md](../SECURITY.md)). Every local process that can open the gateway's `KeyStore` — the admin CLI included — derives the same value, so **the default needs no configuration**.

Pinning `CENTRAID_GATEWAY_TOKEN` is only for a **parent process that spawns the daemon** and needs to know the bearer without deriving it (the desktop does this). If you pin it in your shell and then run `centraid-gateway pair` (or any admin verb) in a shell that does not carry the same value, the daemon rejects the CLI's derived bearer and `pair` now fails with an explicit bearer-mismatch error naming `CENTRAID_GATEWAY_TOKEN` (issue #603 — it used to lie and say "the iroh endpoint is not ready"). Either restart the daemon without the pin, or export the identical value in both shells.

The product CLI's `--token` / `CENTRAID_TOKEN` is a separate, wire-client concern and is unaffected.

## Preview the web app in a browser against an existing vault

The desktop app controls a local gateway, detached by default so it survives the window. A fresh browser origin served by a standalone gateway still lands on onboarding rather than your data. Web onboarding is **ticket-only** since issue #603 — there is no "This Mac" card and no founding probe in a browser tab, because a browser cannot start a gateway. The supported (and only) way to reach an existing vault from a browser is **pair a device**, exactly like a phone or a second desktop:

1. **Serve the existing vault.** Point a gateway at the data dir that already has the vault. Desktop's lives at `~/Library/Application Support/@centraid/desktop/gateways/local`.

   ```sh
   centraid-gateway serve --data-dir "<data-dir>" --host 127.0.0.1 --port 17832
   ```

   The gateway serves the **API** on `--port` and the **web UI on a second port** — read the exact `web app: http://127.0.0.1:<p>` line it prints on startup. The web UI it serves is the **build-time snapshot** embedded in `packages/gateway/dist/web`. To preview _uncommitted client edits_, rebuild and re-embed first (no full gateway rebuild needed):

   ```sh
   bun run --cwd apps/web build && node packages/gateway/scripts/embed-web.mjs
   ```

2. **Mint a pairing ticket** for the vault (one line; redeems only over the iroh pairing ALPN `centraid/gw-pair/1` — the HTTP `POST /centraid/_gateway/pair` twin was removed in #555):

   ```sh
   centraid-gateway pair --data-dir "<same data-dir>" --vault "<name-or-id>"
   ```

   Omitting `--vault` targets the registry default — the owner's `Personal` vault on an auto-founded gateway, never `Shared`.

3. **Open the web UI in the browser pane.** Register the web port in `.claude/launch.json` and start it with the preview tool — ad-hoc navigation to a bare `http://localhost:<port>` is policy-blocked, but a `preview_start`-managed server (a config with just a `url` **attaches** to the already-running gateway) is the sanctioned path:

   ```json
   {
     "version": "0.0.1",
     "configurations": [
       {
         "name": "centraid-web",
         "url": "http://127.0.0.1:17833",
         "port": 17833
       }
     ]
   }
   ```

4. Web onboarding opens straight on the ticket path — paste the ticket, then fill in the profile step (display name + avatar colour). The ticket step (`packages/client/src/react/shell/routes/ConnectTicketPanel.tsx`, wrapping `ConnectFlow.tsx`) is shared verbatim with desktop's **Connect with a ticket** option and the switcher's **Add vault** modal; it defaults to `methods={['gateway']}` plus `initialMethod="gateway"`, so there is no method chooser — every surface opens directly on the ticket field. The ticket redeems over iroh, records this device's EndpointId enrollment, and connects to the existing vault — its automations, runs, and data appear as in desktop.

There is no remote URL+token connection path and no SSH-routed connect (the SSH code was deleted in #603). Browser clients use iroh-wasm and the same EndpointId pairing contract. Do not point a standalone gateway at a data dir the desktop app is **also** running against: `gateway.db` rejects the second writer immediately (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

## Worktrees

Agents often work in git worktrees (including under `.claude/worktrees/`).

1. **Install** — each worktree needs its own `bun install` (do not assume root `node_modules` is visible unless you deliberately symlink — prefer install).
2. **Build** — run `bun run build` (or filtered turbo) so `dist/` exists for packages that resolve compiled output.
3. **Do not share** writable `gw-data/`, Electron `userData`, or SQLite vault dirs across concurrent agents.
4. **Symlinks** — if you symlink `node_modules` for speed, rebuild native addons for the active platform; pairing Docker flows may fetch platform-specific `@number0/iroh` binaries (see `tests/agent-e2e-pairing/AGENTS.md`).
5. **Seed data** — optional; use a dedicated `--data-dir` and vault create rather than copying a live vault (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

More traps: [traps/worktrees.md](traps/worktrees.md). Multi-agent rules: [multi-agent.md](multi-agent.md).

## Unattended desktop runs: `CENTRAID_INSECURE_DEVICE_SECRETS`

Every read of the desktop's device credentials decrypts through Electron `safeStorage`, i.e. the OS keychain. A dev build is ad-hoc signed, so macOS does not durably trust it and **re-prompts for the login password on every restart**. That makes restart-heavy scenarios — fresh gateway, warm boot, crash recovery, credential desync — impossible to drive unattended by a test harness or agent.

Set `CENTRAID_INSECURE_DEVICE_SECRETS=1` to opt into the same 0600 plaintext device-secrets file that Linux hosts without libsecret already use (`apps/desktop/src/main/gateway-secrets.ts`). One format, one code path.

- **Never takes effect in a packaged build.** The guard is `env === "1" && !app.isPackaged`, so a shipped Centraid ignores the variable outright and a real user's custody can never be downgraded by their environment.
- **Give the run its own `--user-data-dir`.** The flag refuses to touch the keychain, so it cannot read an existing _encrypted_ `connection-secrets.bin` and will throw telling you so. Reusing your real profile is the one way to make it fail confusingly.
- Switching back is automatic: run without the variable and the next read adopts the plaintext file back into keychain custody.

## `.claude/launch.json`

If a local `.claude/launch.json` exists (may be gitignored), treat it as the **named service list** for Claude/desktop launch integrations (ports, cwd, commands). Keep it in sync when you add a long-lived dev process. If absent, the table above is the source of truth until someone adds the file.

## The local gate loop

Three tiers, each with a cost budget, each enforced by a hook. Nothing here is something you have to remember to run.

| Tier | When | Cost | What runs |
| --- | --- | --- | --- |
| 0 | pre-commit | ~36s (see below) | Governance directives, plus `oxfmt` and `oxlint` **on staged files only** |
| 1 | pre-push | ~55s | `bun run check:push` — 25 gates run concurrently, wall clock bounded by affected tests |
| 1.5 | want CI's answer early | ~4 min | `bun run check:pr` — `check:push` plus full `typecheck`, `lint:types`, `lint:workflow-pins`, diff coverage |
| 2 | before requesting merge | minutes | `bun run check:full`, including dependents, coverage, mutation/perf, and client e2e |

**Why tier 1 was rebuilt (#668).** `check:pr` was the pre-push gate, and it had three compounding problems. It ran **serially** — 28 `&&`-chained steps where almost none depend on each other. It **stopped at the first failure**, so three unrelated problems cost three full passes. And four gates dominated the clock while duplicating work CI recomputes authoritatively anyway:

| Gate | Cost | Why it left the push tier |
| --- | --- | --- |
| `check:diff-coverage` | 89.4s | Instrumented full-suite run; the repo-wide `coverage` job in CI `verify` is the authoritative copy |
| `typecheck` (full) | 66.0s | `typecheck:affected` is 11s and catches the same thing on your diff; CI still runs the full one |
| `lint:types` | 21.3s | Type-aware lint over every package; low hit rate, and `static` already gates it |
| `lint:workflow-pins` | 0.1s | Only meaningful when `.github/workflows/**` changed, which the push tier cannot cheaply know |

Measured on an 8-core M-series with warm turbo caches. The remaining 25 gates run through `scripts/ci/run-gates.mjs` at a bounded concurrency, so the 24 non-test gates (including `typecheck:affected` at 24s cold) finish inside the `test:affected` window and cost nothing. **The gate now costs exactly what the affected tests cost.**

The failure report changed too, and that matters as much as the clock: every gate runs even when an earlier one fails, and the summary lists all of them with the slowest five. One pass tells you everything that is wrong.

**A gate that is always skipped enforces nothing.** `lint:node-version` demanded the _exact_ pinned Node at position three of the chain. CI satisfies that by construction (`setup-node` reads `.node-version`) and never ran the check; locally it hard-failed for anyone whose version manager defaulted elsewhere — so every push died five seconds in for a reason unrelated to the diff. It now warns locally, stays fatal under `CI`, and is wired into the `static` job where the claim is real.

**Tier 0 is over budget and the reason is upstream.** The target is 2s. The gates this repo owns hit it easily — staged-file `oxfmt` 0.16s, staged-file `oxlint` 0.09s, every repo-local directive under 0.5s. The 36s is two vendored `governance-kit` directives that are repo-wide by construction: `repo-hygiene` (18.7s, `git grep` + `git ls-files` across the tree) and `receipt-per-issue` (13.2s, re-reads the receipt corpus). Both carry digests in `.governance/packs.lock` and `managed-tree-integrity` exists to stop them being hand-edited, so scoping them to the staged set is an upstream change. Until then, `git commit` costs about half a minute; `SKIP_GOVERNANCE=1` is the pressure valve for a rapid commit loop, and CI still enforces.

**Why these tiers and not others (#576).** A CI round trip is 12.3 minutes of wall clock. Local gates do not shrink that — a green PR takes 12.3 minutes no matter what runs here — so the only thing a local gate buys is not paying those 12.3 minutes twice. That makes the rule arithmetic: a gate earns its slot if it fails more often than `local_cost / 738s`. `oxlint` at 1.7s needs a 0.2% hit rate; `knip` at 28.8s needs 3.9%; a full instrumented `coverage` run at 418s needs 57%, which is why it is scoped rather than run whole.

Tier 0 is scoped to **staged files** on purpose. A repo-wide gate at commit time fires on debt in files you never opened, and a gate that fires for someone else's mess is one people learn to bypass.

### Escape hatches

```sh
SKIP_CHECK_PR=1 git push     # skip the pre-push check:push gate only
SKIP_GOVERNANCE=1 git push   # skip every governance hook
git push --no-verify         # skip all hooks entirely
```

All three are legitimate for a WIP branch or a spike, and all three leave CI as the enforcing copy. A gate with no exit is a gate people disable permanently.

### Diff coverage

`check:diff-coverage` scores changed lines against an instrumented run, scoped to the packages the diff touches (`vitest.diff-coverage.config.ts`). A diff with no instrumentable source in it — docs, config, workflow, tests-only — skips the run entirely. The repo-wide `bun run coverage` in the CI `verify` job stays authoritative: it enforces the seeded floors and catches a file covered only by another package's tests, which a scoped run cannot see.

### What deliberately does not run locally

The strace fsync perf gate, the actionlint container, cargo data-plane, the wasm toolchain, e2e browsers, `gateway-package`, and `dependency-review`. All are platform-specific, container-bound, or rarely red — running them locally costs minutes and lowers the odds of a red CI by almost nothing. `bun run lint:actions` works if you have actionlint installed.

### How CI is shaped

`ci.yml` is the **only** workflow listening on `pull_request`, and `release.yml` the only one on `push: tags` (#557, enforced by `lint:workflow-pins`). Every PR gate is a job there, rolling up into one required `check` aggregator. Lanes the diff does not touch report `skipped`, which `check` treats as satisfied; `cancelled` is a failure. This is why the one-workflow rule is mechanical: a lane in its own path-filtered workflow reports no status on unrelated PRs, so it can never be a required check.

`static` runs the lint/typecheck gates plus matrix and ratchet. `verify` runs build, native tunnel, data-plane, gateway perf, coverage, and diff-coverage. Neither runs `test:affected` — full package vitest lives under `verify`.

## Tools only via repo scripts

Never raw `npx vitest`, `npx tsc`, etc. Use:

```sh
bun run test
bun run typecheck
bun run check:push  # the pre-push gate (the hook runs it)
bun run check:pr    # full local mirror of the CI PR gate
bun run check:full  # required for shared infrastructure
bun run format
```

Pinned toolchain lives in root `package.json` / workspaces. The complete ownership and command contract is [toolchain.md](toolchain.md).

## Related

- [multi-agent.md](multi-agent.md)
- [logs.md](logs.md)
- [README.md](../README.md)
