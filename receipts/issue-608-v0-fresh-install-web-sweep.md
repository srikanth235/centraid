# Receipt: #608 — v0 fresh-install web sweep

## Checklist

The issue's acceptance checklist is reproduced verbatim. Groups A–N landed
first, under the `# Scope` limit of that change. Groups O and P landed in a
follow-up commit on the same issue, which lifts that scope limit and closes the
issue's full checklist.

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
- [x] Settings → Appearance offers exactly two themes plus a system option; `themes` has two keys and the six extra preset files are gone.
- [x] The dark ramp keeps one coherent surface structure — consistent elevation steps, sidebar treatment, and `--bg-l` response.
  <!-- The issue's wording asked for a warm/neutral/cool control. The owner
       cut the control outright for parity with the light theme, so this item
       is restated around the single ramp that remains. See Decisions. -->
- [x] A theme's declared accent renders when that theme is selected; the accent picker overrides it only when the user has chosen one.
- [x] The dark ramp's lightness matches what `darkTheme` declares unless the owner has moved the lightness knob.
- [x] No shell surface renders light-mode chrome on a dark background — toast and connection brand marks checked in dark.
- [x] A stored appearance pref naming a removed preset opens on Centraid Dark, with no error and no migration step.
- [x] Mobile's direct `themes.light` import still resolves, and knip finds no orphaned theme export.
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
- **O — theme registry cut:** the registry is `light` + `dark`; the six
  emulation preset files (Notion, Airtable, GitHub, Solarized, Nord, Monokai —
  ten registry entries) are deleted, and the twelve-card live-preview grid is
  replaced by a three-position Light / Dark / Match-system control. `Match
  system` is now a standing mode that follows `prefers-color-scheme` for as
  long as it is selected, not a button that snapped once. A registry key must
  equal its `kind`, which is what makes the three literal
  `[data-theme='dark']` shell rules (dark toast treatment, connection brand
  marks) exact again; `themes/themes.test.ts` pins that invariant so a future
  preset cannot silently reintroduce light chrome on a dark surface.
- **P — surface temperature and theme-versus-pref precedence:** the binary
  cool-cast switch is gone and nothing replaced it. Centraid Dark declares one
  ramp inline — neutral greyscale, every surface derived from `--bg-l` — and
  the emitted CSS carries no `data-surface-temp` at all. This went through a
  three-position cool/neutral/warm control first; the owner cut it for parity
  with the light theme, which has no temperature (see Decisions).
  Separately, `applyPrefsToDocument` no longer writes `--accent*` and `--bg-l`
  unconditionally: both are optional overrides, written only when the owner has
  chosen one and `removeProperty`'d when they have not, so a theme's declared
  accent and lightness anchor actually render.
- **Settings consolidation and control cuts (owner requests, beyond O/P):**
  Layout folded into Appearance — two adjacent pages both answering "how does
  Centraid look" was a split with nothing behind it, and Layout was down to two
  rows. The **Show sidebar** switch did not come with it: the chrome already
  has a toggle for that state, and two controls for one boolean guarantee one
  of them looks wrong. In Settings → Agents, the **Builder** routing lane is
  withheld (its entry points are hidden by default under #434, so it configured
  an unreachable surface) and **failover is offered only on the unattended
  Automations lane** (attended lanes recover at the next turn with the member
  present, so a pre-authorized ladder mostly bought silent provider handoff).
  Both hide controls without touching stored settings: a builder pin still
  resolves and still appears as a "used by" chip, and an attended lane's stored
  ladder is still honoured. `SettingsLayoutScreen` and the now-unused `Switch`
  control were deleted, which took a raw hex out of `settings-controls.module
  .css` and let the design-token ratchet tighten 1 → 0.
- **Appearance is the theme and nothing else (owner request, beyond O/P):**
  the accent swatches and the app-tile treatment picker were cut from the
  page, taking `SettingsAppearanceScreen.module.css` and four bridge props
  with them. The prefs survive and still apply — a stored accent still paints,
  `tileVariant` still drives every home tile — there is simply no control for
  choosing them, so a fresh install wears the accent its theme declares.
- **The whole identity row is the switcher (owner request):** clicking the
  space name, the avatar, or anywhere on the row opens the combined space and
  gateway popover, anchored to the row. The ⇅ is decoration inside that one
  button rather than a separate 26 px target at the right edge. Household
  keeps its sidebar nav entry and remains the row's behaviour only where no
  switcher is wired, so the control is never dead.
