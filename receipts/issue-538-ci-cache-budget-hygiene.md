# issue-538 — CI cache-budget hygiene: drop bun cache, granular turbo cache, native LRU

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
- [x] rely on GitHub's native LRU + 7-day expiry instead of a scheduled prune workflow
- [x] one-off reclaim of dead merged-PR caches

## What changed

- **remove the bun install cache from all CI workflows** (`.github/workflows/ci.yml`, `.github/workflows/client-e2e-pr.yml`, `.github/workflows/interop-weekly.yml`, `.github/workflows/gateway-package.yml`) — deleted all 9 `actions/cache` steps for `~/.bun/install/cache` (the whole bun family, 41% of the pool). Measured: the cache *restore* alone was 11–19s vs an 11–12s fully-cold `bun install`, so the cache made jobs slower while dominating the budget. This supersedes the earlier "unify the bun key" change (commit `2cca0974`) — the correct number of bun cache keys is zero.
- **migrate turbo to a granular GitHub-backed remote-cache adapter** (`.github/workflows/ci.yml` ×2, `.github/workflows/client-e2e-pr.yml` ×3) — replaced the 5 `actions/cache` steps that tarred `.turbo` into a per-commit ~600 MiB blob (`turbo-static`/`turbo-verify`/`turbo-client-e2e` keys, each suffixed `-${{ github.sha }}` so every commit banked a fresh copy) with `rharkor/caching-for-turbo@v2.5.0`. The adapter runs a local server implementing turbo's native remote-cache protocol backed by the GitHub Actions cache API — caching becomes per-task and content-addressed (`turbogha_<taskhash>`), so unchanged tasks are re-read (LRU-refreshed) instead of re-saved. No external service, account, or secret: it uses the runner's built-in cache token, keeping build artifacts on GitHub in line with the repo's self-host posture.
- **rely on GitHub's native LRU + 7-day expiry instead of a scheduled prune workflow** — a `.github/workflows/cache-prune.yml` (github-script, keep-newest-2-per-family + dead-PR deletion, dry-run) was drafted earlier this issue and is **removed** here: it was a garbage collector for the bun+turbo saturation this issue eliminates at the source. Once the bun family is gone (produced by nothing) and turbo is granular `turbogha_` entries, the pool settles well under the 10 GB cap (measured saturating families were bun ~4.2 GB + turbo tarballs ~4.6 GB = 87% of the cap; both stop being produced), so GitHub's built-in 10 GB LRU eviction and 7-day idle expiry keep it bounded with no bespoke job. Dead merged-PR caches age out on their own within 7 days and, absent the big blobs, are too small to evict anything valuable before then. Keeping a daily `actions: write` job that deletes caches would be a standing liability guarding a pool that no longer overflows — deleting it is the structural end-state, not a regression.
- **one-off reclaim of dead merged-PR caches** — deleted the 4 caches owned by merged PR #533 (turbo-verify 602, turbo-static 585, turbo-client-e2e 189, cargo-iroh-wasm 62 MiB), freeing 1,438 MiB immediately (pool 10,089 → 8,709 MiB, headroom 151 → 1,531 MiB). Deleted by cache **id**, not key, because the `cargo-iroh-wasm` key is shared across refs and key-deletion would also drop the open PR #536's copy.

## Out of scope

