# Receipt: #608 — v0 fresh-install web sweep

## Checklist

The issue's acceptance checklist is reproduced verbatim. Groups O and P remain
unchecked because `# Scope` explicitly limits this change to groups A–N.

- [x] On a default #603 install (one gateway, `Shared` + `Personal`), a user can move the client to `Personal` and back without creating a space or re-running onboarding.
- [x] The control that does so is present when a member can reach ≥2 scopes on a single gateway.
- [x] Adding a gateway is reachable without already having two gateways.
- [x] The sidebar identity names the active space; entering via a `Personal` ticket shows `Personal`.
- [x] Settings → Space describes a control that exists, and `⌘⇧G` either opens it or the shortcut is dropped from the copy.
- [x] No "You're offline" banner while the Gateway page reports UP.
- [x] `pair` with no member flag enrolls the existing owner; creating a new member is explicit. Help text matches behaviour, and the daemon's configured port is honoured.
- [x] `GET /centraid/_agents/status` serves from cache on repeat requests, with a measured warm figure recorded in the receipt; an explicit refresh still re-probes.
- [x] An installed-but-ineligible agent (e.g. Claude Code under `authRequired`) is accounted for in the failover UI rather than silently absent.
- [x] The failover label distinguishes next-turn recovery (chat lanes) from in-fire recovery (automations).
- [x] Choosing then cancelling a fallback is visibly distinct from the control doing nothing.
- [x] Routing rows remain legible at 938 px — no lane label wrapping to one word per line.
- [x] A freshly founded vault occupies well under 25 MB at rest; first boot with two vaults lands near ~13 MB.
- [x] A client upgraded across a release boundary does not render onboarding paths deleted in a prior release.
- [x] `apps/web/dist` contains no bundles from a previous build.
- [x] No Settings page renders the "being migrated to React" placeholder, and no page head claims "Auto-saved" over a page that saves nothing.
- [x] None of Workspace, Storage provider, or Import appears in the Settings nav on a default install; a deep link to any of them does not strand the user on an empty pane.
- [x] The import staging pipeline and its routes are intact and still covered by tests after the page is hidden.
- [x] A multi-turn conversation records no `session_continuity` notice — in the transcript or in the ledger.
- [x] Self-heal, failover, and capability-refusal notices still appear.
- [x] Local footprint and storage limits are reachable from the Gateway page, and Operations no longer carries a separate Storage entry.
- [x] A gateway that can answer some storage questions and not others still renders partially, as it does today.
- [x] `{kind: 'storage'}` deep links and the router entry either resolve to the Gateway tab or are removed with their callers.
- [x] The automation gallery offers at most 8 templates, and none of them requires a connector that I hides.
- [x] Every offered template can be installed and fired on a fresh install without the owner minting a token by hand — or, where it cannot, the gallery says so before installation.
- [x] `OVERVIEW_SUGGESTION_IDS` names only templates that are still shipped.
- [x] No app's outbox is left without a carrier by the cut.
- [x] A template card and an automation tile share radius, padding, and hover treatment — the template gallery renders from the `AppCard` family rather than its own `.card`.
- [x] `--lib-tile-radius` has a locatable declaration, and every consumer passes a fallback so a missing token cannot square off the whole tile family.
- [ ] Settings → Appearance offers exactly two themes plus a system option; `themes` has two keys and the six extra preset files are gone.
- [ ] The dark ramp can be set warm, neutral, or cool, and all three keep the same surface structure — same elevation steps, same sidebar treatment, same `--bg-l` response.
- [ ] A theme's declared accent renders when that theme is selected; the accent picker overrides it only when the user has chosen one.
- [ ] The dark ramp's lightness matches what `darkTheme` declares unless the owner has moved the lightness knob.
- [ ] No shell surface renders light-mode chrome on a dark background — toast and connection brand marks checked in dark.
- [ ] A stored appearance pref naming a removed preset opens on Centraid Dark, with no error and no migration step.
- [ ] Mobile's direct `themes.light` import still resolves, and knip finds no orphaned theme export.
- [x] Settings → Agents shows exactly `codex`, `claude-code`, `opencode`, `grok`, `pi` — in the inventory, in every lane's primary picker, and in every failover dropdown.
- [x] `GET /centraid/_agents/status` reports only the roster, and probes only the roster; the warm timing recorded for D1 is taken against the narrowed set.
- [x] An existing pin or ladder entry naming a non-roster kind does not silently change behaviour, and the owner can see and clear it.
- [x] No OAuth provider without an Assist path is offered on the Connectors page, in Settings → Connections, or in the automation editor's connector picker. Google's four connectors and all six API-key providers remain.
- [x] An existing BYO connection to a now-hidden provider keeps working, and its owner can still see and remove it.
- [x] Pairing two browsers without typing anything produces two distinguishable rows in Household.
- [x] The redemption step asks for the device's name, and naming the gateway is either a separate input or not asked for at that step.
- [x] A device can be renamed from Household without revoking it.
- [x] An extension-platform device is identifiable alongside browser-tab devices paired from the same machine.

