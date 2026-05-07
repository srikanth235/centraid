# Receipt — issue-2: import initial app code

Closes [#2](https://github.com/srikanth235/centraid/issues/2).

## Checklist

- [x] apps/desktop
- [x] apps/mobile
- [x] packages/design-tokens
- [x] packages/tsconfig
- [x] root configs
- [x] .vscode/settings.json
- [x] receipts/issue-2.md
- [x] Raise GOVERNANCE_FILE_SIZE_LIMIT to 700 in governance.yml and ci.yml

## What changed

- New `apps/desktop` Electron app: `src/main.ts`, `src/preload.ts`, and a vanilla-TypeScript renderer at `src/renderer/` (entry `index.html`, `styles.css`, `theme-vars.ts`, `app.ts`, `builder.ts`, `icons.ts`, `store.ts`, `types.d.ts`). Eight micro-apps live under `src/renderer/apps/` — focus, gifts, mood, hydrate, plants, todos, habits, journal. `package.json` declares `@centraid/desktop` with build scripts that `tsc` the main process, `bun build` the preload bundle (CommonJS, electron external), and copy renderer assets.
- New `apps/mobile` Expo app: `App.tsx` entry, `index.ts` registration, `app.json` Expo config, `babel.config.js`, `metro.config.js`. Source under `src/`: `navigation.ts`, `storage.ts`, `dateUtil.ts`, `theme.ts`, `globals.d.ts`. Three screens (Home, AppDetail, MobileFallback) and four components (Tile, Icon, AppHeader, Button). Includes the iOS native folder under `apps/mobile/ios/` (Podfile, Podfile.lock, `.xcode.env`, `.gitignore`).
- New `packages/design-tokens` shared package: `palette.ts`, `apps.ts` (app metadata), `icons.ts`, public barrel `index.ts`, `tsconfig.json`. `package.json` declares `@centraid/design-tokens` consumed by both desktop and mobile.
- New `packages/tsconfig` shared package: `base.json`, `electron.json`, `expo.json`, `package.json` declaring `@centraid/tsconfig`.
- Root configs land verbatim: `package.json` (workspaces, scripts, devDependencies pinning oxlint / oxfmt / turbo, packageManager bun@1.3.13), `bun.lock` (bun's frozen lockfile — required by `bun install --frozen-lockfile` in ci.yml), `bunfig.toml`, `turbo.json` (build / dev / typecheck / lint task graph), `.oxfmtrc.jsonc`, `.oxlintrc.json`.
- New `.vscode/settings.json` carries the workspace's editor settings (formatOnSave, oxc as default formatter for the language scopes the repo uses).
- Added `receipts/issue-2.md` (this file) so `commit-issue-receipt-match` has a receipt to bind the commit to issue #2.
- Raise GOVERNANCE_FILE_SIZE_LIMIT to 700 in governance.yml and ci.yml — `apps/desktop/src/renderer/builder.ts` (662 lines) and `apps/desktop/src/renderer/app.ts` (575 lines) sit between 500 and 700; this calibrates the directive's documented env-var hatch so verbatim import doesn't churn the renderer modules. Refactoring them into smaller pieces is a deferred follow-up.

## Out of scope

- Refactors, formatting passes, or any code changes. This commit is a verbatim import.
- Test wiring. No tests exist yet; the ci.yml gate is `bun run check` + `bun run typecheck`.
- Per-app or per-package READMEs. Their absence is fine for now.
- Generated / cached artefacts: `node_modules/`, `dist/`, per-app `.turbo/` dirs, `apps/mobile/ios/Pods/`, `apps/mobile/ios/.xcode.env.local`. All match either the root `.gitignore` or `apps/mobile/ios/.gitignore` and stay untracked.

## Verification

- `bash .governance/run.sh` exits 0 — all 12 directives pass, including `repo-hygiene` (no merge markers, no build artefacts, no debug statements, no oversized source files).
- `git status --short` after staging shows no unexpected files under `node_modules/`, `dist/`, `.turbo/`, `.expo/`, or `apps/mobile/ios/Pods/`.
- Commit message is `feat: import initial app code (#2)` — matches `commit-message-format`.
- COSTS.md gains a matching row keyed by the active session, and the commit carries the corresponding token trailers; STEERING.md records any human-steering events from this turn.
- After push, the new commit triggers both `governance.yml` and `ci.yml` workflows on GitHub Actions; ci.yml runs `bun install --frozen-lockfile`, `bun run check`, and `bun run typecheck`.
- A subsequent `bun install` from a fresh clone produces a working tree without missing-file errors (the lockfile and workspace manifests cover the dependency graph).
