# Receipt: #586 mobile e2e after founding onboarding + springboard

## Checklist

- [x] Debug onboarding exposes Skip for now; release does not
- [x] first-run skip waits for Skip for now on both platforms
- [x] configureGateway / home-loads / template-gate use springboard markers
- [x] native-v0-resilience opens Photos/Docs/Agenda covers + Settings dock
- [ ] GitHub Actions mobile-ios + mobile-android green on remote branch

## What changed

Debug onboarding exposes Skip for now; release does not:

- `apps/mobile/src/screens/Onboarding.tsx` — connect step gets `onSkipDev` only when `typeof __DEV__ !== 'undefined' && __DEV__`; label **"Skip for now"** placed **above** the device-name field so it is on-screen on phone layouts (below-fold taps were no-ops).
- `apps/mobile/src/screens/Onboarding.test.tsx` — asserts presence under `__DEV__` and absence when false.

first-run skip waits for Skip for now on both platforms:

- `tests/agent-e2e-mobile/lib/first-run.mjs` — `skipOnboarding` no longer Android-only; scrolls to 100% visibility, taps **"Skip for now"**, then waits until **"Connect your gateway"** is gone before Home; exports `HOME_RAIL_LABEL`.

configureGateway / home-loads / template-gate use springboard markers:

- `tests/agent-e2e-mobile/lib/harness.mjs` — readiness **"YOUR APPS"**; Settings **"Desktop link"** + expand **"Gateway connection"**; after Save not **"Connect your computer. Pair desktop"**.
- `tests/agent-e2e-mobile/flows/home-loads.mjs` — pairing banner a11y label **"Connect your computer. Pair desktop"**.
- `tests/agent-e2e-mobile/flows/template-gate.mjs` — post-relaunch wait on YOUR APPS.
- `tests/agent-e2e-mobile/flows/home-loads.md` — docs match current product.

native-v0-resilience opens Photos/Docs/Agenda covers + Settings dock:

- `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` — launcher `Open Photos|Docs|Agenda`, dismiss via **Back to your apps**, Settings via glass dock.

## Out of scope

- Reintroducing Skip on release builds.
- Full pairing ceremony e2e on mobile (still Advanced URL for tokenless CI gateway).
- Merge to main.

## Verification

```sh
cd apps/mobile && bun run test -- src/screens/Onboarding.test.tsx
bun run lint:e2e-flows
```

Remote (remaining):

```sh
gh workflow run e2e.yml --ref fix/mobile-e2e-springboard-onboarding -f suite=mobile
gh workflow run e2e.yml --ref fix/mobile-e2e-springboard-onboarding -f suite=mobile-android
```

## Decisions

- Prefer `__DEV__` skip over seeding AsyncStorage via adb/simctl — Maestro-visible, same path as Settings Advanced after skip.
- native-v0 rewritten for springboard covers; tab-bar flow was dead after #498.

## Audit

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS** — files listed match the staged surface.

### Check 2: Each "- [x]" checklist item is realized in the diff

**Verdict: PASS** — four code items covered; remote mobile CI unchecked until green.

### Check 3: The checklist mirrors the issue's checklist

**Verdict: PASS** — matches #586 acceptance criteria.

## Steering

### Check 1: Every human-steering event in the session transcript is recorded as a row

**Verdict: PASS** — no interrupt/correction for #586; goal was fix nightly mobile reds.

### Check 2: No non-steering message is recorded as steering

**Verdict: PASS** — no steering rows.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

### Costs
