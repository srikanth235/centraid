# issue-774 — Experimental feature gate for automations and connectors (v0)

GitHub issue: [#774](https://github.com/srikanth235/centraid/issues/774)

Automations and connectors ship in the codebase but are not part of v0.
This issue puts both behind a per-gateway experimental gate so the owner
and enthusiastic early users can opt in, while everyone else's gateway
neither advertises nor mounts the surfaces. Turning a feature off never
deletes durable data — automation definitions, run history, and
connector credentials all survive a flag flip. Recognition recipes
(OCR, faces, embeddings, transcripts) are bundled automations and are
deliberately **not** gated: the photos experience is v0.

## Checklist

- [x] One resolver: `resolveExperimentalFeatures` (env > prefs > host option > off)
- [x] C1 capability flags `automations` / `connectors` (optional, absent-tolerant)
- [x] Gateway walls: routes unmounted, webhook ingress unowned, user rows unarmed
- [x] Recognition recipes keep arming with automations off
- [x] Shell capability seam + walls; mobile places gate + FeatureOffPlace
- [x] Daemon `config.json` seed lane; `CENTRAID_EXPERIMENTAL` env authority
- [x] Serve-boot gating tests incl. prefs-driven two-boot opt-in
- [x] Docs: decisions.md ruling, config-ownership.md keys, protocol.md row

## What changed

### One resolver, three inputs

`packages/gateway/src/serve/experimental-features.ts` (pinned by
`packages/gateway/src/serve/experimental-features.test.ts`) resolves both
flags once at serve boot: `CENTRAID_EXPERIMENTAL` (comma-separated
feature names) is authoritative for **every** feature when set at all —
listed means on, unlisted means off — matching the
`CENTRAID_RESOURCE_MODE` contract; otherwise the prefs keys
`gateway.experimental.automations` / `.connectors` (written through the
generic prefs API) decide; otherwise the host's `BuildGatewayOptions`
seed; otherwise off. Unknown env tokens are surfaced as warnings, never
guessed at. Changes apply on the next serve boot.
`packages/gateway/src/cli/config.ts` validates an optional `experimental`
field on daemon `config.json` exactly like `resourceMode`;
`packages/gateway/src/cli/cli.ts` spreads it into `serve()`, covered by
`packages/gateway/src/cli/cli.test.ts`.

### Off means absent, not hidden

With a flag off, `packages/gateway/src/serve/build-gateway.ts` does not
mount the surface: connections and OAuth-callback routes, the
`_automations` / `_insights` store-backed prefixes, and webhook ingress
are never registered (404, not 403), so there is no live-but-unsupported
attack surface. The C1 handshake in
`packages/protocol/src/capabilities.ts` advertises `automations` /
`connectors` (and `automationTurns` rides `automations`) as **optional**
capability flags — old payloads without them stay valid, clients read
absence as off; `packages/protocol/src/index.ts` exports
`OPTIONAL_GATEWAY_CAPABILITIES`, and
`packages/protocol/src/capabilities.test.ts` plus
`packages/protocol/src/handshake-properties.test.ts` pin the
absent-or-boolean shape (the property test asserts optional keys
unconditionally: `expect(result.ok).toBe(optional.has(capability))`).

### Recognition keeps running

Per-vault schedulers always start. The gate lives in the scheduler
reconcile row filter in `build-gateway.ts` (pinned by
`packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`): rows
owned by recognition templates arm on their own `enabled` bit; all other
automation rows arm only when the experimental flag is on. Capture-time
OCR, faces drains, and embedding backfill are therefore unaffected.
`ConnectionBroker` and the outbox stay constructed unconditionally
(backup and vault-route internals depend on them); only their HTTP
reachability is gated. `POST /centraid/_automations/enrichment` stays
behind the gate — it has no caller in the repo; Photos consent goes
through the vault `enrich.policy` command.

### Test opt-ins across the gateway

Sites whose surfaces actually failed under the gated-off default opted in
explicitly: `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`,
`packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`,
`packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`,
`packages/gateway/src/lifecycle/install-over-http.test.ts`,
`packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`,
`packages/gateway/src/serve/build-gateway.test.ts`,
`tests/agent-e2e-pairing/lib/harness.mjs` (env in `spawnDaemon`), and
`tests/agent-e2e-mobile/lib/ci-gateway.mjs` (build option). The new
`packages/gateway/src/serve/experimental-gating.test.ts` proves the wall
over real serve boots.

### Client walls, not blank pages

The shell reads capabilities once at boot through one seam:
`packages/client/src/react/shell/capabilities.ts` (pure `ROUTE_CAPABILITY`
table) and `packages/client/src/react/shell/useCapabilities.tsx`
(`CapabilitiesProvider`), published from
`packages/client/src/react/shell/App.tsx`. Launcher, palette, all-apps
sheet, and ops bar filter gated destinations
(`packages/client/src/react/shell/launcherModel.ts`,
`packages/client/src/react/shell/launcherModel.test.ts`,
`packages/client/src/react/shell/Stem.tsx`,
`packages/client/src/react/shell/AllAppsSheet.tsx`,
`packages/client/src/react/shell/routes/paletteData.ts`); direct
navigation hits `packages/client/src/react/shell/CapabilityWall.tsx`.
The per-app Automations tab withdraws with its reads
(`packages/client/src/react/screens/AppSettingsPanel.tsx`,
`packages/client/src/react/shell/routes/AppSettingsController.tsx`,
`packages/client/src/react/screen-contracts.ts`), and the editor's
connector surfaces withdraw together with their loaders
(`packages/client/src/react/screens/AutomationEditorScreen.tsx`,
`packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`).
Covered by `packages/client/src/react/shell/App.capabilities.test.tsx`,
`packages/client/src/react/shell/App.test.tsx`, and
`packages/client/src/react/shell/App.inline-branch.test.tsx`.

### Mobile places gate

`apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts` reads
the flags off the one compatibility wall
(`apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts`),
`apps/mobile/src/kit/replica/ReplicaProvider.tsx` publishes them, and
`apps/mobile/src/screens/home/places.ts` filters places above the data
hooks (`apps/mobile/src/screens/home/HomeBand.tsx`,
`apps/mobile/src/screens/home/AllAppsSheet.tsx`). Gated places render
`apps/mobile/src/kit/components/FeatureOffPlace.tsx` /
`FeatureOffPlace.styles.ts`
(`apps/mobile/src/apps/automations/Automations.tsx`,
`apps/mobile/src/screens/connectors/Connectors.tsx` — the
`ConnectorsScreen`→`ConnectorsPlace` dispatcher avoids a conditional
hook). Tests: `mobile-gateway-compatibility.test.ts`,
`mobile-gateway-compatibility.integration.test.ts`,
`places.test.ts`, `Automations.test.tsx`, `Connectors.test.tsx`, and the
journey pin in `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`.

### Docs

`docs/decisions.md` records the ruling (including the recognition
carve-out and the client "unknown ≠ off" rule), `docs/config-ownership.md`
the prefs keys, precedence, and `config.json` seed lane, and
`docs/protocol.md` the optional absent-tolerant capability pair.

### Checklist crosswalk

One resolver: `resolveExperimentalFeatures` (env > prefs > host option > off) — see "One resolver, three inputs".
C1 capability flags `automations` / `connectors` (optional, absent-tolerant) — see "Off means absent, not hidden".
Gateway walls: routes unmounted, webhook ingress unowned, user rows unarmed — see "Off means absent, not hidden" and "Recognition keeps running".
Recognition recipes keep arming with automations off — see "Recognition keeps running".
Shell capability seam + walls; mobile places gate + FeatureOffPlace — see "Client walls, not blank pages" and "Mobile places gate".
Daemon `config.json` seed lane; `CENTRAID_EXPERIMENTAL` env authority — see "One resolver, three inputs".
Serve-boot gating tests incl. prefs-driven two-boot opt-in — see "Test opt-ins across the gateway" (`experimental-gating.test.ts` writes the pref through `handle.prefs.setPrefs` and proves it opens the surface on the next boot).
Docs: decisions.md ruling, config-ownership.md keys, protocol.md row — see "Docs".

## Decisions

- **Gateway-side gate, not build-time stripping or a hosted flag
  service**: each user owns their gateway in this local-first
  architecture, so the opt-in switch *is* the allowlist, and the existing
  C1 machinery carries it.
- **Env is authoritative when set at all** (listed → on, unlisted → off),
  mirroring `CENTRAID_RESOURCE_MODE` rather than inventing a third
  precedence idiom.
- **Insights rides the automations gate**: its gateway routes unmount
  with the flag, so leaving the page reachable would have shown a
  permanently empty screen that never explains itself.
- **Unknown ≠ off on mobile and at the route wall**: an *unanswered*
  capability question never hides a mobile place (offline cold starts
  must not reshuffle navigation), and the desktop route wall shows a
  blank frame rather than an accusation until resolved. The desktop
  launcher/palette deliberately trade the other way — they boot at off
  because hiding beats flashing against a loopback gateway that answers
  within a frame; the trade is recorded in `capabilities.ts`.
- **No enrichment-toggle carve-out**: `POST
  /centraid/_automations/enrichment` has no caller anywhere in the repo,
  so it stays gated; the narrow fix if a client ever needs it is a second
  `forRoutePrefixes` registration on the same handler.

## Out of scope

- Hot-applying a flag flip on a running gateway — changes apply at the
  next serve boot, same as Resource mode.
- Gating recognition recipes or the Photos experience.
- Identity-based allowlisting or any hosted feature-flag service.
- Deleting or migrating any durable data on flag-off.
- The desktop `builderEnabled` Automations tab inside BuilderCloud (dev
  flag, off in releases).

## Verification

```sh
bun run --cwd packages/gateway test
bun run --cwd packages/gateway typecheck
bun run --cwd packages/protocol test
bun run --cwd packages/client test && bun run --cwd packages/client typecheck
bun run --cwd apps/mobile test && bun run --cwd apps/mobile typecheck
bun run lint && bun run format:check
```

Observed: gateway 1502 passed / 6 skipped; protocol 48; client 2232
across 246 files; mobile 1349; typecheck clean across all touched
packages; oxlint + oxfmt clean. Known environmental failures only:
`gateway-db-lock.integration.test.ts` needs the `sqlite3` CLI (absent in
the dev container) and mobile `PendingRestartJourney.test.tsx` cannot
bundle `node:sqlite`; both fail identically on the untouched baseline.
The nightly e2e harness opt-ins (`agent-e2e-pairing`,
`agent-e2e-mobile`) are mechanical twins of verified paths but
unverified by execution here.

## Files

- `packages/gateway/src/serve/experimental-features.ts` · `packages/gateway/src/serve/experimental-features.test.ts` · `packages/gateway/src/serve/experimental-gating.test.ts` · `packages/gateway/src/serve/build-gateway.ts` · `packages/gateway/src/serve/build-gateway.test.ts` · `packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/gateway/src/cli/cli.ts` · `packages/gateway/src/cli/cli.test.ts` · `packages/gateway/src/cli/config.ts`
- `packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts` · `packages/gateway/src/lifecycle/install-over-http.test.ts` · `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts` · `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts` · `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/protocol/src/capabilities.ts` · `packages/protocol/src/capabilities.test.ts` · `packages/protocol/src/handshake-properties.test.ts` · `packages/protocol/src/index.ts`
- `packages/client/src/react/shell/capabilities.ts` · `packages/client/src/react/shell/useCapabilities.tsx` · `packages/client/src/react/shell/CapabilityWall.tsx` · `packages/client/src/react/shell/App.tsx` · `packages/client/src/react/shell/App.test.tsx` · `packages/client/src/react/shell/App.capabilities.test.tsx` · `packages/client/src/react/shell/App.inline-branch.test.tsx` · `packages/client/src/react/shell/Stem.tsx` · `packages/client/src/react/shell/AllAppsSheet.tsx` · `packages/client/src/react/shell/launcherModel.ts` · `packages/client/src/react/shell/launcherModel.test.ts` · `packages/client/src/react/shell/routes/paletteData.ts` · `packages/client/src/react/shell/routes/AppSettingsController.tsx` · `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx`
- `packages/client/src/react/screen-contracts.ts` · `packages/client/src/react/screens/AppSettingsPanel.tsx` · `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `apps/mobile/src/lib/replica/mobile-gateway-compatibility-core.ts` · `apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts` · `apps/mobile/src/lib/replica/mobile-gateway-compatibility.test.ts` · `apps/mobile/src/lib/replica/mobile-gateway-compatibility.integration.test.ts` · `apps/mobile/src/kit/replica/ReplicaProvider.tsx` · `apps/mobile/src/screens/home/places.ts` · `apps/mobile/src/screens/home/places.test.ts` · `apps/mobile/src/screens/home/HomeBand.tsx` · `apps/mobile/src/screens/home/AllAppsSheet.tsx` · `apps/mobile/src/kit/components/FeatureOffPlace.tsx` · `apps/mobile/src/kit/components/FeatureOffPlace.styles.ts` · `apps/mobile/src/apps/automations/Automations.tsx` · `apps/mobile/src/apps/automations/Automations.test.tsx` · `apps/mobile/src/screens/connectors/Connectors.tsx` · `apps/mobile/src/screens/connectors/Connectors.test.tsx` · `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`
- `tests/agent-e2e-mobile/lib/ci-gateway.mjs` · `tests/agent-e2e-pairing/lib/harness.mjs`
- `docs/decisions.md` · `docs/config-ownership.md` · `docs/protocol.md` · `receipts/issue-774-experimental-feature-gate.md`

## Audit

PASS — a fresh-context audit against the issue intent and `git diff origin/main...HEAD` confirms the load-bearing claims. `resolveExperimentalFeatures` implements exactly the stated precedence (env authoritative for every feature when `CENTRAID_EXPERIMENTAL` is set at all, else boolean prefs, else host option, else off, unknown tokens surfaced as warnings and logged at boot); `build-gateway.ts` conditionally registers the connections/OAuth-callback handler and narrows the store-backed prefix list to `/centraid/_apps` with automations off, and the webhook handler falls through to not-found; the scheduler reconcile filter arms recognition-template rows on their own `enabled` bit while all other rows require `experimental.automations`, with schedulers started unconditionally — the recognition carve-out is real, not aspirational. The protocol changes (optional `automations`/`connectors` keys, `OPTIONAL_GATEWAY_CAPABILITIES` export, the property test's `optional.has(capability)` assertion), the CLI `experimental` config lane, the client seam (`capabilities.ts` route table, `useCapabilities.tsx`, `CapabilityWall`), the mobile places filter with pin state untouched, the test opt-ins, and all three doc updates are present as described. File lists cover the diff without phantom entries, and the Out of scope section matches the code (no hot-apply, no data deletion, `builderEnabled` untouched).

The audit flagged one overstated decision bullet — the blanket "unknown ≠ off on clients" rule holds on mobile and at the desktop route wall, but the desktop launcher/palette deliberately boot at off (hiding beats flashing against a loopback gateway), and a failed capability read resolves to off rather than staying unknown. The bullet above and the `docs/decisions.md` ruling were narrowed to match the code in response; the desktop first-frame trade is recorded in `capabilities.ts`. Everything else verified; verification counts spot-checked where cheap (design suite re-run matches).
