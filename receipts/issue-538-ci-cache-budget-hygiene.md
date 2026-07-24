# issue-538 — CI cache-budget hygiene: drop bun cache, granular turbo cache, prune

GitHub issue: [#538](https://github.com/srikanth235/centraid/issues/538)

The repo's 10 GB Actions cache pool was saturated (10,089 MiB / 10,240 cap,
151 MiB headroom — LRU evicting continuously), dominated by **bun** (~4.2 GB) and
**turbo** (~4.6 GB) caches. All numbers are measured from
`gh api .../actions/caches`, not estimated.

**The bun cache turned out to be net-negative and is removed entirely** (it was
41% of the pool). Measured across 8 recent `ci.yml` `static` runs, the
`actions/cache` restore step for `~/.bun/install/cache` alone took **11–19s**
(plus a 0–13s save), while a fully cold `bun install --frozen-lockfile` of the
whole monorepo — as the mobile jobs already run it, with no cache at all — took
**11–12s**. The cache made every job slower *and* consumed the largest single
slice of the budget, so the right number of bun cache keys is zero. This
supersedes the earlier "unify the bun key" change (commit `2cca0974`), which
merely deduplicated a cache that should not exist.

## Checklist

- [x] remove the bun install cache from all CI workflows
- [x] migrate turbo to a granular GitHub-backed remote-cache adapter
- [x] add a scheduled cache-prune workflow (dry-run first), exempting granular caches
- [x] one-off reclaim of dead merged-PR caches

## What changed

