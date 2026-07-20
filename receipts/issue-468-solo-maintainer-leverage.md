# Issue #468 — Solo-maintainer leverage: reduce recurring toil and build the client shipping surface

GitHub issue: [#468](https://github.com/srikanth235/centraid/issues/468)

## Checklist

### A — Agents self-serve context

- [x] **A1** Docs write-back loop + docs index in `AGENTS.md`
- [x] **A2** `CLAUDE.md` → `AGENTS.md` symlink
- [x] **A3** `docs/glossary.md` (forbidden synonyms incl. conversation/turn vs chat)
- [x] **A4** `docs/traps/*`
- [x] **A5** `docs/refactors/README.md`
- [x] **A6** `docs/recovery/{release,backup-restore,pairing}.md`

### B — Cheap review

- [x] **B1** `docs/coding-standards.md`
- [x] **B2** Policy: tools only via repo scripts (`AGENTS.md`); existing staged lint hook kept
- [x] **B3** knip warn-first (`knip` script + `knip.json` per-workspace)
- [x] **B4** `CONTRIBUTING.md`

### C — Protocol

- [x] **C1–C4** documented in `docs/protocol.md` (no-fallback, COMPAT, purity; unblocks #462)
- [x] **C1 client half** version/schema handshake pure module in `packages/client` + web wiring (K10)

### D — Releases

- [x] **D1** `docs/release.md` prepare vs publish boundary
- [x] **D2** `scripts/release/prepare.mjs` + `publish.mjs` one-command chain
- [x] **D3** `changelog-to-github.mjs` + GH release job; I12 re-wire checklist in release playbook
- [x] **D4** patch/minor in decisions + `classify.mjs`
- [x] **D5** desktop-only beta tags in release-desktop workflow
- [x] **D6** release skill shims under `.claude/skills/release-*`

### E — CI

- [x] **E2** path-filtered client e2e PR workflow
- [x] **E3/L2** `scripts/release/boot-smoke.mjs` structural boot-the-artifact gate
- [x] **E4** failure artifacts on e2e workflows (existing + new)

### F — Support pre-empted

- [x] **F1–F5** decisions, SECURITY threat model, config-ownership, README cadence, logs

### G — Delegation

- [x] **G1–G3** dev-environment + multi-agent docs + release skill shims

### H — Gateway lifetime

- [x] **H1** decisions write-up
- [x] **H2** detached spawn (stdio ignore, unref)
- [x] **H3** ownership stamp + adopt-don't-kill + probe-failed-refuse
- [x] **H4** stable default port `17832` + status probe
- [x] **H5** opt-in service flag default off (`shouldOfferServiceInstall`; OS unit already `dev.centraid.gateway`)
- [x] **H6** lifecycle via `centraid-gateway` CLI
- [x] **H7** crash-loop breaker retained (`gateway-supervisor-core`)

### I — Desktop packaging / updater

- [x] **I1** electron-builder.yml (appId `dev.centraid.desktop`)
- [x] **I2/I3** secret-gated signing scaffolding in `release-desktop.yml` (no fabricated credentials)
- [x] **I4–I6** pure rollout core + thin wiring stub; dev mtime poller retained until electron-updater fully wired
- [x] **I7–I9** publish-before-manifest / re-stamp / install-on-quit notes in release playbook + workflow stubs
- [x] **I10** ZIP+DMG macOS, per-user NSIS Windows
- [x] **I11** checksum step in release workflow
- [x] **I12** What's new UI/auto-open removed; placeholder e2e deleted
- [x] **I13** login-shell PATH note in release/dev docs

### J — Mobile

- [x] **J2** stale push / remote-notification removed
- [x] **J3** cleartext scoped (network security config localhost/`.local` only)
- [x] **J4** secrets → `expo-secure-store`
- [x] **J5** `dev.centraid.*` identifiers
- [x] **J6** `nativeBuildNumber` formula + tests
- [x] **J7** expo-updates dormant (`appVersion`, `ON_ERROR_RECOVERY`, no eas update CI)
- [x] **J8** `mobile-android.yml` workflow

### K — PWA / cross-client

- [x] **K1–K15** error boundaries, error surfacing, offline page, precache, manifest id `/`, safe-area, recoverable install prompt, SW version collapse, real version string, handshake on web, system fonts, crash handlers, window state, menu/tray/deep-link + well-known, wasm not committed / build helper

### L — Client testing gates

- [x] **L1** path-filtered PR e2e workflow
- [x] **L2** boot-smoke structural gate
- [x] **L3** TESTING.md wins; suite READMEs corrected
- [x] **L4** orphan e2e-live flows deleted (kept driver/smoke/iframe-probe)

## What changed

- **A1** Docs write-back loop + docs index in `AGENTS.md`
- **A2** `CLAUDE.md` → `AGENTS.md` symlink
- **A3** `docs/glossary.md` (forbidden synonyms incl. conversation/turn vs chat)
- **A4** `docs/traps/*`
- **A5** `docs/refactors/README.md`
- **A6** `docs/recovery/{release,backup-restore,pairing}.md`
- **B1** `docs/coding-standards.md`
- **B2** Policy: tools only via repo scripts (`AGENTS.md`); existing staged lint hook kept
- **B3** knip warn-first (`knip` script + `knip.json` per-workspace)
- **B4** `CONTRIBUTING.md`
- **C1–C4** documented in `docs/protocol.md` (no-fallback, COMPAT, purity; unblocks #462)
- **C1 client half** version/schema handshake pure module in `packages/client` + web wiring (K10)
- **D1** `docs/release.md` prepare vs publish boundary
- **D2** `scripts/release/prepare.mjs` + `publish.mjs` one-command chain
- **D3** `changelog-to-github.mjs` + GH release job; I12 re-wire checklist in release playbook
- **D4** patch/minor in decisions + `classify.mjs`
- **D5** desktop-only beta tags in release-desktop workflow
- **D6** release skill shims under `.claude/skills/release-*`
- **E2** path-filtered client e2e PR workflow
- **E3/L2** `scripts/release/boot-smoke.mjs` structural boot-the-artifact gate
- **E4** failure artifacts on e2e workflows (existing + new)
- **F1–F5** decisions, SECURITY threat model, config-ownership, README cadence, logs
- **G1–G3** dev-environment + multi-agent docs + release skill shims
- **H1** decisions write-up
- **H2** detached spawn (stdio ignore, unref)
- **H3** ownership stamp + adopt-don't-kill + probe-failed-refuse
- **H4** stable default port `17832` + status probe
- **H5** opt-in service flag default off (`shouldOfferServiceInstall`; OS unit already `dev.centraid.gateway`)
- **H6** lifecycle via `centraid-gateway` CLI
- **H7** crash-loop breaker retained (`gateway-supervisor-core`)
- **I1** electron-builder.yml (appId `dev.centraid.desktop`)
- **I2/I3** secret-gated signing scaffolding in `release-desktop.yml` (no fabricated credentials)
- **I4–I6** pure rollout core + thin wiring stub; dev mtime poller retained until electron-updater fully wired
- **I7–I9** publish-before-manifest / re-stamp / install-on-quit notes in release playbook + workflow stubs
- **I10** ZIP+DMG macOS, per-user NSIS Windows
- **I11** checksum step in release workflow
- **I12** What's new UI/auto-open removed; placeholder e2e deleted
- **I13** login-shell PATH note in release/dev docs
- **J2** stale push / remote-notification removed
- **J3** cleartext scoped (network security config localhost/`.local` only)
- **J4** secrets → `expo-secure-store`
- **J5** `dev.centraid.*` identifiers
- **J6** `nativeBuildNumber` formula + tests
- **J7** expo-updates dormant (`appVersion`, `ON_ERROR_RECOVERY`, no eas update CI)
- **J8** `mobile-android.yml` workflow
- **K1–K15** error boundaries, error surfacing, offline page, precache, manifest id `/`, safe-area, recoverable install prompt, SW version collapse, real version string, handshake on web, system fonts, crash handlers, window state, menu/tray/deep-link + well-known, wasm not committed / build helper
- **L1** path-filtered PR e2e workflow
- **L2** boot-smoke structural gate
- **L3** TESTING.md wins; suite READMEs corrected
- **L4** orphan e2e-live flows deleted (kept driver/smoke/iframe-probe)

### Files in this change

- `.claude/skills/release-prepare/SKILL.md`
- `.claude/skills/release-publish/SKILL.md`
- `.github/workflows/client-e2e-pr.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/mobile-android.yml`
- `.github/workflows/release-desktop.yml`
- `.gitignore`
- `AGENTS.md`
- `apps/desktop/build/entitlements.mac.inherit.plist`
- `apps/desktop/build/entitlements.mac.plist`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/electron-builder/app-id.json`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/main/app-chrome.ts`
- `apps/desktop/src/main/crash-log-core.ts`
- `apps/desktop/src/main/crash-log.ts`
- `apps/desktop/src/main/detached-gateway-core.test.ts`
- `apps/desktop/src/main/detached-gateway-core.ts`
- `apps/desktop/src/main/detached-gateway.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/login-item.ts`
- `apps/desktop/src/main/settings-merge.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/src/main/update-rollout-core.test.ts`
- `apps/desktop/src/main/update-rollout-core.ts`
- `apps/desktop/src/main/update-rollout.ts`
- `apps/desktop/src/main/version-handshake.ts`
- `apps/desktop/src/main/window-state.ts`
- `apps/desktop/tests/e2e-live/flows-agenda-v2-01-empty-install.mjs`
- `apps/desktop/tests/e2e-live/flows-agenda-v2-02-propose-corner-cases.mjs`
- `apps/desktop/tests/e2e-live/flows-agenda-v2-03-cancel-rsvp-attendees.mjs`
- `apps/desktop/tests/e2e-live/flows-agenda-v2-04-persistence-relaunch.mjs`
- `apps/desktop/tests/e2e-live/flows-approvals-01-setup-park.mjs`
- `apps/desktop/tests/e2e-live/flows-approvals-02-corner-cases.mjs`
- `apps/desktop/tests/e2e-live/flows-apps-v2-docs.mjs`
- `apps/desktop/tests/e2e-live/flows-apps-v2-locker.mjs`
- `apps/desktop/tests/e2e-live/flows-apps-v2-people.mjs`
- `apps/desktop/tests/e2e-live/flows-apps-v2-photos-ask-insights.mjs`
- `apps/desktop/tests/e2e-live/flows-apps-v2-tally.mjs`
- `apps/desktop/tests/e2e-live/flows-ask-01-panel-grant-corner.mjs`
- `apps/desktop/tests/e2e-live/flows-ask-02-tasks-llm-turn.mjs`
- `apps/desktop/tests/e2e-live/flows-ask-03-locker-parked.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-01-lifecycle.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-02-triggers.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-03-corners.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-04-trigger-fires.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-05-grants-rename.mjs`
- `apps/desktop/tests/e2e-live/flows-automations-06-builder-to-run.mjs`
- `apps/desktop/tests/e2e-live/flows-chat-features-01-global-ask-sidebar.mjs`
- `apps/desktop/tests/e2e-live/flows-chat-features-02-kit-ask-history.mjs`
- `apps/desktop/tests/e2e-live/flows-chat-features-03-settings-subsystem-models.mjs`
- `apps/desktop/tests/e2e-live/flows-full.mjs`
- `apps/desktop/tests/e2e-live/flows-gateway-01-runtime-page.mjs`
- `apps/desktop/tests/e2e-live/flows-gateway-02-storage.mjs`
- `apps/desktop/tests/e2e-live/flows-insights-01.mjs`
- `apps/desktop/tests/e2e-live/flows-notes-v2-01-core.mjs`
- `apps/desktop/tests/e2e-live/flows-notes-v2-02-corner-cases.mjs`
- `apps/desktop/tests/e2e-live/flows-notes-v2-03-persistence.mjs`
- `apps/desktop/tests/e2e-live/flows-photos-2.mjs`
- `apps/desktop/tests/e2e-live/flows-photos-3.mjs`
- `apps/desktop/tests/e2e-live/flows-photos-4.mjs`
- `apps/desktop/tests/e2e-live/flows-photos-5.mjs`
- `apps/desktop/tests/e2e-live/flows-photos.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-01-nav-chrome.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-02-discover-install.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-03-search-star-settings.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-01-onboarding.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-02-vaults-settings.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-03-uninstall-search.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-04-corners.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-05-ssh-connect.mjs`
- `apps/desktop/tests/e2e-live/flows-shell-v2-06-url-connect.mjs`
- `apps/desktop/tests/e2e-live/flows-tasks-v2-01-crud.mjs`
- `apps/desktop/tests/e2e-live/flows-tasks-v2-02-corner-cases.mjs`
- `apps/desktop/tests/e2e-live/flows-verify-approvals-identity.mjs`
- `apps/desktop/tests/e2e-live/flows-verify-fix1-starred.mjs`
- `apps/desktop/tests/e2e-live/flows-verify-fix2-fix3-insights.mjs`
- `apps/desktop/tests/e2e-live/flows-verify-fix3e-thread-resume.mjs`
- `apps/desktop/tests/e2e-live/pdf-quicklook.mjs`
- `apps/desktop/tests/e2e-live/probe-draft-flip.mjs`
- `apps/desktop/tests/e2e-live/probe-open-waterfall.mjs`
- `apps/desktop/tests/e2e-live/probe-preview-x-close.mjs`
- `apps/desktop/tests/e2e-live/probe-rapid-trash.mjs`
- `apps/desktop/tests/e2e-live/probe-revamp.mjs`
- `apps/desktop/tests/e2e-live/README.md`
- `apps/desktop/tests/e2e-live/seed-agenda-calendars.mjs`
- `apps/desktop/tests/e2e-live/verify-01-agenda-park-cancel-reschedule.mjs`
- `apps/desktop/tests/e2e-live/verify-02-notebook-duplicate-name.mjs`
- `apps/desktop/tests/e2e-live/verify-04-conflict-friendly-message.mjs`
- `apps/desktop/tests/e2e-live/verify-05-tasks-search-global.mjs`
- `apps/desktop/tests/e2e-live/verify-06-agentcli-version-insights-layout.mjs`
- `apps/desktop/tests/e2e-live/verify-06-notes-long-title-overflow.mjs`
- `apps/desktop/tests/e2e-live/verify-07-notes-denied-search-notice.mjs`
- `apps/desktop/tests/e2e-live/verify-08-vault-switch-pins.mjs`
- `apps/desktop/tests/e2e-live/verify-09-sidebar-search-button.mjs`
- `apps/desktop/tests/e2e-live/verify-10-palette-escape-anywhere.mjs`
- `apps/desktop/tests/e2e-live/verify-11-toast-cap.mjs`
- `apps/desktop/tests/e2e-live/verify-12-attachment-remove-race.mjs`
- `apps/desktop/tests/e2e-live/verify-13-gateway-logs-realtime.mjs`
- `apps/desktop/tests/e2e-live/verify-13-relaunch-to-update.mjs`
- `apps/desktop/tests/e2e-live/verify-14-whats-new.mjs`
- `apps/desktop/tests/e2e-live/verify-15-assistant-default-model.mjs`
- `apps/desktop/tests/e2e/README.md`
- `apps/mobile/android/app/build.gradle`
- `apps/mobile/android/app/src/main/AndroidManifest.xml`
- `apps/mobile/android/app/src/main/java/dev/centraid/mobile/MainActivity.kt`
- `apps/mobile/android/app/src/main/java/dev/centraid/mobile/MainApplication.kt`
- `apps/mobile/android/app/src/main/java/dev/centraid/mobile/upload/UploadForegroundModule.kt`
- `apps/mobile/android/app/src/main/java/dev/centraid/mobile/upload/UploadForegroundPackage.kt`
- `apps/mobile/android/app/src/main/java/dev/centraid/mobile/upload/UploadForegroundService.kt`
- `apps/mobile/android/app/src/main/res/xml/network_security_config.xml`
- `apps/mobile/app.json`
- `apps/mobile/App.tsx`
- `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj`
- `apps/mobile/ios/Centraid/Centraid.entitlements`
- `apps/mobile/ios/Centraid/Info.plist`
- `apps/mobile/ios/ShareExtension/ShareExtension-Info.plist`
- `apps/mobile/ios/ShareExtension/ShareExtension.entitlements`
- `apps/mobile/ios/ShareExtension/ShareViewController.swift`
- `apps/mobile/package.json`
- `apps/mobile/src/lib/gateway.ts`
- `apps/mobile/src/lib/phone-link.ts`
- `apps/mobile/src/lib/secure-storage.ts`
- `apps/mobile/src/version-core.test.ts`
- `apps/mobile/src/version-core.ts`
- `apps/web/index.html`
- `apps/web/package.json`
- `apps/web/public/.well-known/apple-app-site-association`
- `apps/web/public/.well-known/assetlinks.json`
- `apps/web/public/manifest.webmanifest`
- `apps/web/public/offline.html`
- `apps/web/public/sw.js`
- `apps/web/scripts/ensure-iroh-wasm.mjs`
- `apps/web/src/client-globals.d.ts`
- `apps/web/src/connectivity.ts`
- `apps/web/src/generated/centraid_web_iroh_bg.wasm`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/main.ts`
- `apps/web/src/sw-version.ts`
- `apps/web/src/web-chrome.ts`
- `apps/web/vite.config.ts`
- `bun.lock`
- `CHANGELOG.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `docs/coding-standards.md`
- `docs/config-ownership.md`
- `docs/decisions.md`
- `docs/dev-environment.md`
- `docs/enrollment.md`
- `docs/glossary.md`
- `docs/identifiers.md`
- `docs/logs.md`
- `docs/multi-agent.md`
- `docs/protocol.md`
- `docs/recovery/backup-restore.md`
- `docs/recovery/pairing.md`
- `docs/recovery/release.md`
- `docs/refactors/README.md`
- `docs/release.md`
- `docs/traps/blueprint-csp.md`
- `docs/traps/design-tokens.md`
- `docs/traps/electron-screenshot.md`
- `docs/traps/manifest-regeneration.md`
- `docs/traps/wal-checkpoint.md`
- `docs/traps/worktrees.md`
- `knip.json`
- `package.json`
- `packages/client/package.json`
- `packages/client/src/index.html`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screens/OnboardingScreen.module.css`
- `packages/client/src/react/screens/RecoverScreen.module.css`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/ErrorBoundary.tsx`
- `packages/client/src/styles.css`
- `packages/client/src/version-handshake.test.ts`
- `packages/client/src/version-handshake.ts`
- `packages/design-tokens/src/typography.ts`
- `README.md`
- `scripts/release/boot-smoke.mjs`
- `scripts/release/changelog-to-github.mjs`
- `scripts/release/classify.mjs`
- `scripts/release/prepare.mjs`
- `scripts/release/publish.mjs`
- `scripts/test-report/smoke.mjs`
- `scripts/test-report/summary-markdown.mjs`
- `SECURITY.md`
- `TESTING.md`
- `tests/agent-e2e-mobile/AGENTS.md`
- `tests/agent-e2e-mobile/flows/home-loads.md`
- `tests/agent-e2e-mobile/lib/harness.mjs`
- `tests/agent-e2e-mobile/README.md`
- `receipts/issue-468-solo-maintainer-leverage.md` (this receipt)
## Out of scope

- Apple Developer / Azure Trusted Signing / Play App Signing **live enrollment and CI secrets** (I2/I3/J1 human residual; checklist in `docs/enrollment.md`)
- Live notarized/signed publish and store submission
- Full electron-updater production install path (pure rollout + scaffolding landed; mtime poller remains for unpackaged dev)
- Onboarding UI that offers H5 service install (settings flag + pure helper only)
- E1/E5–E7 deeper CI babysitting; L5 hard-fail timing budgets
- Browser extension pairing (#462) implementation
- F-Droid, major versions before 1.0, bespoke dev-manifest formats

## Decisions

- Detached gateway is the **default**; set `CENTRAID_EMBEDDED_GATEWAY=1` for in-process (tests/debug).
- Stable port `17832` replaces ephemeral bind for bookmarks/pairing (H4).
- Ownership: adopt foreign live processes; **refuse** reclaim when the status probe itself failed (H3).
- App quit **does not** SIGTERM owned detached gateways (H1 product premise).
- Rollout: admit when `bucket < elapsed/window` (72h); fail-open on bad metadata/manual; fail-closed on clock skew (I5/I6).
- Reverse-DNS root `dev.centraid` permanently before first store submit (J5).
- OTA configured dormant with `ON_ERROR_RECOVERY` — no `eas update` in CI (J7).
- What's-new UI parked until D3 re-wires real release feed (I12).
- Single large PR for agent-doable #468 scope; human enrollment residual only (issue B4 tension accepted for OBJECTIVE).
- knip warn-first via config; not hard-fail in `check:pr` yet (B3 one-week warn phase).

## Verification

```sh
# Pure unit tests (detached ownership, crash-loop H7, rollout I5/I6, J6 version, K10 handshake)
bunx vitest run \
  apps/desktop/src/main/detached-gateway-core.test.ts \
  apps/desktop/src/main/update-rollout-core.test.ts \
  apps/desktop/src/main/gateway-supervisor-core.test.ts \
  apps/mobile/src/version-core.test.ts \
  packages/client/src/version-handshake.test.ts

# Structural (ids, manifest id, fonts, I12, symlink, expo-updates)
test -L CLAUDE.md && test "$(readlink CLAUDE.md)" = AGENTS.md
grep -q 'dev.centraid.mobile' apps/mobile/app.json
grep -q '"id": "/"' apps/web/public/manifest.webmanifest
! grep -q fonts.googleapis.com packages/client/src/index.html
! test -f apps/desktop/tests/e2e-live/verify-14-whats-new.mjs
grep -q ON_ERROR_RECOVERY apps/mobile/app.json

# Boot-the-artifact structure (after desktop build)
bun run build --filter=@centraid/desktop...
bun run boot:smoke

# PR static gate
bun run check:pr
```

Evidence captured under the implementer scratch dir: `issue-468-unit.log`, `issue-468-struct.log`, `issue-468-check-pr.log`, `issue-468-pack.log`.

## Audit

PASS — What changed names the major surfaces in the diff (docs/, apps/desktop detached gateway, scripts/release, mobile J5 rename, packages/client K items, workflows). Checklist [x] items A1–L4 agent-doable set are realized in the tree (docs, pure cores + tests, wiring, CI). Checklist mirrors issue #468 groups A–L with explicit residuals for human enrollment (J1/I2/I3 live secrets) and L5/E1 residual. Evidence: vitest pure cores green; bun run check:pr green.

## Steering

PASS — no human interrupt or mid-task correction in this session; the original goal ("entire scope of #468 and create PR") is the sole operator instruction. No steering table rows to append.

## Accounting

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | total | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | cum-cost-usd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
