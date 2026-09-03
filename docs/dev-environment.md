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
| **gateway-daemon** | `centraid-gateway serve --data-dir <dir> --host 127.0.0.1 --port 8765` | **8765** (example) | No `print-token` (retired #505). **Do not pin `CENTRAID_GATEWAY_TOKEN`** — see below. A fresh `<dir>` auto-founds `Personal` (#603); `centraid-gateway pair` mints a device ticket |
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

   The gateway serves the **API** on `--port` and the **web UI on a second port** — read the exact `web app: http://127.0.0.1:<p>` line it prints on startup. The web UI it serves is the **build-time snapshot** embedded in `packages/server/dist/web`. To preview _uncommitted client edits_, rebuild and re-embed first (no full gateway rebuild needed):

   ```sh
   bun run --cwd apps/web build && node packages/server/scripts/embed-web.mjs
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

4. Web onboarding opens straight on the ticket path — paste the ticket, enter Centraid, and set a display name or avatar colour later in Settings → You. On first entry Home automatically prepares its removable sample week so the first screen is useful without another decision. The ticket step (`packages/client/src/react/shell/routes/ConnectTicketPanel.tsx`, wrapping `ConnectFlow.tsx`) is shared verbatim with desktop's **Connect with a ticket** option and the switcher's **Add vault** modal; it defaults to `methods={['gateway']}` plus `initialMethod="gateway"`, so there is no method chooser — every surface opens directly on the ticket field. The ticket redeems over iroh, records this device's EndpointId enrollment, and connects to the existing vault — its automations, runs, and data appear as in desktop.

There is no remote URL+token connection path and no SSH-routed connect (the SSH code was deleted in #603). Browser clients use iroh-wasm and the same EndpointId pairing contract. Do not point a standalone gateway at a data dir the desktop app is **also** running against: `gateway.db` rejects the second writer immediately (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

## Worktrees

Agents often work in git worktrees (including under `.claude/worktrees/`).

1. **Install** — each worktree needs its own `bun install` (do not assume root `node_modules` is visible unless you deliberately symlink — prefer install).
2. **Build** — run `bun run build` (or filtered turbo) so `dist/` exists for packages that resolve compiled output. This bites inside one worktree too: `@centraid/server/engine` (and `@centraid/vault` from the server) resolve to `dist/`, so an engine- or vault-side source edit is invisible to an in-process `serve()` test until `bun run --cwd packages/<pkg> build` re-emits it.
3. **Do not share** writable `gw-data/`, Electron `userData`, or SQLite vault dirs across concurrent agents.
4. **Symlinks** — if you symlink `node_modules` for speed, rebuild native addons for the active platform; pairing Docker flows may fetch platform-specific `@number0/iroh` binaries (see `tests/agent-e2e-pairing/AGENTS.md`).
5. **Seed data** — optional; use a dedicated `--data-dir` and vault create rather than copying a live vault (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

More traps: [traps/worktrees.md](traps/worktrees.md). Multi-agent rules: [multi-agent.md](multi-agent.md).

### Receipts are append-only, and sibling appends merge by union

One issue carries one receipt (`receipts/issue-<N>-<slug>.md`), and a slice adds exactly one section at the **end** of it: `doc-integrity` requires the trunk's copy to stay a byte-prefix of yours. Two sibling slices appending to the same receipt therefore conflict on every rebase, always with the same correct resolution — keep both hunks, upstream first. The root `.gitattributes` marks `receipts/*.md merge=union`, and git's built-in union driver concatenates a conflicting hunk ours-then-theirs; during a `git rebase` onto `main` "ours" is `main`, so main's section lands first and the prefix survives. Check the seam afterwards: union factors out the blank line both sides share, so the second section may need one blank line reinserted before its heading — still an append, still prefix-safe.

Two things the driver does not do. It cannot tell an append from an edit — it resolves _any_ conflicting hunk the same way — so the rule it does not replace still stands: never touch text above your own section, and `doc-integrity` still fails you if you do. And GitHub's own PR mergeability check does not honour `.gitattributes` merge drivers, so this helps local rebases only; that is where the conflicts were being paid, because a branch is rebased onto `main` before it is pushed. Rebase, do not merge: `git merge` resolves union with the **checked-out** branch first, so merging `main` into a slice branch would put your section above main's and break the byte-prefix.

## Unattended desktop runs: `CENTRAID_INSECURE_DEVICE_SECRETS`

Every read of the desktop's device credentials decrypts through Electron `safeStorage`, i.e. the OS keychain. A dev build is ad-hoc signed, so macOS does not durably trust it and **re-prompts for the login password on every restart**. That makes restart-heavy scenarios — fresh gateway, warm boot, crash recovery, credential desync — impossible to drive unattended by a test harness or agent.

Set `CENTRAID_INSECURE_DEVICE_SECRETS=1` to opt into the same 0600 plaintext device-secrets file that Linux hosts without libsecret already use (`apps/desktop/src/main/gateway-secrets.ts`). One format, one code path.

- **Never takes effect in a packaged build.** The guard is `env === "1" && !app.isPackaged`, so a shipped Centraid ignores the variable outright and a real user's custody can never be downgraded by their environment.
- **Give the run its own `--user-data-dir`.** The flag refuses to touch the keychain, so it cannot read an existing _encrypted_ `connection-secrets.bin` and will throw telling you so. Reusing your real profile is the one way to make it fail confusingly.
- Switching back is automatic: run without the variable and the next read adopts the plaintext file back into keychain custody.

## `.claude/launch.json`

If a local `.claude/launch.json` exists (may be gitignored), treat it as the **named service list** for Claude/desktop launch integrations (ports, cwd, commands). Keep it in sync when you add a long-lived dev process. If absent, the table above is the source of truth until someone adds the file.

## The local gate loop

The local half of the six-rung quality ladder ([#915](https://github.com/srikanth235/centraid/issues/915)). Rungs 0 and 1 are hooks; nothing here is something you have to remember to run.

| Rung | When | Budget | Cost | What runs |
| --- | --- | --- | --- | --- |
| 0 commit | pre-commit hook | ≤ 5s | 6.2s | The governance directives that fit the budget, plus `oxfmt` and `oxlint` **on staged files only**. The two repo-wide ones are deferred to rung 1 (below) |
| 1 push | pre-push hook | ≤ 90s | bounded by `test:affected` | The deferred directives (~86s), then `bun run check:push` — **17 gate names**, run concurrently |
| 1.5 | want CI's answer early | — | ~4 min | `bun run check:pr` — `check:push` plus full `typecheck`, `lint:types`, `lint:workflow-pins`, diff coverage |
| 2 merge | PR, required `check` | ≤ 15 min | minutes | `ci.yml`. Locally: `bun run check:full`, including dependents, coverage, mutation/perf, and client e2e |
| 3 candidate | push to `main` | ≤ 45 min | — | `candidate.yml` |
| 4 nightly | 06:00 UTC on the latest candidate | ≤ 90 min | — | `e2e.yml` |
| 5 weekly | weekend on the latest candidate | ≤ 5h | — | `soak-weekly.yml`, `interop-weekly.yml`, `enrichment-live-weekly.yml`, `hygiene.yml` |

Costs are measured on this repo's CI container, which runs the governance directives about 2.7× slower than the 8-core M-series the rest of this section is measured on (`repo-hygiene` is 51.2s here against 18.7s there).

**The 17 gates are not 17 checks.** `check:push` named 59 gates while this document claimed 25. #915 Wave 4 cut the list to 17 without dropping a check, three ways:

| Move | Names | Why |
| --- | --- | --- |
| Bundle into `lint:product` | 38 → 1 | Every one runs in under a second. They are not 38 decisions a developer makes, they are one — "does this diff satisfy the repo's contracts?" — and they cost 38 of the concurrency pool's slots. `scripts/lint-product.mjs` runs them in one process at full machine parallelism with the same per-gate buffered failure output |
| Move to the weekly `hygiene.yml` | 7 → 0 | Tighten-only ratchets over the **test suite's own** quality (comment density, assertion matchers, fixed sleeps, skips, environment-red sites, the type floor, the schema/export fingerprint). Each is a _standing_ check over the whole tree, so a weekly run against `main` sees exactly what a per-push run would; what changes is detection latency, not coverage. One rolling issue on red |
| Drop to rung 2 | 1 → 0 | `check:mobile-native-state` is 30.5s and ci.yml's `mobile-smoke` job already runs it on exactly the diffs that matter |

The class and the one-line reason for every gate live in [`scripts/ci/gate-classes.json`](../scripts/ci/gate-classes.json) — **product** (a user-visible claim), **contract** (a repo-internal wiring or shape claim), **hygiene** (a ratchet over the suite itself). `scripts/ci/gate-classes.test.mjs` fails if a gate in `check:push` is unclassified, if a hygiene gate is still charged to every push, or if one left `check:push` without arriving in the weekly lane — the last is the failure mode that would make a gate enforced nowhere.

**The knobs those gates read are four files.** #915 Wave 4 also merged the twenty tighten-only JSON ledgers under `tests/` into [`tests/floors.json`](../tests/floors.json) (up-only), [`tests/budgets.json`](../tests/budgets.json) (down-only), [`tests/inventory.json`](../tests/inventory.json) (down-only, issue and expiry per exception) and [`tests/quarantine.json`](../tests/quarantine.json) (flaky tests and parked lanes). One validator, `bun run lint:ledgers`, holds the direction, the per-section waiver scope and the deadlines; it is a **contract** gate inside the `lint:product` bundle, so it costs the push tier a name of nothing and a fraction of a second. What each section holds and why two of them are references rather than copies is in [TESTING.md](../TESTING.md#the-four-ledgers-915-wave-4).

**Why rung 1 was rebuilt (#668).** `check:pr` was the pre-push gate, and it had three compounding problems. It ran **serially** — 28 `&&`-chained steps where almost none depend on each other. It **stopped at the first failure**, so three unrelated problems cost three full passes. And four gates dominated the clock while duplicating work CI recomputes authoritatively anyway:

| Gate | Cost | Why it left the push tier |
| --- | --- | --- |
| `check:diff-coverage` | 89.4s | Instrumented full-suite run; the repo-wide `coverage` job in CI `verify` is the authoritative copy |
| `typecheck` (full) | 66.0s | `typecheck:affected` is 11s and catches the same thing on your diff; CI still runs the full one |
| `lint:types` | 21.3s | Type-aware lint over every package; low hit rate, and `static` already gates it |
| `lint:workflow-pins` | 0.1s | Only meaningful when `.github/workflows/**` changed, which the push tier cannot cheaply know |

Measured on an 8-core M-series with warm turbo caches. The remaining gates run through `scripts/ci/run-gates.mjs` at a bounded concurrency, so every non-test gate (including `typecheck:affected` at 24s cold) finishes inside the `test:affected` window and costs nothing. **The gate costs exactly what the affected tests cost.**

The failure report changed too, and that matters as much as the clock: every gate runs even when an earlier one fails, and the summary lists all of them with the slowest five. One pass tells you everything that is wrong.

**A gate that is always skipped enforces nothing.** `lint:node-version` demanded the _exact_ pinned Node at position three of the chain. CI satisfies that by construction (`setup-node` reads `.node-version`) and never ran the check; locally it hard-failed for anyone whose version manager defaulted elsewhere — so every push died five seconds in for a reason unrelated to the diff. It now warns locally, stays fatal under `CI`, and is wired into the `static` job where the claim is real.

**Rung 0 was 88.7s and is now 6.2s (#915).** Two vendored `governance-kit` directives were 86.3s of it, because both are repo-wide by construction: `repo-hygiene` (51.2s, `git grep` + `git ls-files` across the tree) and `receipt-per-issue` (35.1s, re-reads the receipt corpus). Neither can be scoped to the staged set, and neither can be moved by changing its `hook:` field — both folders carry digests in `.governance/packs.lock`, so `managed-tree-integrity` fails on a hand edit, and the kit exposes no supported override (`.governance/lib.sh` reads `hook:` straight out of `directive.yaml`; `conf_get`/`conf_list` only serve keys a directive declares in its own `config:` block, and `hook` is not one).

So the deferral lives in the hooks, which the kit does not digest (`.governance/install.yaml` covers only `governance.yml`, `lib.sh` and `run.sh`): `.githooks/pre-commit` skips the ids in `.governance/conf/srikanth235/centraid/pre-commit-deferred.conf`, and `.githooks/pre-push` runs exactly those before `check:push`. **Nothing left the ladder** — `.governance/run.sh`, which CI invokes, runs every directive regardless of `hook:`, so the enforcing copy never moved. Only the local rung did, 0 → 1. The cost of the deferral is that a repo-wide hygiene violation is now caught at push instead of at commit; the cost it removed is 82 seconds on every commit, which `SKIP_GOVERNANCE=1` was the honest measure of.

What is left at rung 0 is 5.6s of directives, and the two poles are now `internal-doc-links` (2.7s) and `managed-tree-integrity` (1.4s) — also vendored, also repo-wide. On the 8-core reference machine that is ~2.1s, inside budget; on the slower CI container it is 6.2s. Neither is deferred: a broken internal link and a hand-edited managed file are exactly the "is this diff well-formed?" question rung 0 exists to answer.

**`governance.yml` cannot be given a `timeout-minutes` by hand (#915).** It is listed in `.governance/install.yaml`'s `managed_digests`, so `managed-tree-integrity` fails on any edit to it, and neither `install.yaml` nor `lib.sh` exposes a timeout setting for the generated workflow — there is no `governance` CLI vendored in this repo to regenerate it, either. Its bare `pull_request:` listener and its missing `timeout-minutes` are both legal today by the same mechanism: `scripts/lint-workflow-pins.mjs` skips any file whose first lines carry `# governance-kit:managed`, which is a whole-file exemption rather than a per-rule allowlist. The supported path to a timeout is a kit update; until one ships, this is a known, documented gap and not something to hand-patch.

**Why these tiers and not others (#576).** A CI round trip is 12.3 minutes of wall clock. Local gates do not shrink that — a green PR takes 12.3 minutes no matter what runs here — so the only thing a local gate buys is not paying those 12.3 minutes twice. That makes the rule arithmetic: a gate earns its slot if it fails more often than `local_cost / 738s`. `oxlint` at 1.7s needs a 0.2% hit rate; `knip` at 28.8s needs 3.9%; a full instrumented `coverage` run at 418s needs 57%, which is why it is scoped rather than run whole.

Rung 0 is scoped to **staged files** on purpose. A repo-wide gate at commit time fires on debt in files you never opened, and a gate that fires for someone else's mess is one people learn to bypass.

### Reaching the vault from outside it

`bun run lint:vault-sql` (tier 1, in `check:push`, and a step of the CI `static` job) fails when a file outside `packages/vault` names a physical vault table in raw SQL. The gateway is where consent is resolved, a receipt is written, and trashed rows are filtered out; a `SELECT … FROM core_event` written anywhere else walks past all three, and nothing in the type system notices. The vocabulary is **read from** `packages/vault/src/schema/entity-catalog.ts`, so a table added tomorrow is covered the day it is declared, and the plane machinery that legitimately owns tables outside the vault (replica, share/commons, broker, notices, doctor, restore, quarantine) is named in `ALLOW_LIST` in [`scripts/lint-vault-sql.mjs`](../scripts/lint-vault-sql.mjs) with one clause each. An allow-list entry whose file has stopped speaking SQL fails too — a standing allowance nothing needs is a permission slip for the next file that moves in.

It went green the way it was meant to (review lens 8.1): the three life-data readers that used to fail it — `packages/server/src/brief/daily-brief.ts`, `packages/server/src/reminders/due-reminders.ts` and `packages/server/src/enrich/semantic-search.ts` — moved behind the gateway rather than onto the allow-list.

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

`static` runs the lint/typecheck gates plus the claims ledger (`test:claims`, `lint:evidence-mapping`) and the floors ratchet. `verify` runs build, native tunnel, data-plane, gateway perf, coverage, and diff-coverage. Neither runs `test:affected` — full package vitest lives under `verify`.

**Six rungs, one question each ([#915](https://github.com/srikanth235/centraid/issues/915)).** Rungs 0 and 1 are the hooks above. Rungs 2–5 are workflows:

| Rung | Trigger | Workflow | Question | p95 budget |
| --: | --- | --- | --- | --- |
| 2 | PR, required `check` | `ci.yml` | Can this land without a regression a user would see on the phone or through the gateway? | ≤ 15 min |
| 3 | every push to `main` | `candidate.yml` | Is this SHA a build we would hand to a device — on Android **and** on iOS? | ≤ 45 min |
| 4 | 06:00 UTC, on the promoted candidate | `e2e.yml` | Does the candidate hold under depth — iOS, cross-browser, scale, chaos, adversaries? | ≤ 90 min |
| 5 | weekend, on the promoted candidate | `soak-weekly.yml`, `interop-weekly.yml`, `enrichment-live-weekly.yml`, `hygiene.yml` | Does it survive time, live dependencies, and our own suite being attacked? | ≤ 5 h |

**Lane identity is the GitHub job id** (no `name:` overrides); a matrix leg is `<job> (<leg>)`. That is what `scripts/ci/lane-health.mjs`, the evidence files and the rolling issues all key on, so renaming a job renames a lane everywhere at once.

**Rung 3 is what rungs 4 and 5 and the release chain consume.** `candidate.yml`'s `promote` job moves the git ref `refs/candidates/latest` and publishes `test-report/candidate.json` on gh-pages; every deep workflow opens with a `resolve-candidate` job (`scripts/ci/resolve-candidate.mjs`) whose fallback chain — dispatch input → the pointer → the last green `ci.yml` run on main → the run's own SHA — is printed to the step summary so the page always says which link answered. Before this, the nightly ran against whatever `main` pointed at when the cron fired, and thirty consecutive red nights could not distinguish a product regression from a dependency merge four hours earlier.

**The rung-2 budget is enforced on the run that spends it.** The `check` job (which holds `actions: read`) runs `scripts/ci/pr-gate-wall-clock.mjs`: it reads this run's own jobs, computes the **union of the `started_at → completed_at` intervals** across `check`'s `needs:` — the time during which at least one gate lane was actually running — appends the number to the Job Summary, and fails over `tests/budgets.json#suiteWallClock`'s `lanes["pr-gate"].budgetMs` (900,000 ms). It was `max(completed_at) − min(started_at)` until [#931](https://github.com/srikanth235/centraid/issues/931): the raw span charged the PR for the account's runner backlog, so a `packages/core`-only diff with every lane green failed at 16.0 min because three workflows shared the runner pool and the coverage shards queued. Overlapping lanes still collapse into one interval, so parallelism is worth exactly what it was; only the gaps in which no gate job was running are dropped. The elapsed span and the queue wait inside it are printed beside the budgeted number. **The ceiling did not move** — `tests/budgets.json` is untouched and tighten-only.

### The `build:ci` cache miss, diagnosed (#915)

[#892](https://github.com/srikanth235/centraid/issues/892) found one provable defect (a git-tracked file declared as a turbo output) and instrumented the rest; `bun run build:ci` has printed a per-task HIT/MISS table and the global hash inputs ever since. #915 read those inputs and measured the remaining miss on this tree:

- A cold `build:ci` is **349 s over 13 build tasks, and 278 s of it is `@centraid/tunnel#build`** — a release `cargo` compile behind the napi module.
- `@centraid/tunnel#build` `dependsOn: ["^build"]` → `@centraid/core#build`. With no `inputs:` declared, turbo hashes **every non-ignored file in a package**, so editing one line of `packages/core/src/blob/cbsf-properties.test.ts` moved **11 of 16 build hashes**, `@centraid/tunnel` among them. A test-file edit — which is on nearly every PR — was re-paying a Rust compile, in each of the five lanes that build.
- The fix is `turbo.json`'s `build.inputs`: `$TURBO_DEFAULT$` minus `*.test.*`, `*.spec.*`, `__tests__/**` and `**/*.md`. Every package's build is `tsc` or a bundler and none reads markdown or a test module, so the exclusions cannot produce a stale hit. Re-measured on the same tree: a test-file edit and a README edit now move **0** hashes; a real `packages/core/src` edit still moves the same 11.
- Second cause, same symptom: a turbo MISS on `@centraid/tunnel#build` degrades to a **fully cold** cargo compile in any lane without a Cargo cache. `verify` had `cargo-cache: verify` and `coverage-shard` / `coverage` did not, so identical misses cost very differently. Both now carry the preset.
- Enforcement: the three `build:ci` lanes call `bun run build:ci:floored` → [`scripts/ci/turbo-floor.mjs`](../scripts/ci/turbo-floor.mjs), which enforces `--min-hit-rate 0.15`. The number is justified by the graph — the deepest single-package change (`packages/core/src`) still leaves 3 of 13 tasks cached (≈ 23 %), so only a genuine whole-graph miss falls below it.
- **The one legitimate way to be below the floor is a global-hash change**, and the wrapper detects it rather than offering a waiver. Before enforcing, it reads the diff (merge-base three-dot against `origin/main`, falling back to a two-dot diff and then to `HEAD~1` for a main push) and checks it against `GLOBAL_HASH_INPUTS`: `bun.lock`, the **root** `package.json`, `turbo.json`, `.npmrc`, `bunfig.toml`, `Cargo.lock`, `.node-version`, `rust-toolchain*`, and `.github/actions/setup/**`. If any moved, the failure is downgraded to `::warning title=Turbo cache floor waived::` **naming the file**, and the reason is written to the Job Summary; otherwise the floor enforces. A package-local `package.json` is deliberately not a mover — that is exactly the case the floor is meant to catch. An unreadable diff (a shallow checkout with no `origin/main`) also waives, loudly, because reding a lane for the checkout depth is a false red the author cannot fix from the PR.
- There is **no flag and no environment variable that turns the floor off.** The waiver is computed from the diff, so it is an exception rather than a hole; a gate that is always red on the PRs that need it least is a gate that is off ([#915](https://github.com/srikanth235/centraid/issues/915) principle 2), and the scorecard's PR false-red target is ≤ 2 %. Do not lower the floor to make anything green, and add a path to `GLOBAL_HASH_INPUTS` only when a run has proved it moves the global hash — the `### Turbo cache` summary prints `globalCacheInputs` for exactly that.

Two things this repo cannot answer from inside the tree, recorded rather than implied: whether the GitHub-backed remote cache is actually **serving** those hits across jobs and branches, and whether the 10 GB Actions cache pool is evicting turbo entries. Both are readable from the next real run's `### Turbo cache` table (hit **source** column: `local` vs `remote`), which is why the report prints it.

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
