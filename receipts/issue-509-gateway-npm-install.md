# issue-509 — gateway curl|bash install + npm publish infrastructure

## Checklist

- [x] Fresh worktree + branch from post-#506 `main`
- [x] Publish set defined; packages non-private with `publishConfig.access=public`
- [x] Pack rewrites `workspace:*` → versions; strips prepack; dry-run / pack succeeds
- [x] Install script (shell + mjs) npm/prefix path; no silent OS service
- [x] Secret-gated pack/publish workflow; docs one-liner
- [x] Unit tests for pack/install helpers; local install-from-packs smoke

## What changed

Fresh worktree + branch from post-#506 `main` (`grok/gateway-npm-install`).

Publish set defined; packages non-private with `publishConfig.access=public` on:

- `packages/protocol/package.json`
- `packages/design-tokens/package.json`
- `packages/blob-format/package.json` (also `files` for dist)
- `packages/app-engine/package.json`
- `packages/backup/package.json`
- `packages/tunnel/package.json`
- `packages/vault/package.json`
- `packages/blueprints/package.json`
- `packages/automation/package.json`
- `packages/agent-runtime/package.json`
- `packages/gateway/package.json`

Pack rewrites `workspace:*` → versions; strips prepack; dry-run / pack succeeds:

- `scripts/gateway-npm/publish-set.json`
- `scripts/gateway-npm/pack-helpers.mjs`
- `scripts/gateway-npm/pack.mjs`
- `scripts/gateway-npm/publish.mjs`

Install script (shell + mjs) npm/prefix path; no silent OS service:

- `scripts/install-gateway.sh`
- `scripts/install-gateway.mjs`

Secret-gated pack/publish workflow; docs one-liner:

- `.github/workflows/npm-gateway-publish.yml`
- `README.md`
- `docs/release.md`
- root `package.json` (`gateway:npm:*`, `gateway:install`)

Unit tests for pack/install helpers; local install-from-packs smoke:

- `scripts/gateway-npm/pack-helpers.test.mjs`

## Decisions

- OpenClaw stages (Node → npm install → PATH) without gum UI.
- Service remains H5 opt-in via existing `centraid-gateway service install` only.
- Live `npm publish` not required for this PR; infra + dry-run + pack smoke prove readiness.
- Piped curl without checkout cannot use `--from-pack-dir` (needs mjs); after npm publish, piped path uses `npm install @centraid/gateway@…`.

## Follow-up folded into PR #510 (pairing gaps)

Headless VPS → clients after install:

- [x] `centraid-gateway pair --qr` — terminal QR of the same one-line ticket
- [x] Mobile Settings: scan **or paste** ticket (`centraid-pair` QR JSON **or** `centraid-gw-pair` token)
- [x] Native `pairWithGateway` on iOS/Android (`centraid/gw-pair/1`)
- [x] README + `docs/recovery/pairing.md` form-factor map

### What changed (pairing bridge)

CLI / gateway:

- `packages/gateway/src/cli/pair-qr.ts` — terminal QR renderer (`qrcode`, ECC L)
- `packages/gateway/src/cli/device-admin.ts` — `--qr` flag + desktop/phone help text
- `packages/gateway/src/cli/cli.ts` — usage line for `--qr`
- `packages/gateway/src/cli/admin.test.ts` — `pair --qr` coverage
- `packages/gateway/package.json` + root `bun.lock` — `qrcode` / `@types/qrcode`

Mobile native tunnel:

- `apps/mobile/modules/centraid-tunnel/index.ts` — `pairWithGateway` JS surface
- `apps/mobile/modules/centraid-tunnel/ios/TunnelWire.swift` — `gwPairAlpn` + one-shot pair
- `apps/mobile/modules/centraid-tunnel/ios/CentraidTunnelModule.swift` — `GatewayPairArgs` / `pairWithGateway`
- `apps/mobile/modules/centraid-tunnel/ios/Tests/TunnelWireConformanceTests.swift` — ALPN lockstep
- `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelWire.kt` — `GW_PAIR_ALPN` + `pairGateway`
- `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/CentraidTunnelModule.kt` — Expo async
- `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelRuntime.kt` — runtime path
- `apps/mobile/modules/centraid-tunnel/android/src/test/java/expo/modules/centraidtunnel/TunnelWireConformanceTest.kt` — ALPN lockstep

Mobile app:

- `apps/mobile/src/lib/phone-link-parse.ts` — pure dual-format ticket parser
- `apps/mobile/src/lib/phone-link.ts` — redeem desktop vs gateway; store `gw` for tunnel
- `apps/mobile/src/lib/phone-link.test.ts` — parse unit tests
- `apps/mobile/src/screens/Settings.tsx` — scan + paste under Gateway link

Docs:

- `README.md` — “Pair clients after install” section
- `docs/recovery/pairing.md` — form-factor map

## Out of scope