- The mobile build-cache keying itself (#535) — this issue is only the shared
  10 GB budget the bun/turbo caches dominate.
- A hosted turbo remote cache (Vercel Remote Cache, or the adapter's own S3/R2
  provider) — rejected in favour of the free GitHub-backed provider so no build
  artifact leaves GitHub and no account/secret is introduced (self-host posture).
- Per-family budget alerting (threshold warn) — optional follow-up if the pool
  ever trends back toward the cap after the bun/turbo change lands on `main`.

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
- **No scheduled prune workflow — deleted the draft.** A garbage collector only
  earns its keep when the pool overflows. This issue removes the overflow at the
  source (bun family gone, turbo tarballs → small `turbogha_` entries), so the
  steady-state pool sits well under the 10 GB cap and GitHub's own LRU eviction +
  7-day idle expiry are sufficient. A daily `actions: write` job that deletes
  caches is itself a liability (delete-logic bugs, another workflow to maintain)
  and was still in dry-run — it never deleted anything, so removing it forfeits no
  live behaviour. Choosing the platform's native mechanism over a bespoke pruner
  is the same structural-over-symptomatic call as deleting the bun cache. If the
  pool ever trends back toward the cap after this lands on `main`, a pruner (or the
  budget alert in Out of scope) can be reconsidered against real data.

## Verification

All four edited workflows parse; `cache-prune.yml` is deleted (no CI ruleset or
other workflow referenced it); no `~/.bun/install/cache` or `.turbo`
`actions/cache` step remains, and the turbo adapter is wired into all 5
turbo-running jobs:

```sh
node -e 'for(const f of ["ci.yml","client-e2e-pr.yml","interop-weekly.yml","gateway-package.yml"]) require("js-yaml").load(require("fs").readFileSync(".github/workflows/"+f,"utf8"))'
test ! -e .github/workflows/cache-prune.yml ; : expect the pruner to be gone
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
this lands (the adapter logs `Cache hit`/`Cache miss` per task); `ci.yml` runs
only on `push` to `main` and on PRs, so the first live hit/miss numbers arrive
when this branch opens a PR or merges.

Effect of the one-off reclaim, measured:

```sh
gh api "repos/{owner}/{repo}/actions/caches?per_page=100" \
  --jq '[.actions_caches[].size_in_bytes] | add / 1048576 | floor'
# 10089 before the 4 deletions -> 8709 after (headroom 151 -> 1531 MiB).
```

## Audit

Re-attested by an independent sub-agent after the scheduled `cache-prune.yml`
draft was **removed** from this issue in favour of GitHub's native LRU + 7-day
expiry. The bun-deletion and turbo-adapter items were realized in earlier
commits on this branch (`8394a03c`); this final commit deletes the pruner.

- **A1 — PASS:** `## What changed` matches the staged diff — `cache-prune.yml` is deleted (not added), and the receipt's title, checklist, and prose are reframed to native-LRU. Every remaining pruner mention is past-tense ("was drafted earlier… removed"); no prose asserts a pruner ships.
- **A2 — PASS:** Every `[x]` item is coherent for a multi-commit issue; the item audited in this staged diff — "rely on GitHub's native LRU + 7-day expiry instead of a scheduled prune workflow" — is realized by the file deletion and appears verbatim in its What-changed bullet. The earlier three items (bun removal, turbo adapter, one-off reclaim) were realized in prior commits.
- **A3 — PASS:** Removing a dry-run-only GC that never deleted anything fits #538's cache-budget-hygiene intent: the structural fix (bun family gone, turbo → small content-addressed `turbogha_` entries) removes the saturation the pruner guarded, leaving GitHub's native 10 GB LRU + 7-day idle expiry sufficient. `## Decisions` explains the why; `## Verification` asserts the pruner's absence (`test ! -e`) rather than referencing it as live. Reasoning is internally consistent.

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
| claude-code-955653fc-da5-1784884297-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 21 | 11648 | 3514007 | 10108 | 21777 | 2.0826 | 1523 | 5838112 | 128455606 | 1113450 |  |
| claude-code-955653fc-da5-1784887404-1 | claude-code | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | claude-opus-4-8 | 11 | 19789 | 1385712 | 6584 | 26384 | 0.9812 | 1724 | 6413230 | 144209766 | 1304083 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-955653fcda5-538-1 | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | correction | classifier | Redirect to investigate 10GB cache quota consumption | pending | 1 | 2026-07-24T08:17:00.259Z |
