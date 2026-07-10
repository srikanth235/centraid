# e2e-live

Playwright `_electron` rig against the REAL desktop app: real in-process
gateway, real dev vault, no mocked HTTP. Separate from the stale
`apps/desktop/tests/e2e/` suite (mock gateway) and the
`apps/desktop/scripts/screenshot-*.mjs` visual aids (route gateway calls to a
seed server).

## Build (prereq, and after any main/renderer change)

```
bun run build --filter=@centraid/desktop   # from repo root; ~3-8s warm, ~8s cold
```

## Run

```
node apps/desktop/tests/e2e-live/smoke.mjs        # golden path: Home → Discover (32 templates) → preview → Home
node apps/desktop/tests/e2e-live/iframe-probe.mjs # installs Agenda, drives its app iframe
```

Both write screenshots to `out/` (gitignored via the repo's top-level `out`
pattern) and print PASS/FAIL with timings. Non-zero exit on failure, plus a
`*-FAILURE.png` screenshot.

## driver.mjs

`launchApp({ userDataDir? })` seeds `<userData>/centraid-settings.json` with
just `{ activeGatewayId: 'local', onboardingCompletedAt }` — that's the whole
seed. Everything else (the local gateway's id/port/token, the dev vault under
`gateways/local/vault/`) is minted by the app itself on first boot; there's no
port to configure, the gateway binds an ephemeral loopback port and hands the
URL/token to the renderer over IPC (see `src/main/local-gateway.ts` +
`settings.ts`). Omit `userDataDir` for a fresh temp dir + virgin vault (v0:
dev vaults recreate freely); pass one back in to resume the same
gateway/vault across relaunches. Readiness selector: the Home heading
`"What should we build?"` — it only paints once `boot.tsx` reads
`onboardingCompletedAt` back and mounts `<App/>` instead of the onboarding
screen, so it doubles as "gateway settled + renderer interactive".

## iframe driving

Get a `Frame`: `await (await page.waitForSelector('iframe[data-centraid-app="1"]')).contentFrame()`.
Get a `FrameLocator` (nicer for most assertions): `page.frameLocator('iframe[data-centraid-app="1"]')`.
`page.on('console', ...)` DOES capture child-frame `console.log`s — verified
by calling `frame.evaluate(() => console.log(marker))` and finding it in the
page-level listener. Same attribute/selector for both the builder's draft
preview (`BuilderPreview.tsx`) and a live app view (`AppFrame.tsx`).

## Quirks

- Discover → template preview → "Use this template" currently installs an
  app template DIRECTLY as a published app and pins it to Home (no
  draft/builder detour) — `DiscoverRoute.tsx`'s `applyAppTemplate`. This
  changed mid-investigation (a concurrent edit landed in this worktree);
  `iframe-probe.mjs` targets the current behavior.
- No fixed gateway port/env var to set — don't try; it's dynamic per launch.
- Kill stragglers with `pkill -f "Electron.app/Contents/MacOS/Electron"` if a
  run is interrupted before `close()`.