## What changed

- **A / B — shell context and connectivity:** restored a combined Spaces then
  Gateways switcher, made it unconditionally reachable (including Add gateway),
  wired `⌘⇧G`, rendered the active scope, and based web offline chrome on the
  gateway runtime signal rather than browser network heuristics.
- **C / J — pairing and devices:** bare `pair` targets the existing owner and
  preserves that owner's grants; explicit member creation remains opt-in.
  Redemption now names the device independently from the saved gateway,
  platform-specific defaults carry random disambiguators, and Household has an
  authorized inline rename path.
- **D / H — agent availability and routing:** the five-kind offered roster is
  distinct from registered/drivable backends; availability probes have keyed
  24-hour caching, in-flight deduplication, and explicit refresh. Routing copy,
  eligibility reasons, cancellation feedback, narrow layout, and hidden
  persisted pins now match actual failover semantics.
- **E / F — first-boot and web artifacts:** a fresh vault checkpoints once
  after bootstrap and before WAL shipping attaches; service-worker cache v12
  crosses the release boundary and Vite cleans the output directory.
- **G / L — navigation reduction:** Workspace, Storage provider, and Import
  are absent from public Settings navigation without deleting their working
  implementation. Local footprint and limits moved to Gateway → Storage;
  Backups/recovery remains on Gateway → Overview, its orphaned hidden-route
  Manage link is absent, and legacy storage routes redirect.
- **I / M / N — catalog curation:** offered providers are derived from API-key
  support or an Assist-enabled OAuth preset; the gallery is curated to eight
  fresh-install templates; template tiles use the shared `AppCard` family and
  the declared library radius token with fallbacks.
- **K — ledger hygiene:** ordinary ACP session-continuity notices are no longer
  emitted or stored; exceptional notices retain their existing source paths.
- **Docs/release:** client keying, runner behavior, enrollment/pair recovery,
  WAL ownership, and the Unreleased changelog now describe the shipped behavior.

### Changed paths

The following inventory is generated from the final issue diff and is audited
again immediately before commit:

