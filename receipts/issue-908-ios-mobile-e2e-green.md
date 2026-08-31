# Receipt — issue #908 · Green the iOS mobile depth lane

CI-only repair of the `mobile-e2e-ios` pairing prerequisite. Device-level
claims remain open until the GitHub Actions lane proves them.

## Checklist

- [x] Build the iOS E2E artifact as a self-contained Release app without Expo development UI.
- [x] Keep camera-roll reconciliation behind completed profile onboarding.
- [x] Wait for the configured relay before exposing a pairing endpoint.
- [x] Drive profile entry through stable handles and read the value back before submission.
- [ ] Pass the complete `mobile-e2e-ios` depth roster within its existing budget.

## What changed

Build the iOS E2E artifact as a self-contained Release app without Expo development UI: the iOS Release build sets `CENTRAID_MOBILE_BUILD=release`; the Podfile excludes Expo's dev client, launcher, menu, and menu interface only for that lane. The committed CocoaPods graph, Xcode resource phase, and native fingerprint match that artifact.

Keep camera-roll reconciliation behind completed profile onboarding: `UploadReconciliation` now mounts only after profile onboarding. Pairing still creates the replica session first, but that ticket-only surface can no longer trigger a Photo Library permission request.

Wait for the configured relay before exposing a pairing endpoint: both gateway endpoint implementations await the configured N0 relay before returning. A freshly minted ticket therefore carries a relay-ready endpoint instead of asking the first mobile dial to wait for discovery repair.

Drive profile entry through stable handles and read the value back before submission: the profile field and Continue action have stable test IDs. The canary focuses the field by ID, types `Nightly`, reads it back, and only then submits.

Its already-asserted paired Home frame is copied to
`artifacts/e2e/ui-impact/issue-908-ios-paired-home.png`.

The shared screenshot resolver in `tests/agent-e2e-mobile/lib/harness.mjs`
accepts both direct and prefixed Maestro filenames; the same resolver is used
by `tests/agent-e2e-mobile/flows/pairing-canary.mjs`,
`tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`,
`tests/agent-e2e-mobile/flows/photos-viewer.mjs`, and
`tests/agent-e2e-mobile/flows/sharing-invite.mjs` so evidence assertions match
the filenames emitted by the CI runner.

The canary measures its existing five-minute budget at the actual prerequisite
boundary—when `configureGateway` has asserted Home—so its separate evidence
assertion and screenshot driver launch cannot inflate the pairing claim. The
ticket Connect action is tapped while the keyboard is visible because the
one-line control is deliberately kept in the viewport.

The implementation surface is explicit:

- `.github/workflows/e2e.yml` selects the Release-only native graph.
- `apps/mobile/App.tsx` places reconciliation behind onboarding.
- `apps/mobile/ios/Podfile`, `apps/mobile/ios/Podfile.lock`, and
  `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` define the resulting pod
  and resource graph; `apps/mobile/native-fingerprints.json` ratchets it.
- `apps/mobile/src/kit/test-ids.ts` and
  `apps/mobile/src/screens/Onboarding.tsx` publish the profile handles.
- `packages/tunnel/data-plane/src/iroh_relay.rs` and
  `packages/tunnel/src/gateway-endpoint.ts` wait for relay readiness.
- `tests/agent-e2e-mobile/lib/harness.mjs` drives and reads back the profile;
  `tests/agent-e2e-mobile/flows/pairing-canary.mjs` publishes the paired frame.
- `tests/agent-e2e-mobile/ledger/durations.json` preserves every earlier
  pairing-canary verdict generated while diagnosing the lane.

## User impact

No visual redesign is intended. First-run: pairing proceeds from the ticket to
the existing profile form and Home without an Expo developer picker or a Photos
permission prompt appearing over onboarding. The CI canary publishes the paired
Home evidence at `artifacts/e2e/ui-impact/issue-908-ios-paired-home.png`.

## Decisions

- Keep `expo-dev-client` installed for local Debug development; exclude its iOS
  pods only from the explicit Release E2E graph.
- Gate the reconciliation side effect at the product lifecycle boundary. A
  permission dialog belongs to the paired shell, not ticket onboarding.
- Preserve the five-minute canary and every product assertion. Stable handles
  and relay readiness fix the causes; no retry, timeout, or budget was widened.
- Use GitHub Actions as the only device-level authority for this issue. Local
  checks are limited to static, unit, native-state, and governance gates.

## Out of scope

- Redesigning onboarding or changing its identity/profile contract.
- Removing `expo-dev-client` from local Debug development.
- Widening E2E budgets, timeouts, retries, allowlists, or permission grants.
- Changing Android's artifact or journey roster.

## Verification

Checklist crosswalk:

- Build the iOS E2E artifact as a self-contained Release app without Expo development UI.
- Keep camera-roll reconciliation behind completed profile onboarding.
- Wait for the configured relay before exposing a pairing endpoint.
- Drive profile entry through stable handles and read the value back before submission.

Green before dispatch:

```sh
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile test src/screens/Onboarding.test.tsx
bun run --cwd apps/mobile ci:native-state
bun run --cwd packages/tunnel typecheck
bun run --cwd packages/tunnel test
bun run --cwd packages/tunnel lint:data-plane
bun run lint:e2e-flows
bun run lint:e2e-wiring
bun run lint:mobile-testids
bun run check:ui-receipt
bun run test:comment-density
bun run format:check
```

The authoritative device verdict is the dispatched `mobile-e2e-ios` workflow
run and will be recorded here after it completes.

## Audit

**VERDICT: REFUTED — completion is not yet proved.** The full iOS depth roster
has not passed on this head. CI evidence, iteration, and a final diff audit are
still required before merge.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-31 | codex | 01a056d8-e10f-7640-b99b-dc006668cc87 |