- **Docs/release:** client keying, runner behavior, enrollment/pair recovery,
  WAL ownership, the design-tokens trap (theme registry invariant + the
  pref-versus-theme precedence rule), and the Unreleased changelog now describe
  the shipped behavior.

### Changed paths

The following inventory is generated from the final issue diff and is audited
again immediately before commit:

<!-- changed-paths:start -->
- `CHANGELOG.md`
- `apps/extension/src/companion-api.ts`
- `apps/web/public/sw.js`
- `apps/web/src/sw-version.ts`
- `apps/web/src/web-chrome.test.ts`
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
- `docs/traps/design-tokens.md`
- `docs/traps/wal-checkpoint.md`
- `packages/agent-runtime/src/backends/acp/backend.test.ts`
- `packages/agent-runtime/src/backends/acp/backend.ts`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/preflight.test.ts`
- `packages/agent-runtime/src/preflight.ts`
- `packages/agent-runtime/src/registry.ts`
- `packages/app-engine/src/settings/settings-merge.test.ts`
- `packages/app-engine/src/settings/settings-merge.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/CSS-CONVENTIONS.md`
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
- `packages/client/src/react/screens/SettingsAppearanceScreen.module.css`
- `packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx`
- `packages/client/src/react/screens/SettingsAppearanceScreen.tsx`
- `packages/client/src/react/screens/SettingsLayoutScreen.test.tsx`
- `packages/client/src/react/screens/SettingsLayoutScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.tsx`
- `packages/client/src/react/screens/SettingsSpaceScreen.tsx`
- `packages/client/src/react/screens/StorageScreen.module.css`
- `packages/client/src/react/screens/StorageScreen.test.tsx`
- `packages/client/src/react/screens/StorageScreen.tsx`
- `packages/client/src/react/screens/settings-controls.module.css`
- `packages/client/src/react/screens/settings-controls.tsx`
- `packages/client/src/react/shell/App.test.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/IdentityHead.module.css`
- `packages/client/src/react/shell/IdentityHead.test.tsx`
- `packages/client/src/react/shell/IdentityHead.tsx`
- `packages/client/src/react/shell/Sidebar.test.tsx`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/appearance.test.ts`
- `packages/client/src/react/shell/appearance.ts`
- `packages/client/src/react/shell/gatewayRegistry.ts`
- `packages/client/src/react/shell/gatewaySwitcher.ts`
- `packages/client/src/react/shell/routes/AppViewRoute.tsx`
- `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `packages/client/src/react/shell/routes/DiscoverRoute.test.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/HouseholdRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.test.ts`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/StorageRoute.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderPreview.tsx`
- `packages/client/src/react/shell/routes/settingsProvidersData.ts`
- `packages/client/src/react/shell/routes/templatesData.test.ts`
- `packages/client/src/react/shell/routes/templatesData.ts`
- `packages/client/src/react/shell/useAppearance.test.tsx`
- `packages/client/src/react/shell/useAppearance.ts`
- `packages/client/src/react/shell/useMemberScopes.ts`
- `packages/client/src/react/ui/AppCard.module.css`
- `packages/design-tokens/src/css.test.ts`
- `packages/design-tokens/src/css.ts`
- `packages/design-tokens/src/index.ts`
- `packages/design-tokens/src/themes/airtable.ts`
- `packages/design-tokens/src/themes/centraid.ts`
- `packages/design-tokens/src/themes/github.ts`
- `packages/design-tokens/src/themes/index.ts`
- `packages/design-tokens/src/themes/monokai.ts`
- `packages/design-tokens/src/themes/nord.ts`
- `packages/design-tokens/src/themes/notion.ts`
- `packages/design-tokens/src/themes/shared.ts`
- `packages/design-tokens/src/themes/solarized.ts`
- `packages/design-tokens/src/themes/themes.test.ts`
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
- `receipts/issue-608-v0-fresh-install-web-sweep.md`
- `tests/design-token-css-budget.json`
<!-- changed-paths:end -->

## Out of scope

- The registered runner backend inventory remains intact; only the offered v0
  roster narrows. Existing hidden pins and ladders continue to resolve.
- **No lightness slider was added (O/P).** The acceptance criterion is that the
  dark ramp matches `darkTheme` *unless the owner has moved the knob*, which is
  a precedence requirement, not a request for new UI. `bgL` survives as an
  override-only pref that wins when present. With the temperature control cut
  too, the dark ramp ships with no knob at all — it is simply what the theme
  declares. Building a slider is separate work.