<!-- changed-paths:start -->
- `CHANGELOG.md`
- `apps/extension/src/companion-api.ts`
- `apps/web/public/sw.js`
- `apps/web/src/sw-version.ts`
- `apps/web/src/web-chrome.ts`
- `apps/web/src/web-host.test.ts`
- `apps/web/src/web-host.ts`
- `apps/web/tests/e2e/web-pwa-cache.spec.ts`
- `apps/web/vite.config.ts`
- `docs/client-keying.md`
- `docs/enrollment.md`
- `docs/glossary.md`
- `docs/recovery/pairing.md`
- `docs/runners.md`
- `docs/traps/wal-checkpoint.md`
- `packages/agent-runtime/src/backends/acp/backend.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/preflight.test.ts`
- `packages/agent-runtime/src/preflight.ts`
- `packages/agent-runtime/src/registry.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AutomationTemplatesScreen.module.css`
- `packages/client/src/react/screens/AutomationTemplatesScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.module.css`
- `packages/client/src/react/screens/BackupCard.test.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/DeviceMemberGroup.tsx`
- `packages/client/src/react/screens/DeviceRow.tsx`
- `packages/client/src/react/screens/DevicesCard.module.css`
- `packages/client/src/react/screens/DevicesCard.test.tsx`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/DiscoverScreen.module.css`
- `packages/client/src/react/screens/GatewayScreen.test.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/HouseholdScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.tsx`
- `packages/client/src/react/screens/SettingsSpaceScreen.tsx`
- `packages/client/src/react/screens/StorageScreen.module.css`
- `packages/client/src/react/screens/StorageScreen.test.tsx`
- `packages/client/src/react/screens/StorageScreen.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/IdentityHead.test.tsx`
- `packages/client/src/react/shell/IdentityHead.tsx`
- `packages/client/src/react/shell/Sidebar.test.tsx`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/gatewayRegistry.ts`
- `packages/client/src/react/shell/gatewaySwitcher.ts`
- `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `packages/client/src/react/shell/routes/DiscoverRoute.test.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.test.ts`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/StorageRoute.tsx`
- `packages/client/src/react/shell/routes/settingsProvidersData.ts`
- `packages/client/src/react/shell/routes/templatesData.test.ts`
- `packages/client/src/react/shell/routes/templatesData.ts`
- `packages/client/src/react/shell/useMemberScopes.ts`
- `packages/client/src/react/ui/AppCard.module.css`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/device-admin.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/gateway/src/routes/agents-routes.test.ts`
- `packages/gateway/src/routes/agents-routes.ts`
- `packages/gateway/src/routes/connection-providers.ts`
- `packages/gateway/src/routes/connections-routes.test.ts`
- `packages/gateway/src/routes/connections-routes.ts`
- `packages/gateway/src/routes/device-invitations.ts`
- `packages/gateway/src/routes/devices-routes-invitations.test.ts`
- `packages/gateway/src/routes/devices-routes.test-fixtures.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/device-plane.test.ts`
- `packages/gateway/src/serve/enrollment-store.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-plane.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `apps/web/src/web-chrome.test.ts`
- `receipts/issue-608-v0-fresh-install-web-sweep.md`
<!-- changed-paths:end -->

## Out of scope

- Groups O and P (theme registry reduction, temperature control, and
  theme-versus-preference precedence) are excluded by issue #608's explicit
  `# Scope: In: Groups A–N`, even though their criteria remain in the broad
  issue checklist above.
- The registered runner backend inventory remains intact; only the offered v0
  roster narrows. Existing hidden pins and ladders continue to resolve.
- The import pipeline, hidden Settings implementations, BackupCard and its
  recovery surfaces, and non-gallery automation templates remain intact.
- `wal_autocheckpoint = 0`, the WAL shipper's ownership, page size, D13 consent,
  and cross-vendor failover policy are unchanged.
- A second client-side agent-status cache was deliberately not added: the
  server endpoint is warm in-process while preferences remain read fresh, which
  avoids stale routing state and duplicate invalidation policy.

## Decisions

- The combined sidebar switcher is the single owner of ambient space and
  gateway context. Explicit target pickers and conversation pins remain
  stronger keys.
- A bare host-custody pair ticket selects the oldest admin member for the
  target vault and carries all current grants, matching the auto-founded owner.
- OAuth offerability is positive capability data (`assistOnboarding`) rather
  than a Microsoft/Dropbox deny-list; full presets still resolve existing BYO
  connections.
- The gallery cut is an unlisting, not deletion. The generic outbox executor
  remains the carrier, so non-gallery apps and installed templates do not lose
  delivery behavior.
- The existing `--lib-tile-radius` declaration in design tokens is the source
  of truth; consumers add defensive `12px` fallbacks rather than duplicating a
  token declaration.
- Hiding Settings → Storage provider left no honest destination for the
  Backups-card Manage link, so the link is omitted while the backup/recovery
  status and actions remain fully available on Gateway → Overview.

## Verification

### Acceptance crosswalk

Each checked criterion is repeated verbatim here with the evidence that closes
it:

