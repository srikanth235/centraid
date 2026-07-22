# issue-511 — multi-platform gateway npm native tunnel (linux/mac/windows)

## Checklist

- [x] Document supported platforms (Node, OS/arch) for gateway install
- [x] CI builds native tunnel on at least: linux-x64, darwin-arm64, win32-x64
- [x] Pack merges platform `.node` files into `@centraid/tunnel` before publish
- [x] Install docs cover Windows (npm; not bash-only one-liner)
- [x] Unit tests for platform matrix + merge helpers

## What changed

Document supported platforms (Node, OS/arch) for gateway install:

- `README.md` — platform table (Linux/macOS/Windows, arch, install path, NAPI coverage)
- `docs/release.md` — npm multi-OS native matrix notes
- `packages/tunnel/README.md` — multi-OS pack merge pointer
- `scripts/install-gateway.mjs` — Windows npm install help

CI builds native tunnel on at least: linux-x64, darwin-arm64, win32-x64:

- `.github/workflows/npm-gateway-publish.yml` — matrix `build-native` (required: linux-x64, darwin-arm64, win32-x64; optional: linux-arm64, darwin-x64)

Pack merges platform `.node` files into `@centraid/tunnel` before publish:

- `scripts/gateway-npm/native-platforms.mjs` — platform matrix + audit
- `scripts/gateway-npm/merge-native-artifacts.mjs` — merge CI artifacts into `packages/tunnel/native/`
- workflow download + `merge-native-artifacts.mjs --require` before pack; tarball listing asserts required natives

Install docs cover Windows (npm; not bash-only one-liner):

- `README.md` Windows PowerShell section; install-gateway usage note

Unit tests for platform matrix + merge helpers:

- `scripts/gateway-npm/native-platforms.test.mjs`
- root `package.json` — `gateway:npm:helpers:test` includes platform tests; `gateway:npm:merge-native`

Also:

- `.gitignore` — ignore `packages/tunnel/native/native-platforms.manifest.json` (merge debug manifest)
- `tests/perf/tunnel-native.perf.test.ts` — recognize win32 / linux-arm64 artifact names
- `receipts/issue-511-gateway-multi-platform-native.md` — this receipt

## Decisions

- Single `@centraid/tunnel` package carries all `native/*.node` files (matches existing loader; no optionalDeps platform packages yet).
- Optional runners (`linux-arm64`, `darwin-x64`) use `continue-on-error` so publish is not blocked if GitHub retires a runner image.
- darwin-x64 best-effort runner is `macos-15-intel` (actionlint rejects retired `macos-13`).
- Local monorepo build still builds **host-only** native; multi-arch is a publish/CI concern.

## Out of scope

- Live multi-OS smoke of installed gateway on Windows/macOS runners in this PR (pack listing asserts required natives in tarball)
- Separate `@centraid/tunnel-<platform>` optional dependency packages
- Changing `@number0/iroh` upstream darwin-x64 gap (our native covers Intel Mac when present)

## Verification

```sh
bun run gateway:npm:helpers:test
bun run check:pr
# multi-OS natives: npm-gateway-publish workflow (tag / workflow_dispatch)
# asserts linux-x64, darwin-arm64, win32-x64 inside @centraid/tunnel tarball
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Steering

**PASS.**

No mid-task human-steering interrupts or corrections occurred during the implementation work for #511.

1. **Every human-steering event is recorded as a row:** No mid-task steering events were identified, so no real ledger rows are required. The `### Steering` table above has headers only (explicit **none**; no fabricated steer-keys).
2. **No non-steering message is recorded as steering:** Session human messages were correctly classified as non-steering:
   - “how does npm install work given that we use rust too in gateway” — Q&A / education
   - “okay, but are we supporting linux, windows, mac?” — product clarification Q&A
   - “yeah, gateway should work on multiple platforms!” — **task start** for #511 multi-platform work, not a mid-task correction of an in-flight implementation

## Audit

**PASS.**

Evidence for the three rubric checks (receipt ↔ issue #511 ↔ working-tree implementation):

1. **`## What changed` faithfully describes the diff (no misrepresentation, no omission): PASS** — Diff covers native-platforms/merge scripts, npm-gateway-publish matrix, README/docs/install Windows notes, package.json scripts, tunnel README, perf native candidates, .gitignore manifest ignore, and this receipt. All named in What changed.
2. **Each `[x]` checklist item is realized in the diff: PASS** — Platform docs in README; required CI matrix cells linux-x64/darwin-arm64/win32-x64; merge before pack with `--require`; Windows npm install docs; unit tests in `native-platforms.test.mjs`.
3. **Checklist mirrors issue acceptance: PASS** — Issue #511 acceptance bullets map 1:1 to the five checklist items (docs, CI natives, pack merge, Windows install, green PR / tests).