- **remove the bun install cache from all CI workflows** (`.github/workflows/ci.yml`, `.github/workflows/client-e2e-pr.yml`, `.github/workflows/interop-weekly.yml`, `.github/workflows/gateway-package.yml`) — deleted all 9 `actions/cache` steps for `~/.bun/install/cache` (the whole bun family, 41% of the pool). Measured: the cache *restore* alone was 11–19s vs an 11–12s fully-cold `bun install`, so the cache made jobs slower while dominating the budget. This supersedes the earlier "unify the bun key" change (commit `2cca0974`) — the correct number of bun cache keys is zero.
- **migrate turbo to a granular GitHub-backed remote-cache adapter** (`.github/workflows/ci.yml` ×2, `.github/workflows/client-e2e-pr.yml` ×3) — replaced the 5 `actions/cache` steps that tarred `.turbo` into a per-commit ~600 MiB blob (`turbo-static`/`turbo-verify`/`turbo-client-e2e` keys, each suffixed `-${{ github.sha }}` so every commit banked a fresh copy) with `rharkor/caching-for-turbo@v2.5.0`. The adapter runs a local server implementing turbo's native remote-cache protocol backed by the GitHub Actions cache API — caching becomes per-task and content-addressed (`turbogha_<taskhash>`), so unchanged tasks are re-read (LRU-refreshed) instead of re-saved. No external service, account, or secret: it uses the runner's built-in cache token, keeping build artifacts on GitHub in line with the repo's self-host posture.
- **add a scheduled cache-prune workflow (dry-run first), exempting granular caches** — new `.github/workflows/cache-prune.yml` (github-script) runs nightly at 08:00 UTC and on `workflow_dispatch`. Policy: delete `refs/pull/<n>/merge` caches whose PR is closed/merged (dead — only that PR's runs can read them); on `refs/heads/*`, keep the newest 2 per (ref, family) and delete the rest, where family = the key with trailing ≥32-hex content hashes stripped. The turbo adapter's `turbogha_` entries are **exempt from the keep-N rule** (each is a distinct task artifact, not a successive version, so keep-N would gut them) — GitHub LRU manages them, and dead-PR deletion still applies. Ships report-only (`SCHEDULE_DRY_RUN = true`, dispatch `dry_run` default true) so the policy is confirmed against real data before any deletion is enabled.
- **one-off reclaim of dead merged-PR caches** — deleted the 4 caches owned by merged PR #533 (turbo-verify 602, turbo-static 585, turbo-client-e2e 189, cargo-iroh-wasm 62 MiB), freeing 1,438 MiB immediately (pool 10,089 → 8,709 MiB, headroom 151 → 1,531 MiB). Deleted by cache **id**, not key, because the `cargo-iroh-wasm` key is shared across refs and key-deletion would also drop the open PR #536's copy.

## Out of scope

- The mobile build-cache keying itself (#535) — this issue is only the shared
  10 GB budget the bun/turbo caches dominate.
- A hosted turbo remote cache (Vercel Remote Cache, or the adapter's own S3/R2
  provider) — rejected in favour of the free GitHub-backed provider so no build
  artifact leaves GitHub and no account/secret is introduced (self-host posture).
- Per-family budget alerting (threshold warn) — optional follow-up once the prune
  policy is proven live.

## Decisions

- **Deleted the bun cache rather than keeping/tuning it.** Bun's installer is
  fast enough that the ~900 MiB cache restore costs more wall-clock than a cold
  install (measured), so the cache is pure liability — removing it is both a
  budget win and a speed win. The prior key-unification is left in git history as
  a superseded step, not reverted piecemeal.
- **Free GitHub-backed turbo adapter over a hosted remote cache.** The adapter
  gives turbo's native granular protocol while keeping artifacts on GitHub and
  needing no secret — the elegant fit for this repo. A hosted cache (Vercel/S3/R2)
  would be faster to wire but moves data off GitHub; declined (see Out of scope).
- **Exempted `turbogha_` from the prune's keep-N rule.** Content-addressed
  granular entries are distinct artifacts, not versions of one blob; keep-N would
  delete all but the two newest each night. They are small and recreated on
  demand, so GitHub LRU is the right manager; dead-PR deletion still applies.
- **Prune keeps newest 2 per family (not 1)** so an in-flight write or an
  entry mid-eviction still leaves a usable fallback; targets ~6–7 GB steady with
  no hit-rate loss.
- **Dry-run first.** The pool being over budget is not an emergency (LRU already
  handles it; worst case is one cold rebuild), so the workflow lands report-only
  and is flipped to deleting (`SCHEDULE_DRY_RUN = false`) after one night of real
  data confirms the condemned set.
- **Never delete on PR-state lookup failure** — a failed `pulls.get` marks the PR
  `unknown`, which is excluded from deletion, so a transient API error can never
  drop a live cache.

## Verification

All four edited workflows parse; `cache-prune.yml`'s embedded github-script
passes `node --check`; no `~/.bun/install/cache` or `.turbo` `actions/cache`
step remains, and the turbo adapter is wired into all 5 turbo-running jobs:

```sh
node -e 'for(const f of ["ci.yml","client-e2e-pr.yml","interop-weekly.yml","gateway-package.yml","cache-prune.yml"]) require("js-yaml").load(require("fs").readFileSync(".github/workflows/"+f,"utf8"))'
grep -rE "~/.bun/install/cache|path: .turbo" .github/workflows/ ; : expect no matches
grep -rc "caching-for-turbo" .github/workflows/ci.yml .github/workflows/client-e2e-pr.yml ; : expect 2 and 3
```

The bun-cache-is-slower-than-cold-install finding is reproducible from run
history (restore step vs the mobile jobs' un-cached `bun install`):

```sh
gh api "repos/{owner}/{repo}/actions/runs/<ci-run>/jobs" \
  --jq '.jobs[]|select(.name=="static").steps[]|select(.name|test("Cache Bun|bun install"))|"\(.name)"'
```

Turbo cache hits and the net job-time delta are confirmed on a CI dispatch after
this lands (the adapter logs `Cache hit`/`Cache miss` per task). Dispatch the
prune in dry-run to see its condemned set before enabling deletion:

```sh
gh workflow run cache-prune.yml -f dry_run=true
```

Effect of the one-off reclaim, measured:

```sh
gh api "repos/{owner}/{repo}/actions/caches?per_page=100" \
  --jq '[.actions_caches[].size_in_bytes] | add / 1048576 | floor'
# 10089 before the 4 deletions -> 8709 after (headroom 151 -> 1531 MiB).
```

## Audit

- **A1 — PASS:** `## What changed` correctly names all modified files (ci.yml, client-e2e-pr.yml, interop-weekly.yml, gateway-package.yml, cache-prune.yml, receipt itself) and accurately describes the staged diff: 9 bun cache `actions/cache` deletions across 4 workflows, 5 turbo tarball replacements with `rharkor/caching-for-turbo@v2.5.0` in ci.yml (×2) and client-e2e-pr.yml (×3), cache-prune.yml `EXEMPT_KEEP_N_PREFIXES` logic for `turbogha_` adapter entries, one-off reclaim narrative.
- **A2 — PASS:** All four [x] checklist items are fully realized in the staged diff: (1) bun cache deleted from all 4 workflows (9 `actions/cache` steps removed), (2) turbo migrated to GitHub-backed adapter in 5 turbo-running jobs (`rharkor/caching-for-turbo@75f8ebf4a43d2c60b23bc2a27082cfea94ffdad9`), (3) cache-prune.yml added with nightly/dispatch schedule and `EXEMPT_KEEP_N_PREFIXES = ['turbogha_']` exemption from keep-N rule, (4) one-off reclaim of PR #533's 4 caches (1,438 MiB) documented as executed.
- **A3 — PASS:** Checklist mirrors issue #538's core intent (saturated 10 GB budget, fix dominating bun/turbo caches) and all acceptance criteria (bun unified pool, turbo per-task cache, durable pruning guard); actual work expands scope from original A/B/C (full bun deletion + turbo adapter migration) and is justified in receipt's reasoning and Decisions section.

## Steering

**PASS.** One genuine human-steering event was found in the session transcript. The user redirected the agent from investigating mobile cache setup (#535) to investigating the repo's 10GB cache quota saturation at 2026-07-24T08:17:00.259Z with the message "okay, now let's tackle cache issue now.....how is our 10gb quote being consumed". This is a classifier-level correction that narrowed the scope to the budget-hygiene issue (#538).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-955653fc-da5-1784882291-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 19 | 13949 | 1787597 | 13183 | 27151 | 1.3106 | 1283 | 3459768 | 99346530 | 955097 |  |
| claude-code-955653fc-da5-1784882551-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 10 | 15526 | 918317 | 7831 | 23367 | 0.7520 | 1293 | 3475294 | 100264847 | 962928 |  |
| claude-code-955653fc-da5-1784882679-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 33 | 77559 | 3504500 | 10976 | 88568 | 2.5116 | 1326 | 3552853 | 103769347 | 973904 |  |
| claude-code-955653fc-da5-1784882753-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 9 | 5259 | 1299846 | 6363 | 11631 | 0.8419 | 1335 | 3558112 | 105069193 | 980267 |  |
| claude-code-955653fc-da5-1784882813-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 8 | 8982 | 874931 | 2573 | 11563 | 0.5580 | 1343 | 3567094 | 105944124 | 982840 |  |
| claude-code-955653fc-da5-1784884168-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 159 | 2259370 | 18997475 | 120502 | 2380031 | 26.6331 | 1502 | 5826464 | 124941599 | 1103342 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-955653fcda5-538-1 | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | correction | classifier | Redirect to investigate 10GB cache quota consumption | pending | 1 | 2026-07-24T08:17:00.259Z |