- On a default #603 install (one gateway, `Shared` + `Personal`), a user can move the client to `Personal` and back without creating a space or re-running onboarding. Evidence: `useMemberScopes.ts`, `App.tsx`, and `App.test.tsx` route both founded vaults through the switcher into `setActiveVault`.
- The control that does so is present when a member can reach ≥2 scopes on a single gateway. Evidence: `IdentityHead.tsx` always exposes the combined switcher, whose Spaces section is populated from every reachable member scope.
- Adding a gateway is reachable without already having two gateways. Evidence: `App.tsx` no longer gates the switcher on gateway count, `gatewaySwitcher.ts` always renders Add gateway, and the combined switcher is exercised from `App.test.tsx`.
- The sidebar identity names the active space; entering via a `Personal` ticket shows `Personal`. Evidence: `useMemberScopes.ts` resolves `active`, and `App.tsx` keys the identity head from that active scope rather than the primary scope.
- Settings → Space describes a control that exists, and `⌘⇧G` either opens it or the shortcut is dropped from the copy. Evidence: `SettingsSpaceScreen.tsx` and `SettingsRoute.tsx` describe the actual switch/add-gateway capabilities; `App.tsx` handles `⌘⇧G`.
- No "You're offline" banner while the Gateway page reports UP. Evidence: `web-chrome.ts` subscribes to `onGatewayRuntime`; `web-chrome.test.ts` covers online, down, and missing-snapshot states.
- `pair` with no member flag enrolls the existing owner; creating a new member is explicit. Help text matches behaviour, and the daemon's configured port is honoured. Evidence: `device-admin.ts`, `endpoint-host.ts`, and `cli.ts`, with device route/invitation coverage.
- `GET /centraid/_agents/status` serves from cache on repeat requests, with a measured warm figure recorded in the receipt; an explicit refresh still re-probes. Evidence: `preflight.ts` implements keyed 24-hour caching, in-flight de-duplication, and refresh; timings are recorded below.
- An installed-but-ineligible agent (e.g. Claude Code under `authRequired`) is accounted for in the failover UI rather than silently absent. Evidence: `settingsProvidersData.ts` derives `fallbackBlockedReason`, `SettingsProvidersScreen.tsx` renders it, and `SettingsProvidersScreen.test.tsx` pins the explanation.
- The failover label distinguishes next-turn recovery (chat lanes) from in-fire recovery (automations). Evidence: `SettingsProvidersScreen.tsx` uses surface-specific recovery copy and its direct test asserts both labels.
- Choosing then cancelling a fallback is visibly distinct from the control doing nothing. Evidence: `SettingsProvidersScreen.tsx` emits explicit cancellation feedback and its test asserts no ladder write occurs after rejection.
- Routing rows remain legible at 938 px — no lane label wrapping to one word per line. Evidence: `SettingsProvidersScreen.module.css` adds the bounded narrow-layout rules.
- A freshly founded vault occupies well under 25 MB at rest; first boot with two vaults lands near ~13 MB. Evidence: `vault-plane.ts` checkpoints bootstrap WAL before shipping, `vault-plane.test.ts` asserts the fresh WAL ceiling, and the measured two-vault footprint below is 10.48 MiB.
- A client upgraded across a release boundary does not render onboarding paths deleted in a prior release. Evidence: service-worker cache key v12 in `sw.js`/`sw-version.ts` and the PWA cache upgrade test.
- `apps/web/dist` contains no bundles from a previous build. Evidence: `vite.config.ts` enables `emptyOutDir`; the stale-artifact build check is recorded below.
- No Settings page renders the "being migrated to React" placeholder, and no page head claims "Auto-saved" over a page that saves nothing. Evidence: `SettingsRoute.tsx` routes hidden legacy pages safely and the remaining page descriptions match live controls.
- None of Workspace, Storage provider, or Import appears in the Settings nav on a default install; a deep link to any of them does not strand the user on an empty pane. Evidence: `SettingsRoute.tsx` filters those entries and `SettingsRoute.test.ts` pins all three deep-link fallbacks.
- The import staging pipeline and its routes are intact and still covered by tests after the page is hidden. Evidence: only Settings discovery/routing changed; the import implementation remains tracked and the full suite is green.
- A multi-turn conversation records no `session_continuity` notice — in the transcript or in the ledger. Evidence: `backend.ts` removes the routine source notice and `backend.test.ts` asserts its absence.
- Self-heal, failover, and capability-refusal notices still appear. Evidence: exceptional ACP notices retain their source paths and the agent-runtime suites remain green.
- Local footprint and storage limits are reachable from the Gateway page, and Operations no longer carries a separate Storage entry. Evidence: `GatewayScreen.tsx` owns the Storage tab and `Sidebar.tsx` removes the Operations entry.
- A gateway that can answer some storage questions and not others still renders partially, as it does today. Evidence: `StorageScreen.tsx` retains independent footprint/limits loading and errors; backup custody independently renders on Gateway Overview.
- `{kind: 'storage'}` deep links and the router entry either resolve to the Gateway tab or are removed with their callers. Evidence: `StorageRoute.tsx` delegates to `GatewayRoute` with `initialTab="storage"` and `App.tsx` highlights Gateway.
- The automation gallery offers at most 8 templates, and none of them requires a connector that I hides. Evidence: `templatesData.ts` curates exactly eight fresh-install-safe templates and its tests pin the list.
- Every offered template can be installed and fired on a fresh install without the owner minting a token by hand — or, where it cannot, the gallery says so before installation. Evidence: the curated templates use built-in/no-connector paths, while existing requirement copy remains available to non-gallery templates.
- `OVERVIEW_SUGGESTION_IDS` names only templates that are still shipped. Evidence: `templatesData.ts` and `templatesData.test.ts` cross-check suggestions against the curated gallery.
- No app's outbox is left without a carrier by the cut. Evidence: templates were unlisted rather than deleted and the generic outbox executor was unchanged.
- A template card and an automation tile share radius, padding, and hover treatment — the template gallery renders from the `AppCard` family rather than its own `.card`. Evidence: `AutomationTemplatesScreen.tsx` composes `appCard.card` plus `appCard.small`; its variant retains only the trigger-hue edge and inherits the shared hover.
- `--lib-tile-radius` has a locatable declaration, and every consumer passes a fallback so a missing token cannot square off the whole tile family. Evidence: the design-token declaration remains canonical and `AppCard.module.css`/gallery consumers use `var(--lib-tile-radius, 12px)`.
- Settings → Agents shows exactly `codex`, `claude-code`, `opencode`, `grok`, `pi` — in the inventory, in every lane's primary picker, and in every failover dropdown. Evidence: `registry.ts` exports the offered roster and client selectors consume the narrowed status/inventory.
- `GET /centraid/_agents/status` reports only the roster, and probes only the roster; the warm timing recorded for D1 is taken against the narrowed set. Evidence: `agents-routes.ts` probes `offeredAgentKinds`; its route tests and the timing below cover the five kinds.
- An existing pin or ladder entry naming a non-roster kind does not silently change behaviour, and the owner can see and clear it. Evidence: the full registered resolver remains intact while `SettingsProvidersScreen.tsx` surfaces persisted hidden entries and its test clears a stored `cursor` primary.
- No OAuth provider without an Assist path is offered on the Connectors page, in Settings → Connections, or in the automation editor's connector picker. Google's four connectors and all six API-key providers remain. Evidence: `connection-providers.ts` derives offerability from API-key support or `assistOnboarding`, and every catalog route filters with it.
- An existing BYO connection to a now-hidden provider keeps working, and its owner can still see and remove it. Evidence: provider execution/resolution remains unchanged, while the separate unfiltered `GET /connections` list still returns existing connections for visibility and removal even when `GET /providers` omits that preset.
- Pairing two browsers without typing anything produces two distinguishable rows in Household. Evidence: `ConnectFlowDetailsStep.tsx` generates browser/platform defaults, while `EnrollmentStore` atomically resolves any label collision against the live device roster; `device-plane.test.ts` pairs two deliberately identical defaults and asserts distinct rows.
- The redemption step asks for the device's name, and naming the gateway is either a separate input or not asked for at that step. Evidence: `ConnectFlowDetailsStep.tsx` labels the field Device name and keeps the saved gateway label separate.
- A device can be renamed from Household without revoking it. Evidence: `DeviceRow.tsx`, gateway client methods, and device routes implement the authorized inline rename path; `DevicesCard.test.tsx` renames without invoking revoke.
- An extension-platform device is identifiable alongside browser-tab devices paired from the same machine. Evidence: `apps/extension/src/companion-api.ts` supplies an extension-specific platform default and Household renders platform/device labels.

