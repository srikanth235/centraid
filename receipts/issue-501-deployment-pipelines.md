# Receipt: issue #501 — Deployment pipelines close-out

## Checklist

- [x] §1 Release ritual: `sync-versions`, `publish --issue`, `verify-secrets`
- [x] §2 Desktop packaging harden: pinned builder/updater, multi-OS hard-fail, Linux, Environment `release`
- [x] §3 Packaged auto-update download → install + I8 restamp script/workflow
- [x] §4 I12 What's new re-wire (sidebar + auto-open)
- [x] §5 Mobile EAS scaffold + `release-mobile.yml` (no eas update)
- [x] §6 J8 `mobile-android.yml` assembleDebug
- [x] §7 Web continuous host scaffold (`app.centraid.dev` wrangler + workflow)
- [x] §8 Gateway Dockerfile + GHCR workflow
- [x] §9 Docs write-back + human residual matrix
- [ ] Human enrollment (Apple / Azure / Play / Expo / CF domain) — residual

## What changed

- §1 Release ritual: `sync-versions`, `publish --issue`, `verify-secrets` — landed in `scripts/release/sync-versions.mjs`, `scripts/release/sync-versions.test.mjs`, `scripts/release/verify-secrets.mjs`, `scripts/release/publish.mjs` (requires `--issue N`), root package scripts.
- §2 Desktop packaging harden: pinned builder/updater, multi-OS hard-fail, Linux, Environment `release` — `apps/desktop/package.json` pins `electron-builder` / `electron-updater`; `apps/desktop/electron-builder.yml`; `.github/workflows/release-desktop.yml` mac/win/linux hard-fail + Environment `release`.
- §3 Packaged auto-update download → install + I8 restamp script/workflow — `apps/desktop/src/main/update-watcher.ts` download→install; `scripts/release/restamp-rollout.mjs` + `scripts/release/restamp-rollout.test.mjs`; restamp job in `release-desktop.yml`.
- §4 I12 What's new re-wire (sidebar + auto-open) — `packages/client/src/react/shell/App.tsx`, `packages/client/src/react/shell/Sidebar.tsx`, `packages/client/src/react/shell/useUpdateStatus.ts`, `packages/client/src/centraid-api.d.ts`.
- §5 Mobile EAS scaffold + `release-mobile.yml` (no eas update) — `apps/mobile/eas.json`, `apps/mobile/app.config.ts`, `apps/mobile/android/app/build.gradle`, `apps/mobile/package.json`, `apps/mobile/src/version-core.test.ts`, `.github/workflows/release-mobile.yml`.
- §6 J8 `mobile-android.yml` assembleDebug — `.github/workflows/mobile-android.yml`.
- §7 Web continuous host scaffold (`app.centraid.dev` wrangler + workflow) — `apps/web/wrangler.json`, `apps/web/public/_headers`, `scripts/web/smoke.mjs`, `.github/workflows/web.yml`.
- §8 Gateway Dockerfile + GHCR workflow — `packages/gateway/Dockerfile`, `.dockerignore`, `.github/workflows/release-gateway-image.yml`.
- §9 Docs write-back + human residual matrix — `docs/release.md`, `docs/enrollment.md`, `docs/decisions.md`, `ARCHITECTURE.md`, `scripts/release/boot-smoke.mjs`, `scripts/release/vitest.config.ts`, `bun.lock`, this receipt.

## Follow-up fix

- `apps/mobile/app.config.ts` — CJS-safe `readMobilePackageVersion()` (no `import.meta`/`fileURLToPath`); merge duplicate `extra` keys. Fixes J8 `mobile-android` assembleDebug Expo config eval on CI.
- `apps/mobile/src/version-core.test.ts` — asserts `readMobilePackageVersion` + package name walk.
- knip green for #503: static `import` of `electron-updater` in `apps/desktop/src/main/update-watcher.ts` (runtime dep in `apps/desktop/package.json`), wire `checkForUpdatesManual` via `UPDATE_CHECK` in `apps/desktop/src/main/ipc.ts` + `apps/desktop/src/preload.ts` + `packages/client/src/centraid-api.d.ts`, `eas` in `knip.json` `ignoreBinaries` (CI installs EAS via expo-github-action), `apps/desktop/src/main/update-watcher-wiring.test.ts` + `bun.lock`.

## Out of scope

- Live Apple / Azure / Play / Expo enrollment and secret values
- First signed production tag
- F-Droid, Fastlane
- Routine `eas update` CI (J7)
- Windows OS service unit for H5

## Decisions

