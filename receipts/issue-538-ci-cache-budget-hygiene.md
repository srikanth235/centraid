# issue-538 — CI cache-budget hygiene: dedupe bun key + prune caches

GitHub issue: [#538](https://github.com/srikanth235/centraid/issues/538)

The repo's 10 GB Actions cache pool was saturated (10,089 MiB / 10,240 cap,
151 MiB headroom — LRU evicting continuously), dominated by **bun** (~4.2 GB) and
**turbo** (~4.6 GB) caches. Two of the three causes are bugs, not inherent cost:
a duplicated bun key scheme (~1.5 GB wasted) and unbounded per-commit turbo keys.
All numbers are measured from `gh api .../actions/caches`, not estimated.

## Checklist

- [x] unify the bun cache key in gateway-package.yml to the shared scheme
- [x] add a scheduled cache-prune workflow (dry-run first)
- [x] one-off reclaim of dead merged-PR caches

## What changed

- **unify the bun cache key in gateway-package.yml to the shared scheme** (`.github/workflows/gateway-package.yml`) — it keyed its `~/.bun/install/cache` as `${{ runner.os }}-bun-<lockhash>` (`Linux-bun-*`) while every other workflow uses `bun-${{ runner.os }}-<lockhash>` (`bun-Linux-*`). Same path, same lockfile, two namespaces → a duplicate cache family (~1.5 GB). Swapped the prefix (and its `restore-keys`) to the shared `bun-${{ runner.os }}-` scheme so all workflows pool one bun cache.
- **add a scheduled cache-prune workflow (dry-run first)** — new `.github/workflows/cache-prune.yml` (github-script) runs nightly at 08:00 UTC and on `workflow_dispatch`. Policy: delete `refs/pull/<n>/merge` caches whose PR is closed/merged (dead — only that PR's runs can read them); on `refs/heads/*`, keep the newest 2 per (ref, family) and delete the rest, where family = the key with trailing ≥32-hex content hashes stripped. Ships in report-only mode (`SCHEDULE_DRY_RUN = true`, dispatch `dry_run` default true) so the policy is confirmed against real data before any deletion is enabled.
- **one-off reclaim of dead merged-PR caches** — deleted the 4 caches owned by merged PR #533 (turbo-verify 602, turbo-static 585, turbo-client-e2e 189, cargo-iroh-wasm 62 MiB), freeing 1,438 MiB immediately (pool 10,089 → 8,709 MiB, headroom 151 → 1,531 MiB). Deleted by cache **id**, not key, because the `cargo-iroh-wasm` key is shared across refs and key-deletion would also drop the open PR #536's copy.

## Out of scope

- The mobile build-cache keying itself (#535) — this issue is only the shared
  10 GB budget the bun/turbo caches dominate.
- Dropping the `github.sha` suffix from turbo keys — the prune workflow makes it
  unnecessary and it risks turbo hit-rate. Deferred.
- Per-family budget alerting (threshold warn) — optional follow-up once the prune
  policy is proven live.

## Decisions

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

`cache-prune.yml` YAML parses and its embedded github-script passes
`node --check`; the bun-key change and the prune logic were reviewed against the
measured cache inventory. Dispatch the workflow in dry-run to see the condemned
set before enabling deletion:

```sh
# Validate locally, then dry-run on CI (report-only — deletes nothing).
node -e 'require("js-yaml").load(require("fs").readFileSync(".github/workflows/cache-prune.yml","utf8"))'
gh workflow run cache-prune.yml -f dry_run=true
```

Effect of the one-off reclaim, measured:

```sh
gh api "repos/{owner}/{repo}/actions/caches?per_page=100" \
  --jq '[.actions_caches[].size_in_bytes] | add / 1048576 | floor'
# 10089 before the 4 deletions -> 8709 after (headroom 151 -> 1531 MiB).
```

## Audit

- **A1 — PASS:** The receipt's "## What changed" section accurately describes the staged diff: gateway-package.yml unified bun cache key to shared `bun-${{ runner.os }}-` prefix scheme (matching restore-keys), cache-prune.yml added with github-script implementing dry-run-mode cache policy (SCHEDULE_DRY_RUN=true), and one-off merged-PR cache reclaim documented as already executed.
- **A2 — PASS:** All three [x] checklist items are realized in the staged diff: (1) gateway-package.yml cache key prefix changed from `${{ runner.os }}-bun-` to `bun-${{ runner.os }}-` with matching restore-keys, (2) cache-prune.yml added with nightly schedule and workflow_dispatch dry-run handling, (3) one-off reclaim of PR #533's 4 caches already executed per the "## What changed" narrative.
- **A3 — PASS:** The checklist mirrors issue #538's three proposed work items: A (unify bun key), B (scheduled prune workflow with dry-run first), and C (baseline+alert) correctly deferred as optional and out-of-scope.

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

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-955653fcda5-538-1 | 955653fc-da50-425f-95f2-bc71a62f0f63 | #538 | correction | classifier | Redirect to investigate 10GB cache quota consumption | pending | 1 | 2026-07-24T08:17:00.259Z |