Focused verification completed while implementing:

```text
bun run --cwd apps/web typecheck
# pass

bun run --cwd apps/web test
# 21 tests passed

bun run --cwd packages/client test -- <seven touched suites>
# 96 direct remediation tests passed; 60 earlier focused tests passed

bun run --cwd packages/gateway test -- <five touched suites>
# 56 tests passed

bun run --cwd packages/gateway test -- src/serve/device-plane.test.ts
# 11 tests passed, including deliberate default-label collision

bun run --cwd packages/agent-runtime test -- <three touched suites>
# 72 tests passed

bun run --cwd packages/gateway test -- src/serve/build-gateway.test.ts
# 18 tests passed

bun run typecheck
# 32/32 tasks successful

bun run lint
# pass (pre-existing warnings only)

bun run format
# pass

bun run knip
# pass (configuration hints only)
```

Agent availability timing against the narrowed five-kind probe set
(`codex`, `claude-code`, `opencode`, `grok`, `pi`), using the same
`probeCliAvailability` path that backs `GET /centraid/_agents/status`:

```text
cold:    659.22 ms
warm 1:    0.07 ms
warm 2:    0.17 ms
warm 3:    0.01 ms
refresh: 344.37 ms
```

The explicit refresh took the subprocess path again; the cache unit also
removes an executable after the first probe and proves warm reads retain the
cached result until `refresh: true`.

