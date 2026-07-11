# issue-356 — Blueprint apps double-fetch React on every open + zero asset caching

GitHub issue: [#356](https://github.com/srikanth235/centraid/issues/356)

Every blueprint app double-downloaded the 313KB vendored React bundle on
every open (a depth-unaware JSX-runtime specifier rewrite made nested
`components/*.jsx` files request `components/jsx-runtime.js` →
`components/react-core.min.js`, silently satisfied by the basename
shared-asset fallback), and no blueprint static asset carried any cache
header, so ~876KB re-transferred in full on every open. This lands the
two fixes the issue scopes as the starting point (Tier 1 + Tier 2) plus
the measurement probe that grounds the numbers.

## Checklist

- [x] Commit 1 — depth-aware jsx-runtime rewrite + ETag/304 asset caching
- [x] Commit 2 — blueprints jsdom tier: depth-aware mirror + cwd-independent roots
- [ ] Commit 3 — open-waterfall measurement probe

## What changed

### Commit 1 — depth-aware jsx-runtime rewrite + ETag/304 asset caching

`packages/app-engine/src/http/static-server.ts`:

- **Tier 1 (double-fetch).** esbuild's automatic JSX runtime emits
  `import { jsx } from "./jsx-runtime"` relative to the importing file's
  directory; the old rewrite only appended `.js`, so any
  `components/*.jsx` file requested `components/jsx-runtime.js` — one
  directory too deep — and the basename-keyed shared-asset fallback
  served it silently, whose own `./react-core.min.js` re-export then
  pulled a second full copy of the 313KB React bundle. New
  `jsxRuntimeClimb(rel)` derives the served file's directory depth from
  the request path and rewrites the specifier to climb back to the app
  root (`../`×depth); the JSX transform cache key gains the depth
  (`${file}\0${depth}`) so a depth mismatch can never serve another
  depth's cached rewrite.
- **Fallback tightened.** The `SHARED_ASSET_FILES` fallback now applies
  to root-level requests only — a nested request such as
  `components/react-core.min.js` 404s loudly instead of masking a future
  depth bug (every legitimate reference resolves to a root-level URL).
- **Tier 2 (caching).** `serveStatic` now takes the `IncomingMessage`
  (both call sites updated). Non-HTML assets get a strong sha256 `ETag`
  plus `Cache-Control: private, no-cache`, and a matching
  `If-None-Match` (exact, `*`, or comma-list) returns a bodyless `304`
  with the same validator + security headers. `.jsx` responses memoize
  the etag in the existing mtime-keyed transform cache (no per-request
  re-hash); an edit (mtime bump) naturally mints a fresh etag, including
  for the broken-JSX error shim. HTML responses send
  `Cache-Control: no-store` and no validator — each response embeds a
  fresh CSP nonce and serve-time-baked settings, so no two are ever
  byte-identical.

`packages/app-engine/src/runtime.ts`: passes `req` through to
`serveStatic` at the two `app-index`/`app-static` call sites.

`packages/app-engine/src/http/static-server.test.ts`: nested/doubly
nested climb rewrites, cache depth-key isolation, nested shared-asset
404, and 13 new ETag/conditional-revalidation tests (200-with-validator,
304 on match, stale etag, `*`, multi-value list, HTML no-store +
ignored If-None-Match, draft edit → new etag, error-shim etag
lifecycle); all `serveStatic` calls updated to the new signature via a
`mockReq` helper.

### Commit 2 — blueprints jsdom tier: depth-aware mirror + cwd-independent roots

`packages/blueprints/src/app-boot-harness.ts`: the vitest boot-gate
harness mirrors the gateway's serve behavior on disk; its JSX transform
now applies the same depth-aware climb rewrite, and the per-nested-dir
shared-asset symlinks are gone (root-only, matching the gateway). Its
package-root constant no longer comes from `process.cwd()` — root-run
vitest (what `bun run coverage` and CI execute) has a different cwd than
a package-dir run, which made all 8 boot gates fail with ENOENT from the
repo root (pre-existing; verified identical on the unmodified tree).

`packages/blueprints/src/kit-smoke.test.ts`,
`packages/blueprints/src/react-smoke.test.ts`,
`packages/blueprints/src/scaffold-boot.test.ts`: same cwd→module-path
root fix — these plus the boot gates were the 11 root-run test-file
failures blocking the repo coverage gate.

### Commit 3 — open-waterfall measurement probe

`apps/desktop/tests/e2e-live/probe-open-waterfall.mjs`: real-rig probe
(Electron + Playwright + real gateway + fresh dev vault) that installs
photos and docs via the Discover UI, opens each app three times in one
session, collects the iframe's Resource Timing waterfall per open, and
reports request counts, transfer sizes, duplicate shared-asset URLs, and
a cached-response proxy count — the instrument behind the issue's
baseline numbers and this fix's verification.

`receipts/issue-356-blueprint-asset-double-fetch-caching.md`: this
receipt.

## Out of scope

- Tier 3 (data-query caching layer) and Tier 4 (mobile WebView
  keep-alive / change-bus cursor) from the issue — explicitly deferred
  by the issue itself pending post-fix re-measurement; the design
  constraints are recorded in the issue body.
- Repo-wide pre-existing `format:check` / `oxlint` debt (~705 errors in
  untouched files, mostly `.design-sync/` and desktop renderer) — main
  is red on these independent of this change; every file touched here is
  clean.

## Decisions

- **ETag revalidation (`private, no-cache`) instead of
  `max-age`/`immutable`:** the same URL's bytes change under this
  gateway — reinstall/republish swaps the code-store worktree an asset
  resolves from, and draft files are mutated live by the builder — so
  time-based freshness risks serving stale app code right after a
  publish. Content-validated 304s remove ~all transfer cost with zero
  staleness risk. Versioned/content-hashed asset URLs (which would
  unlock `immutable`) are a follow-up design, noted in the issue.
- **Nested shared-asset requests 404 rather than falling back:** the
  basename fallback is what let the Tier 1 bug ship invisibly; after the
  depth-aware rewrite no legitimate nested request exists, so masking is
  strictly harm.
- **HTML `no-store`:** per-response CSP nonce + baked settings make
  every HTML response unique; a validator would never hit.

## Verification

All measurements from the real rig (Electron + Playwright + real gateway
+ real dev vault via `apps/desktop/tests/e2e-live/driver.mjs`), no
mocks; screenshots read as ground truth on every open.

**Baseline (pre-fix, this branch's parent tree, measured with the
committed probe):**

```
photos open#1-3: 32 requests, 876,500B transferSize each open,
                 duplicates: react-core.min.js×2 (313,256B each), jsx-runtime.js×2
docs   open#1-3: 26 requests, 881,720B each open, same duplicates
cached(<500B):   1 per open — zero cache effect across same-session reopens
```

**Post-fix (same probe, same rig):**

```
photos open#1: 30 req, 561,683B  (cold; −314,817B = exactly the killed duplicate pair)
photos open#2: 30 req,   9,067B  (cached count 30/30 — all assets revalidate as 304s)
photos open#3: 30 req,   9,067B
docs   open#1: 24 req, 566,905B  (−314,815B vs baseline)
docs   open#2: 24 req,   7,282B  (cached count 24/24)
docs   open#3: 24 req,   7,282B
duplicates: none, on every open of both apps
```

Reopen transfer is <2% of the cold open; the depth-aware jsx-runtime
rewrite eliminated the duplicate react-core.min.js/jsx-runtime.js
fetches on every app checked.

**Render regression:** photos, docs, tasks, notes, tally each installed
and opened through the real Discover UI; every screenshot read and
confirmed as real rendered app UI (no blank iframes); zero
`/components/react-core.min.js` or `/components/jsx-runtime.js`
requests in any iframe's resource timeline; no module-resolution console
errors (only the pre-known benign clipboard permissions-policy noise).
Boot gates: 8/8 apps pass `packages/blueprints` `src/app-boot`.

**Suites and gates:**

- `packages/app-engine` full suite: 22 files, 270 tests pass
  (static-server.test.ts: 39, incl. 13 new ETag/conditional tests and
  the depth-rewrite/cache-isolation/nested-404 tests).
- `packages/blueprints` full suite: 17 files, 153 tests pass.
- Root-run `bunx vitest run --coverage`: app-engine 78.9% lines / 75.9%
  branches (floors 75/73); `static-server.ts` itself 94.7% lines. The
  blueprints root-run failures that previously blocked this gate were
  the pre-existing cwd bug fixed in commit 2.
- `bun run typecheck`: 22/22 tasks green.
- `oxfmt --check` + `oxlint` clean on every touched file (repo-wide
  `format:check`/`oxlint`/`lint:types` failures are pre-existing debt in
  untouched files — see Out of scope).
- Compiled-artifact check: `packages/app-engine/dist/http/static-server.js`
  contains the new caching path and is what the desktop gateway loads
  (verified before the post-fix measurement).