- The blueprint token layer (`toBlueprintCss`) keeps its own `--bg-l: 10%`
  dark anchor and is untouched. The shell resolves the *active* anchor for the
  iframe theme bridge instead of reading the pref layer's inline value.
- Appearance prefs are still applied as inline styles rather than moving to a
  stylesheet layer. Group P's open question notes that the gateway's first-paint
  bake and the blueprint iframe bridge both emit inline, so relocating the whole
  mechanism is wider than the precedence bug; making `bgL`/`accent`
  conditional fixes the bug without that surface change.
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
- **The three `[data-theme='dark']` shell rules stay literal** (group O's open
  question). With a two-entry registry whose keys equal their kinds, the literal
  selector is exact, and `themes/themes.test.ts` fails the build if a future
  preset breaks that. Moving them to the resolved kind would be dead
  generalization today; the test says what has to happen first instead.
- **Cool blue cast folds into the dark theme's own definition** (group O's other
  open question). It is no longer a peer of "Color theme": `darkTheme` is built
  from `darkRamp('neutral')` and `neutral` emits no override block, so the control
  reads as a sub-knob of the dark ramp — and it is hidden outright under a light
  theme rather than sitting there inert.
- **The declaration moved to `5%`; the product did not move.** Group P's
  criterion — "the ramp matches what the theme declares" — can be satisfied
  from either end, and the first attempt satisfied it from the wrong one:
  `darkTheme` declared `18%`, so making the theme authoritative shipped a
  mid-grey body. Rendered and reviewed, that was plainly not Centraid Dark.
  The `18%` had never reached a screen — the pref layer forced `5%` inline over
  it on every boot — so it was a dead declaration, not a specification, and the
  near-black at `5%` is what the product has always been. The declaration was
  corrected down to `5%`. Net user-visible change to the dark theme's
  lightness: none, which is the correct outcome for a precedence fix.
  Inherited cost, recorded on `darkTheme`: `--bg-app` is `calc(5% - 5%)`, true
  black.
- **Surface temperature was removed outright (owner decision, overrides the
  issue).** #608 asks for "warm, neutral, or cool" as a three-position control,
  and that shipped first — one shared ramp shape in `themes/dark-ramp.ts` with
  `[data-surface-temp]` override blocks. The owner then cut it on a parity
  argument: the light theme has no temperature, so a dark-only knob makes one
  half of the same setting behave unlike the other for no reason a member could
  name. Two supporting facts, measured rather than argued: at the shipped `5%`
  anchor the three positions render `rgb(11,12,14)` / `rgb(13,13,13)` /
  `rgb(15,13,11)` — indistinguishable — so the control could not have paid for
  its own complexity there; and the surviving ramp is the neutral one, so the
  blue-grey cast the temperatures existed to offer is not the default anyone
  gets. `dark-ramp.ts` was deleted and the ramp inlined on `darkTheme`;
  `css.test.ts` asserts the emitted CSS contains no `data-surface-temp`, so the
  knob cannot return without a deliberate test change. A stored `surfaceTemp`
  is dropped by `pickAppearance` rather than migrated.
- **Cutting accent and app tiles off Appearance overrides group O's own
  wording.** O says in as many words: "This is a theme cut, not an Appearance
  cut. Accent swatches and app-tile treatment are not themes and are untouched
  by it." The owner asked for them to go anyway, after seeing the page with
  the theme controls in place. Recorded here because the issue text and the
  shipped page now disagree, and the issue is the older document.
- **A chosen accent can no longer be un-chosen.** With the picker gone, an
  owner who had already picked one keeps it, and the only way back to the
  theme's own accent is clearing the pref. Called out rather than papered
  over: closing it means either a "use theme accent" reset or retiring the
  accent override entirely, and both are wider than the page cut that was
  asked for.