Fresh product-daemon measurement immediately after two-vault auto-found:

```text
issue baseline: 42.3 MB total
after:          10,728 KiB (10.48 MiB) total
vault WALs:     0 bytes after bootstrap checkpoint
test ceilings:  <= 32 KiB per fresh vault WAL; <= 14 MiB two-vault data dir
```

Web artifact hygiene:

```text
bun run --cwd apps/web build
touch apps/web/dist/issue-608-stale-artifact.js
bun run --cwd apps/web build
test ! -e apps/web/dist/issue-608-stale-artifact.js
# pass; stale artifact removed, service-worker cache key is v12
```

Final gate (completed before commit):

```text
bun run check:pr
# pass
# affected package tests passed, followed by the repository coverage gate
# 415 test files passed (2 skipped); 3,057 tests passed (7 skipped)
# diff coverage: 87.4% (376/430), above the 80% floor
```

## Steering

**Verdict: PASS**

A fresh-context transcript audit found no human interrupts or mid-task
corrections. The single `/goal` message initialized the work and is not a
steering event, so no Steering rows are required.

## Audit

**Verdict: PASS**

The final fresh-context audit found the acceptance crosswalk faithful to the
implementation, all checked Groups A–N criteria realized, and Groups O–P
correctly left unchecked. Its only initial blocker — possible collision
between two autogenerated device labels — was closed at the gateway's atomic
enrollment boundary and re-audited PASS.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fa9ca-0c8-1785266476-1 | codex | 019fa9ca-0c82-7dc3-a747-52f9c19de886 | #608 | gpt-5.6-sol | 1442519 | 0 | 69539072 | 106692 | 1549211 | 22.5914 | 1442519 | 0 | 69539072 | 106692 | feat: close v0 fresh-install scope (#608) |
| codex-019fa9ca-0c8-1785266521-1 | codex | 019fa9ca-0c82-7dc3-a747-52f9c19de886 | #608 | gpt-5.6-sol | 2075 | 0 | 176384 | 350 | 2425 | 0.0545 | 1444594 | 0 | 69715456 | 107042 | feat: close v0 fresh-install scope (#608) |