- First live public npm publish (maintainer `NPM_TOKEN`)
- Desktop/mobile/PWA installers
- Hosting script on centraid.dev CDN (raw GitHub URL is enough for v0)
- Live on-device VPS pairing e2e (needs hardware + public relay)

## Verification

```sh
node --test scripts/gateway-npm/pack-helpers.test.mjs
bunx turbo run build --filter=@centraid/gateway...
node scripts/gateway-npm/pack.mjs --out artifacts/npm-packs
bash scripts/install-gateway.sh --prefix /tmp/centraid-gw --from-pack-dir artifacts/npm-packs
/tmp/centraid-gw/bin/centraid-gateway --help
node scripts/gateway-npm/publish.mjs --dry-run
bun run check:pr
```

Fresh worktree + branch from post-#506 `main` verified via `git worktree list` and `origin/main` tip including #506.

## Audit

Fresh-context auditor for issue #509. Inputs: receipt; worktree at `grok/gateway-npm-install` (HEAD `d7406a3` same as `main` — delivery is uncommitted tree); GitHub issue #509 body; spot-check of claimed paths (shell `git status` / `git diff --cached` unavailable in this auditor session — evidence is live file contents vs receipt claims).

1. **What changed faithfully describes the diff:** **PASS** — Claimed surfaces exist and match narrative:
   - Publish set: `scripts/gateway-npm/publish-set.json` lists protocol → design-tokens → blob-format → app-engine → backup → tunnel → vault → blueprints → automation → agent-runtime → gateway; all eleven `packages/*/package.json` have `"private": false` and `publishConfig.access: "public"`; blob-format has `files: ["dist", …]`.
   - Pack: `pack-helpers.mjs` `rewriteWorkspaceDependencies` rewrites `workspace:*`, deletes `devDependencies`, strips `prepack`/`prepare`/`prepublishOnly`/`prepublish`; `pack.mjs` / `publish.mjs` implement pack out dir + dry-run publish.
   - Install: `scripts/install-gateway.sh` + `install-gateway.mjs` npm/prefix path; comments and `--with-service` only print opt-in `centraid-gateway service install` (no silent unit write).
   - Workflow/docs: `.github/workflows/npm-gateway-publish.yml` packs always, publishes only when `NPM_TOKEN` set (dispatch dry_run default true); README “Gateway install” one-liner; `docs/release.md` npm graph notes; root `package.json` `gateway:npm:*` / `gateway:install`.
   - Tests: `scripts/gateway-npm/pack-helpers.test.mjs` covers rewrite, topo order, install-arg parsing.
   - Branch name `grok/gateway-npm-install` matches “Fresh worktree + branch” claim (worktree gitdir present).

2. **Each [x] checklist item is realized in the diff:** **PASS** —
   | Checklist item | Evidence |
   | --- | --- |
   | Fresh worktree + branch from post-#506 `main` | Worktree `gateway-npm-install`, branch `grok/gateway-npm-install`, HEAD = `main` tip `d7406a3` (post-#506 base; changes uncommitted) |
   | Publish set + non-private + public access | `publish-set.json` + 11 package.json files as listed |
   | Pack rewrites workspace:*; strips prepack; dry-run/pack | `rewriteWorkspaceDependencies` + `pack.mjs` `--dry-run`; `publish.mjs` dry when no token |
   | Install shell+mjs npm/prefix; no silent OS service | `install-gateway.sh`/`.mjs`; service is opt-in print only |
   | Secret-gated pack/publish workflow; docs one-liner | `npm-gateway-publish.yml`; README curl one-liner; `docs/release.md` |
   | Unit tests + local install-from-packs smoke | `pack-helpers.test.mjs`; workflow “Install smoke from local packs” step; Verification lists pack + install-from-pack-dir |

3. **Checklist mirrors the issue's checklist:** **PASS** — Issue #509 Acceptance is four rows: (1) install script npm/prefix + docs one-liner → receipt install + workflow/docs rows; (2) publish set packable + workspace deps rewritten → publish-set + pack rewrite rows; (3) secret-gated pack/publish (no live publish required) → workflow row + Decisions “Live npm publish not required”; (4) green CI on the PR → Verification (`bun run check:pr`) rather than a separate `[x]` (process gate, not a code surface). Receipt expands with worktree bootstrap and unit/smoke tests — supersets issue AC, no contradictory omissions of claimed acceptance.

**Overall: PASS**

## Steering

Primary human steering events this session:
- User requested new worktree + curl install posture for gateway + npm publish infra + green PR after #506 merge — **type:** correction, **tier:** classifier, **reason:** new goal after packaging PR merged.

### Steering rows

| type | tier | reason |
| --- | --- | --- |
| correction | classifier | post-merge goal: worktree + npm install infra |

**Verdict:** PASS — only mid-task corrections/goal setting; no fabricated steering.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-issue509npm-20260722-1 | issue509-gateway-npm-auditor | #509 | correction | classifier | post-merge goal: worktree + npm install infra + green PR | pending | 1 | 2026-07-22T11:10:00.000Z |