- **The local appearance cache key is bumped to `appearance.v2`.** The old shape
  persisted `bgL: 5` and `accent: 'teal'` on every save, and a stored number
  cannot be told apart from an owner who moved the knob. Per the pre-release
  no-migrations rule the new shape starts clean; gateway-backed prefs reconcile
  right after first paint.

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
- Settings → Appearance offers exactly two themes plus a system option; `themes` has two keys and the six extra preset files are gone. Evidence: `themes/index.ts` registers only `light` + `dark`; `airtable.ts`, `github.ts`, `monokai.ts`, `nord.ts`, `notion.ts`, and `solarized.ts` are deleted; `SettingsAppearanceScreen.tsx` renders one three-position `Segmented` (Light / Dark / Match system) and `SettingsAppearanceScreen.test.tsx` pins the three positions and asserts zero `.themeCard` nodes; `themes.test.ts` pins the two-key registry.
- The dark ramp keeps one coherent surface structure — consistent elevation steps, sidebar treatment, and `--bg-l` response. Evidence: `darkTheme` declares the ramp inline and `css.test.ts` asserts every dark surface is `hsl(0 0% …)` derived from `var(--bg-l)` (no surface hardcodes its lightness), that the sidebar keeps its `linear-gradient` at `/ 0.92)` — the alpha the old binary cool-cast switch used to flatten to 0.65 — and that the emitted stylesheet contains no `data-surface-temp` anywhere. Measured in the running web app: `--bg-l: 5%` with no inline override, `--bg` `rgb(13,13,13)`, `--bg-elev` `rgb(24,24,24)`, `--bg-sunken` `rgb(3,3,3)`, `--bg-app` `rgb(0,0,0)`, and zero `[data-surface-temp]` rules in any loaded stylesheet.
- A theme's declared accent renders when that theme is selected; the accent picker overrides it only when the user has chosen one. Evidence: `appearance.ts` writes `--accent*` only when `prefs.accent` is set and `removeProperty`s it otherwise; `effectiveAccent()` reports the theme's declared accent so the picker still marks a truthful active swatch. `appearance.test.ts` asserts the empty inline value on defaults, the written value after a pick, and the clear on unpick.
- The dark ramp's lightness matches what `darkTheme` declares unless the owner has moved the lightness knob. Evidence: `useAppearance.ts` no longer locks `bgL` to 5 and `applyPrefsToDocument` writes `--bg-l` only for an explicit override; `resolveBgL()` reads the active theme's anchor, and `appearance.test.ts` pins `darkTheme.bgL === '18%'` → `resolveBgL(DEFAULT_PREFS) === 18`, with an override of 5 still winning. The rendered comparison at both anchors is below.
- No shell surface renders light-mode chrome on a dark background — toast and connection brand marks checked in dark. Evidence: those rules key literally on `[data-theme='dark']`, and with the registry cut to two entries whose keys equal their kinds there is no dark theme they can miss. `themes.test.ts` fails if any future registry key stops equalling its `kind` — the exact condition that let Nord and Monokai leave them unfired.
- A stored appearance pref naming a removed preset opens on Centraid Dark, with no error and no migration step. Evidence: `pickAppearance` still gates `remote.theme` on `in themes`, so `{theme: 'monokai'}` yields `{}` and `DEFAULT_PREFS.theme` (`dark`) stands; `appearance.test.ts` asserts exactly that, with no thrown error and no migration path.
- Mobile's direct `themes.light` import still resolves, and knip finds no orphaned theme export. Evidence: the `light` key and the `lightTheme` / `colors` exports are unchanged, `apps/mobile` typecheck and its 289 tests pass, and `bun run knip` reports no unused exports (the now-orphaned `BEZEL` / `BEZEL_INNER` constants left with the presets that shared them).
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

Final gate for groups A–N (completed before that commit):

```text
bun run check:pr
# pass
# affected package tests passed, followed by the repository coverage gate
# 415 test files passed (2 skipped); 3,057 tests passed (7 skipped)
# diff coverage: 87.4% (376/430), above the 80% floor
```

### Groups O and P

The dark ramp rendered from the real `toCss()` output in headless Chromium, at
both candidate anchors × the three temperatures that were briefly shipped, plus
the light theme. Measured `--bg` per cell (`getComputedStyle` on the pane, not
read off the token file):

```text
                    18%                 5% (shipped, before and after)
cool      rgb(41, 44, 51)     rgb(11, 12, 14)
neutral   rgb(46, 46, 46)     rgb(13, 13, 13)
warm      rgb(52, 46, 39)     rgb(15, 13, 11)
light     rgb(252, 252, 252)
```

This table is why both group-P decisions landed where they did. At `5%` the
three temperatures collapse into the same near-black — the control could not
justify itself at the anchor the product actually ships — and the `18%` column,
where they *are* separable, is a lightness Centraid Dark has never worn. The
ramp stayed at `5%` and the temperatures were removed; the surviving column is
`neutral · 5%` = `rgb(13,13,13)`.