- Scaffold-only when secrets absent (no fabricated credentials); GH Release attaches installers only when signing enrolled.
- Mobile store path is EAS, not Fastlane.
- Public web origin target is `app.centraid.dev`; gateway-embedded PWA remains LAN fallback.
- Android release refuses debug only when `CENTRAID_REQUIRE_RELEASE_SIGNING=1` (not all `CI=true`, so EAS/assembleDebug keep working).

## Verification

```sh
bunx vitest run --config scripts/release/vitest.config.ts
bunx vitest run apps/desktop/src/main/update-watcher-wiring.test.ts \
  apps/mobile/src/version-core.test.ts \
  packages/client/src/react/screens/WhatsNewModal.test.tsx \
  packages/client/src/react/shell/useUpdateStatus.test.tsx
node scripts/release/sync-versions.mjs --dry-run
node scripts/release/verify-secrets.mjs
node scripts/release/restamp-rollout.mjs --self-test
bun run --cwd apps/desktop build && bun run boot:smoke
bun run web:build && bun run web:smoke
```

Human residual: [docs/enrollment.md](../docs/enrollment.md).

## Audit

Fresh-context governance auditor for issue #501. Inputs: receipt, workspace tree (key surfaces claimed in What changed), `gh issue view 501` body via GitHub API, session context (plan decisions + no mid-task interrupts).

1. **What changed vs tree/diff — PASS.** Receipt surfaces exist and match claims:
   - Release: `scripts/release/sync-versions.mjs` (+ tests), `verify-secrets.mjs`, `restamp-rollout.mjs` (+ tests), `vitest.config.ts`; `publish.mjs` requires `--issue N` and imports `runSyncVersions`; root scripts `release:sync-versions` / `release:verify-secrets` / `release:restamp` / `web:build` / `web:smoke`; `boot-smoke.mjs` asserts new paths.
   - Desktop: pinned `electron-builder`/`electron-updater` in `apps/desktop/package.json`; `electron-builder.yml`; `release-desktop.yml` mac/win/linux jobs with hard-fail artifact checks + `environment: release` + I8 restamp job; `update-watcher.ts` download→`readyToInstall`→`quitAndInstall` + channel.
   - Client I12: `App.tsx` WhatsNew auto-open, `Sidebar.tsx` entry, `useUpdateStatus.ts` titles, `centraid-api.d.ts` `readyToInstall`.
   - Mobile: `eas.json`, `app.config.ts` version from package.json, Android release signing env + `CENTRAID_REQUIRE_RELEASE_SIGNING`, `release-mobile.yml` (no `eas update`), `mobile-android.yml` assembleDebug.
   - Web: `apps/web/wrangler.json` (`app.centraid.dev`), `public/_headers`, `scripts/web/smoke.mjs`, `web.yml` scaffold deploy.
   - Gateway: `packages/gateway/Dockerfile`, root `.dockerignore` (build context `.`), `release-gateway-image.yml` GHCR (no `latest` on beta).
   - Docs: `docs/release.md`, `docs/enrollment.md` secret names, `docs/decisions.md` D5/I12, `ARCHITECTURE.md` deploy table.

2. **Each [x] checklist item realized — PASS.**
   - §1: sync-versions / publish `--issue` / verify-secrets present and wired.
   - §2: pinned builder/updater, multi-OS hard-fail packaging, Linux job, Environment `release`.
   - §3: packaged download→install path + restamp script + workflow restamp job.
   - §4: sidebar What's new + auto-open once per version.
   - §5: EAS scaffold + `release-mobile.yml` without eas update.
   - §6: `mobile-android.yml` assembleDebug (J8).
   - §7: wrangler + `web.yml` for `app.centraid.dev`.
   - §8: Dockerfile + GHCR workflow.
   - §9: release/enrollment/decisions/architecture write-back; human residual unchecked (correct).

3. **Checklist mirrors issue #501 — PASS.** Issue body is free-form (no markdown task list): close agent-doable deployment gaps after #468 — secret-gated desktop multi-OS + auto-update, mobile EAS scaffold, web continuous host `app.centraid.dev`, gateway container channel, version single-source, I12 what's-new; human Apple/Azure/Play enrollment residual. Receipt §1–§9 are the approved-plan implementation sections covering that scope; unchecked human enrollment matches issue Residual.

**Verdict: PASS**

## Steering

None. Plan-mode multiple-choice locked scaffold-only enrollment, `app.centraid.dev` continuous web host, and one large PR before implementation; no mid-task interrupt or correction events after plan approval.

**Verdict: PASS**