Verified in the running web app after the cut: `--bg-l` resolves to `5%` from
the theme block with **no inline override** on `<html>`, no `data-surface-temp`
attribute is written, and no loaded stylesheet contains a `[data-surface-temp]`
rule. Settings → Appearance renders a single row.

Focused suites:

Focused suites:

```text
bun run --cwd packages/design-tokens test
# 16 tests passed (3 files, incl. the new themes/themes.test.ts)

bun run --cwd packages/client test -- \
  src/react/shell/appearance.test.ts \
  src/react/shell/useAppearance.test.tsx \
  src/react/screens/SettingsAppearanceScreen.test.tsx
# 26 tests passed

bun run --cwd packages/app-engine test -- src/settings
# 24 tests passed
```

Every package suite, run one package at a time (the machine saturates at
`--concurrency=6`, which flaked two unrelated app-engine timing tests under
`test:affected:full` before passing cleanly on their own):

```text
design-tokens  16 passed          app-engine   593 passed
client       1478 passed          automation   375 passed
blueprints    666 passed          agent-runtime 339 passed (1 skipped)
web            22 passed          desktop      222 passed
mobile        289 passed
gateway      1235 passed, 6 skipped, 1 failed
```

The single gateway failure is
`src/serve/build-gateway.test.ts > network filesystem detection warns without
refusing and disables orphan deletion` (health snapshot `error` vs `degraded`).
It reproduces identically on `origin/main` with this branch stashed, and this
change touches no gateway source — it is pre-existing red, tracked separately.

Static gates:

```text
bun run typecheck            # 34/34 tasks successful
bun run lint                 # pass (oxlint + turbo lint + design-token lint)
bun run format:check         # pass (3,102 files)
bun run knip                 # pass (configuration hints only)
bun run lockfile:lint        # ok
bun run lint:packages        # ✓ no issues (sherif)
bun run lint:tsconfigs       # ok
bun run lint:types           # ok
bun run lint:css             # ok — 401 module imports, no dead classNames
bun run lint:design-tokens   # ok — zero regressions
bun run lint:e2e-flows       # ok
bun run lint:protocol-routes # ok
bun run lint:acp-min-versions# ok
bun run lint:workflow-pins   # ok — 17 workflows clean
bun run test:matrix          # ok — 15 surfaces × 11 dimensions
bun run test:accessibility   # pass
bun run scripts:test         # pass
bun run test:governance-shell# ok
bun run test:report:smoke    # ok
bun run test:ratchet         # ok — no decreases vs origin/main
bun run test:ratchet:unit    # pass
```

`lint:css` is the gate that matters for the picker rewrite: the eleven
`.themeCard*` / `.themePicker` rules were deleted with the grid they styled,
and it confirms no dead classNames and no orphaned selector left behind.

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
| claude-code-f698d7a6-95a-1785422258-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 1735 | 3801727 | 219954034 | 479861 | 4283323 | 145.7430 | 1735 | 3801727 | 219954034 | 479861 |  |
| claude-code-f698d7a6-95a-1785422362-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 8 | 9449 | 1335373 | 3802 | 13259 | 0.8218 | 1743 | 3811176 | 221289407 | 483663 |  |
| claude-code-f698d7a6-95a-1785422436-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 2 | 2450 | 336900 | 122 | 2574 | 0.1868 | 1745 | 3813626 | 221626307 | 483785 | probe |
| claude-code-f698d7a6-95a-1785422513-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 4 | 2858 | 678700 | 1174 | 4036 | 0.3866 | 1749 | 3816484 | 222305007 | 484959 | probe |
| claude-code-f698d7a6-95a-1785422621-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 8 | 1928 | 1364492 | 2504 | 4440 | 0.7569 | 1757 | 3818412 | 223669499 | 487463 |  |
| claude-code-f698d7a6-95a-1785422701-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 6 | 7386 | 1372272 | 1262 | 8654 | 0.7639 | 1763 | 3825798 | 225041771 | 488725 | probe2 |
| claude-code-f698d7a6-95a-1785422777-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 2 | 397 | 345436 | 103 | 502 | 0.1778 | 1765 | 3826195 | 225387207 | 488828 | probe3 |
| claude-code-f698d7a6-95a-1785422863-1 | claude-code | f698d7a6-95a6-466f-849a-fb0baec750d9 | #608 | claude-opus-5 | 6 | 2292 | 1037499 | 4524 | 6822 | 0.6462 | 1771 | 3828487 | 226424706 | 493352 |  |
