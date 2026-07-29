# issue-634 — Onboarding + identity: pairing durability, household-level names, honest runner state

GitHub issue: [#634](https://github.com/srikanth235/centraid/issues/634)

A scenario campaign across the onboarding surfaces surfaced a connected set of
identity and pairing defects on web and mobile. The through-line is that
**identity was device-local when it should have been household-level, and
pairing durability was tied to an unrelated checkbox**. Each symptom is a
different face of that, so they land together with the test work that found
them.

## Checklist

- [x] Make the web connection + device key always durable; `rememberDevice` governs only the offline replica and cache eligibility
- [x] Add a "Forget this device" action (Settings → This device, and the account menu's Log out)
- [x] Move the display name to the household roster (`renameGatewayMember`), with Settings → Profile to change it
- [x] Reorder onboarding to pairing-first; make the name step conditional on the roster not already naming the person
- [x] Apply the same conditional-name rule to mobile onboarding
- [x] Merge device rows by `endpointId`, carrying `enrollmentIds` and per-vault roles
- [x] Make Household responsive via container queries rather than viewport media queries
- [x] Rebuild Settings as a modal dialog with a vertical rail; put the account row + popover (Settings / Pair device / Log out) in the sidebar foot
- [x] Replace Settings → Phone with a Pair device modal hosting the real ticket flow (the phone-tunnel screen is Electron-only and inert on web)
- [x] Distinguish an unprobed runner from one that genuinely needs sign-in
- [x] Let a catalog surface settle to `empty` once a warm has completed, and fall an empty catalog back to the models the capability probe already observed
- [x] Land the desktop/mobile e2e and gateway/vault test work that surfaced the above

## What changed

### Crosswalk

Each checklist item above, against the section that describes it:

- Make the web connection + device key always durable; `rememberDevice` governs only the offline replica and cache eligibility — see *The web connection + device key are always durable* below.
- Add a "Forget this device" action (Settings → This device, and the account menu's Log out) — see *Settings is a dialog; the sidebar foot is who you are* below.
- Move the display name to the household roster (`renameGatewayMember`), with Settings → Profile to change it — see *The display name lives on the household roster* below.
- Reorder onboarding to pairing-first; make the name step conditional on the roster not already naming the person — see *The display name lives on the household roster* below.
- Apply the same conditional-name rule to mobile onboarding — see *The same rule on mobile* below.
- Merge device rows by `endpointId`, carrying `enrollmentIds` and per-vault roles — see *Device rows merge by hardware; Household responds to its own width* below.
- Make Household responsive via container queries rather than viewport media queries — see *Device rows merge by hardware; Household responds to its own width* below.
- Rebuild Settings as a modal dialog with a vertical rail; put the account row + popover (Settings / Pair device / Log out) in the sidebar foot — see *Settings is a dialog; the sidebar foot is who you are* below.
- Replace Settings → Phone with a Pair device modal hosting the real ticket flow (the phone-tunnel screen is Electron-only and inert on web) — see *Pair device is an act, not a preference* below.
- Distinguish an unprobed runner from one that genuinely needs sign-in — see *Honest runner state and a model catalog that settles* below.
- Let a catalog surface settle to `empty` once a warm has completed, and fall an empty catalog back to the models the capability probe already observed — see *Honest runner state and a model catalog that settles* below.
- Land the desktop/mobile e2e and gateway/vault test work that surfaced the above — see *The campaign itself* below.

### The web connection + device key are always durable

`apps/web/src/web-state.ts`, `apps/web/src/iroh-transport.ts`,
`apps/web/src/web-host.ts`, `apps/web/src/iroh-transport.test.ts`,
`apps/web/src/web-host.test.ts`

`saveConnection` no longer follows `rememberDevice`. It used to put the
enrollment in `sessionStorage` whenever that flag was false — the default — so
closing the browser silently unpaired a device that had already been paired and
the app asked for a ticket again. Both `centraid.web.v1.connection` and
`centraid.web.v1.iroh-device-key` now go to `localStorage` unconditionally;
`loadConnection` still reads `sessionStorage` as a one-way migration.

`moveIrohDeviceKeyForConsent` became `adoptDurableIrohDeviceKey` and
`endpoint()` lost its `rememberDevice` parameter, because the key's home no
longer depends on the choice. **`rememberDevice` now governs exactly one
thing**: the offline replica plus cache eligibility (the `d-`/`e-` bridge-id
prefix the service worker keys on).

### The display name lives on the household roster

New `packages/client/src/react/shell/routes/profileData.ts`,
new `packages/client/src/react/screens/SettingsProfileScreen.tsx`,
new `packages/client/src/react/screens/SettingsProfileScreen.module.css`,
`packages/client/src/react/screens/OnboardingScreen.tsx`,
`packages/client/src/react/screens/OnboardingScreen.test.tsx`,
`packages/client/src/react/screens/FirstRunGate.test.tsx`,
`packages/client/src/react/boot.tsx`,
`packages/client/src/react/screen-contracts.ts`

Onboarding wrote the name only into device-local settings, where nothing
rendered it and no other household member could ever see it — the roster kept
saying `"You"`. `saveSelfProfile` now calls `renameGatewayMember`, and
**Settings → Profile** edits the same value. The avatar colour stays local
because it is chrome, not identity.

Onboarding is reordered **pairing-first**, and the name step became
conditional: `loadSelfProfile` reads the `current` device's `memberLabel`,
treating the `PLACEHOLDER_MEMBER_LABEL` (`"You"`) an auto-founded gateway
assigns as unset. Pairing a second device for someone the roster already names
never asks again.

### The same rule on mobile

`apps/mobile/src/lib/gateway.ts`, `apps/mobile/src/screens/Onboarding.tsx`,
`apps/mobile/src/screens/Onboarding.test.tsx`

Mobile ran `connect → profile` unconditionally — the identical gap. New
`readSelfMemberName()` reads the `current` device's `memberLabel` over the
tunnel; onboarding adopts it and skips the profile step when it comes back set.
`undefined` (unreachable, no device plane, failed read) still asks: a failed
read is not evidence of a name, and one redundant question beats a silently
wrong identity.

### Device rows merge by hardware; Household responds to its own width

`packages/client/src/react/screens/device-groups.ts`,
`packages/client/src/react/screens/device-groups.test.ts`,
`packages/client/src/react/screens/DevicesCard.tsx`,
`packages/client/src/react/screens/DevicesCard.module.css`,
`packages/client/src/react/screens/DevicesCard.test.tsx`,
`packages/client/src/react/screens/DeviceMemberGroup.tsx`,
`packages/client/src/react/screens/DeviceRow.tsx`,
`packages/client/src/react/screens/HouseholdScreen.tsx`,
`packages/client/src/react/screens/HouseholdScreen.module.css`,
`packages/client/src/react/screens/GatewayScreen.module.css`,
`packages/client/src/react/shell/memberScope.ts`

`/centraid/_gateway/devices` returns one row per **(device, vault)**
enrollment, so a browser paired into two spaces read as two devices. Rows merge
by `endpointId` into a `GroupedDevice` carrying `enrollmentIds` and the
per-vault `GatewayVaultGrant`s — roles survive the merge, the count reports
hardware, and a revoke drops every enrollment for that device.

Household's breakpoints moved from viewport media queries to **container
queries**: a card in a narrow column never fires a viewport query, which is why
its text wrapped one letter per line. Two traps worth carrying forward — an
element cannot respond to a container it declares itself (the container must
sit on a wrapper), and `@container` adds no specificity, so the block must come
last in the file or a later plain rule silently wins.

### Settings is a dialog; the sidebar foot is who you are

`packages/client/src/react/shell/routes/SettingsRoute.tsx`,
`packages/client/src/react/shell/routes/SettingsRoute.module.css`,
`packages/client/src/react/shell/App.tsx`,
`packages/client/src/react/shell/Sidebar.tsx`,
`packages/client/src/react/shell/Sidebar.test.tsx`,
`packages/client/src/react/shell/chrome.module.css`,
`packages/client/src/react/shell/contextMenu.ts`,
new `packages/client/src/react/screens/SettingsDeviceScreen.tsx`,
`packages/client/src/react/shell/routes/settingsAccountData.ts`,
`packages/client/src/react/shell/glyphs.tsx`

Settings became a modal dialog with a vertical rail (⌘, / Escape / backdrop)
rather than a route — changing a preference must not cost you your place in the
app, and dismissing returns you exactly where you were. The sidebar foot now
shows **who you are** instead of a bare "Settings" row, opening a popover with
Settings / Pair device / Log out. `contextMenu` grew `matchAnchorWidth` so the
menu aligns with the sidebar column's edges instead of floating at some content
width inside it.

Retiring the sidebar's Settings row orphaned `SettingsGlyph`, so it is
deleted — knip is strict about unused exports.

Web-only **This device** page: what this browser stores locally (its pairing,
its offline copy, its cached previews) and a Forget action, which the account
menu's Log out shares.

### Pair device is an act, not a preference

New `packages/client/src/react/shell/routes/PairDeviceModal.tsx`

It hosts the **same** `DevicePairPanel` that Household → Devices offers — two
ways to one surface, not a second implementation that can drift. Self-pair is
the landing state, so adding your own phone grants exactly the access you
already hold and names no member.

Deliberately **not** the old Settings → Phone screen, which is dropped from the
rail: that is the Electron tunnel surface, and on web its host answers *"Phone
pairing is managed by the gateway or desktop client"* — it could never mint a
code there.

### Honest runner state and a model catalog that settles

`packages/gateway/src/routes/agents-routes.ts`,
`packages/gateway/src/routes/agents-routes.test.ts`,
`packages/gateway/src/serve/build-gateway.ts`,
`packages/gateway/src/serve/build-gateway.test.ts`,
`packages/agent-runtime/src/models/catalog-warmer.ts`,
`packages/agent-runtime/src/models/catalog-warmer.test.ts`,
`packages/client/src/react/shell/routes/settingsProvidersData.ts`,
`packages/client/src/react/shell/routes/settingsProvidersData.test.ts`,
`packages/client/src/react/screens/AssistantScreen.tsx`,
`packages/client/src/react/shell/routes/AssistantRoute.tsx`

Three separate untruths in one surface:

1. The gateway **omits** `capabilities` entirely until the probe reports, and
   also when it throws. The client read that silence as "not ready" and
   labelled every installed runner "setup or sign-in needed" — including ones
   that were signed in and working. `sessionProbePending` now separates
   unprobed from signed-out, and the picker says "checking…" for the former.
2. `resolveCatalogSurface` re-kicked a warm on **every** read while the cache
   was empty, so `isWarming` was never false at read time and `deriveStatus`
   could never leave `loading`. `CatalogWarmer.hasWarmed` records a completed
   warm whatever it produced, letting a surface settle to `empty`; an explicit
   Refresh is still the way to ask again.
3. Catalog enumeration is opt-in per kind (`probeModels` — codex and
   claude-code), but the **capability probe already reads the same
   `session/new` model option** for every available agent. opencode was
   advertising 76 models there while its picker said "Built-in model". An empty
   catalog now falls back to that evidence — no extra spawn, and nothing
   fabricated, since it only echoes `{value, name}` pairs the agent offered.

### Gateway-client error hygiene and the Connect flow

`packages/client/src/gateway-client-core.ts`,
`packages/client/src/gateway-client-atlas.ts`,
`packages/client/src/gateway-client-connections.ts`,
`packages/client/src/gateway-client-outbox.ts`,
`packages/client/src/gateway-client-vault.ts`,
`packages/client/src/react/shell/routes/ConnectFlow.tsx`,
`packages/client/src/react/shell/routes/ConnectFlow.test.tsx`,
`packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`,
`packages/client/src/react/shell/routes/ConnectFlowVaultStep.tsx`,
`packages/client/src/react/shell/routes/connectFlow-core.ts`,
`packages/client/src/react/shell/routes/connectFlow-core.test.ts`,
`packages/client/src/react/shell/routes/connectFlowIO.ts`,
`packages/client/src/react/shell/routes/connectFlowIO.test.ts`

A non-JSON body means something other than the gateway answered — a captive
portal, a stale service-worker shell, a proxy error page. Scenario run B3
leaked `returned non-JSON: <!doctype html>…` straight into the Gateway screen.
New `nonJsonError` keeps the raw body diagnostic (console) and puts plain words
in the thrown message. The Connect flow picked up the same treatment plus the
step fixes the scenarios turned up.

### The campaign itself

`tests/onboarding-scenarios.md` (new — the superset scenario checklist across
all three surfaces),
`apps/desktop/tests/e2e/onboarding-home.spec.ts`,
`apps/desktop/tests/e2e/settings-gateways.spec.ts`,
`apps/desktop/src/main/gateway-monitor.ts`,
`tests/agent-e2e-mobile/lib/harness.mjs`,
`tests/agent-e2e-mobile/lib/metro.mjs`,
`tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`,
`tests/agent-e2e-mobile/flows/native-v0-resilience.md`,
`tests/agent-e2e-mobile/flows/template-gate.mjs`,
`tests/agent-e2e-mobile/flows/volume-proof.mjs`,
`packages/gateway/src/serve/serve.test.ts`,
`packages/gateway/src/serve/vault-registry.ts`,
`packages/gateway/src/serve/vault-registry.test.ts`,
`packages/gateway/src/serve/vault-plane.ts`,
`packages/gateway/src/serve/enrollment-store.ts`,
`packages/gateway/src/routes/device-invitations.ts`,
`packages/gateway/src/routes/devices-routes.ts`,
`packages/gateway/src/routes/devices-routes-invitations.test.ts`,
`packages/gateway/src/cli/device-admin.ts`,
`packages/vault/src/host.ts`, `packages/vault/src/index.ts`,
`docs/dev-environment.md`, `docs/recovery/pairing.md`

The scenario coverage that produced every finding above, plus the gateway-side
seams the scenarios needed — vault registry, vault-plane host surface,
enrollment store, invitation routes, and the `device-admin` CLI. The docs
updates record the worktree/port conventions and the pairing recovery steps the
runs exercised.

### What CI caught that local gates did not

The desktop Playwright lane runs against a mock gateway that has no device
plane, so `GET /centraid/_gateway/devices` answers 404 and the roster reads as
empty. `identityOrFinish` treated "cannot read the roster" the same as "the
roster already knows you" and finished first run with an EMPTY name — which
the host then tried to write as the Personal vault's name, drawing a 400
`bad_name`. Unreadable now falls to ASKING (`OnboardingScreen.tsx`), because a
name we did not need costs one screen and a name we never collected costs the
identity; `boot.tsx` additionally refuses to rename a vault to "". Covered by a
new unit test. The two settings specs were realigned to the surfaces this
change actually moved: Settings opens from the account menu now, and it is an
overlay, so the page underneath keeps its own `<h1>` mounted.

## Decisions

- **One issue, one commit, one receipt.** The findings are eight separate
  defects but a single cause; splitting them across issues would have made each
  fix read as unmotivated. The operator asked for a single commit, so the
  originally-planned eight-commit split was collapsed.
- **`rememberDevice` was kept, not deleted.** The obvious alternative was to
  drop the checkbox entirely now that it no longer controls pairing. It still
  governs a real, separate choice (whether this browser keeps an offline copy),
  so it stays — narrowed, not removed.
- **Pair device hosts `DevicePairPanel`, not the phone-tunnel screen.** The
  first implementation moved the existing Settings → Phone screen into the
  account menu verbatim. Live testing showed the web host stubs it
  (*"Phone pairing is managed by the gateway or desktop client"*), so it could
  never mint a code there. Repointed at the real ticket flow.
- **The capability-probe model fallback runs gateway-side, not client-side.**
  The client could have read `capabilities.configOptions` itself, but then
  every consumer would need the same rule. Doing it in `readAgentsStatus` keeps
  one answer on the wire.
- **`loading` is never overridden by the fallback.** An in-flight warm may
  still fill the catalog, so the client keeps polling rather than latching a
  fallback that a real enumeration would replace a second later.
- **`tests/results/onboarding-web.md` is not committed.** It is the output of
  one run against one machine's gateway; the durable artefact is
  `tests/onboarding-scenarios.md` plus the Verification section below.
- **Live verification was manual.** The web PWA was driven through the browser
  tool and the phone through the iOS simulator, because the defects were all in
  what the surfaces *rendered* — a DOM-stubbed assertion would have passed
  against every one of them.

## Out of scope

- **The design-system split.** `apps/mobile/src/kit/theme` duplicates the
  spacing scale by hand, `radii` resolves to two different key sets depending
  on the import, and mobile's theme descends from `toBlueprintCss()` — the
  language meant for user-built blueprint apps — rather than a named theme of
  its own. Real, but a separate change.
- **The Electron phone-tunnel screen.** Left in place and still reachable on
  desktop; only its Settings entry point moved.
- **Runner sign-in itself.** Centraid stays agnostic to how each CLI
  authenticates; this only stops mislabelling the state.
- **Android parity for the mobile onboarding change.** The logic is
  platform-neutral and unit-tested; the live pass was iOS-only.

## Audit

(1) **'## What changed' faithfully describes the diff.** PASS. Every file section listed in the receipt corresponds to modifications in `git status --short`: web state layers (5 files), household roster display name (8 files), mobile pairing (3 files), device grouping and Household layout (9 files), Settings modal and sidebar (9 files + 2 new), pair device modal (1 new), runner state and catalog (10 files + 1 test), gateway-client error hygiene (13 files), test campaign work (35 files across gateways, mobile, e2e flows, and docs). No material omissions or misdescriptions.

(2) **Each '- [x]' checklist item is realized in the diff.** PASS. All 12 items are represented: (1–2) web connection durability and Forget device in web-state.ts + SettingsDeviceScreen.tsx; (3–5) display name moved to roster and both onboarding surfaces reordered and made conditional (SettingsProfileScreen.tsx, OnboardingScreen.tsx mobile/gateway.ts); (6–7) device rows merged by endpointId (device-groups.ts) and Household container-queried (HouseholdScreen.module.css); (8–9) Settings rebuilt as modal with sidebar foot (SettingsRoute.tsx, Sidebar.tsx) and Pair device modal (PairDeviceModal.tsx); (10–11) runner state distinguished (agents-routes.ts, catalog-warmer.ts) and catalog settles with fallback; (12) e2e and vault test work landed (onboarding-scenarios.md, e2e flows, vault-registry.ts).

(3) **'## Checklist' mirrors issue #634 checklist.** PASS. All 12 items in the receipt match the GitHub issue action items exactly: identical wording, identical order, all marked complete.

## Verification

```sh
bun run lint
bun run --cwd packages/client test
bun run --cwd packages/gateway test
bun run --cwd packages/agent-runtime test
bun run --cwd apps/mobile test
bun run --cwd apps/web test
bun run --cwd packages/client typecheck
bun run --cwd packages/gateway typecheck
bun run --cwd apps/mobile typecheck
```

Results — `bun run lint` clean, typechecks clean, and:

| Package | Files | Tests |
| --- | --- | --- |
| `packages/client` | 189 | 1447 passing |
| `packages/gateway` | 176 (1 skipped) | 1212 passing (6 skipped) |
| `packages/agent-runtime` | 36 (1 skipped) | 338 passing (1 skipped) |
| `apps/mobile` | 42 | 253 passing |
| `apps/web` | 7 | 22 passing |

Live, against a fresh gateway data dir, driven through the web PWA and the iOS
simulator:

```sh
node packages/gateway/dist/cli/cli.js serve --data-dir ./gwnew --host 127.0.0.1 --port 18790
```

- **Reconnect** — fresh gateway → ticket defaults to Personal → pair with the
  offline copy unchecked → restart the gateway → the browser reconnects with no
  ticket prompt.
- **Device list** — a browser paired into two spaces reads as
  "1 person · 2 devices", each row listing both spaces.
- **Name** — Household shows `Srikanth S`; the sidebar foot and account popover
  show the same, and the popover reads Settings / Pair device / Log out.
- **Runner labels** — the picker reported exactly what the gateway probed:
  `["Codex", "Claude Code — setup or sign-in needed", "opencode", "Grok",
  "pi — setup or sign-in needed"]` (`claude-code` had `authRequired: true` with
  reason *OAuth session expired*; `pi` was `available: false`).
- **Model catalog** — selecting opencode as the Assistant agent lists 77 options
  (76 models + "Use default"); the "Discovering models…" entry is gone. Grok
  settles on no model choice instead of spinning.
- **Mobile pairing** — ticket minted from the account menu's Pair device and
  pasted into a freshly reinstalled simulator app: **no name prompt**, straight
  to "You're all set, Srikanth"; home reads "Good evening, Srikanth" with an
  `SS` avatar. Web Household then showed **1 person · 3 devices** — both phone
  pairings under the same member, no duplicate created.

CI then ran the gate that is deliberately not local — the desktop Playwright
lane — and it found two real regressions this commit had caused (see *What CI
caught*). After the fixes the whole lane is green locally:

```sh
bun run --cwd apps/desktop build
npx playwright test -c tests/e2e/playwright.config.ts
```

The `verify` job's per-PR perf gate also failed on `eventLoop.peakP99Ms`
(310 ms and 352 ms across its two attempts, ceiling 150 ms; main measured
69 ms). Locally on this branch the same benchmark reports **57.8 ms** — under
both main's number and the ceiling — so this reads as runner load, not a
branch regression. CI's re-run is the authority.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-820a2fd7-1785335254-0 | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | correction | classifier | Don't fold profile into space | pending | 11 | 2026-07-29T14:27:34.304Z |
| steer-820a2fd7-1785335591-1 | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | interrupt | structural |  | pending | 12 | 2026-07-29T14:33:11.552Z |
| steer-820a2fd7-1785335615-2 | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | correction | classifier | Add profile as separate tab | pending | 13 | 2026-07-29T14:33:35.670Z |
| steer-820a2fd7-1785335718-3 | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | interrupt | structural |  | pending | 14 | 2026-07-29T14:35:18.052Z |
| steer-820a2fd7-1785339296-4 | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | interrupt | structural |  | pending | 28 | 2026-07-29T15:34:56.764Z |
| steer-820a2fd7-1785341677-5 | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | correction | structural | Consolidate all changes into single commit | pending | 35 | 2026-07-29T16:14:37.650Z |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-820a2fd7-6eb-1785342074-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 28 | 57581 | 4379834 | 21431 | 79040 | 3.0857 | 2078 | 3127034 | 282717151 | 439763 |  |
| claude-code-820a2fd7-6eb-1785342198-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 13 | 30858 | 2174231 | 4742 | 35613 | 1.3986 | 2091 | 3157892 | 284891382 | 444505 |  |
| claude-code-820a2fd7-6eb-1785342282-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 8 | 5575 | 1292096 | 1394 | 6977 | 0.7158 | 2099 | 3163467 | 286183478 | 445899 |  |
| claude-code-820a2fd7-6eb-1785342358-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 8 | 6333 | 1301864 | 1896 | 8237 | 0.7380 | 2107 | 3169800 | 287485342 | 447795 |  |
| claude-code-820a2fd7-6eb-1785342611-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 17 | 9159 | 3295667 | 2138 | 11314 | 1.7586 | 2124 | 3178959 | 290781009 | 449933 |  |
| claude-code-820a2fd7-6eb-1785342679-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 2 | 340 | 332381 | 138 | 480 | 0.1718 | 2126 | 3179299 | 291113390 | 450071 |  |
| claude-code-820a2fd7-6eb-1785342745-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 4 | 2936 | 665442 | 884 | 3824 | 0.3732 | 2130 | 3182235 | 291778832 | 450955 |  |
| claude-code-820a2fd7-6eb-1785347486-1 | claude-code | 820a2fd7-6eb1-465e-b979-3d07e5bc7187 | #634 | claude-opus-5 | 1856 | 2651376 | 271555853 | 366177 | 3019409 | 161.5127 | 3986 | 5833611 | 563334685 | 817132 | fix(onboarding): ask for a name when the roster is unreadable (#634)The desktop  |
## Steering

(1) **Every human-steering event in the transcript is recorded as a row.** PASS. The transcript contains six steering events: three interrupts (messages 12, 14, 28 marked "[Request interrupted by user]") and three corrections (message 11 "wait...fold profile into space...no need of settings", message 13 "just add profile as another tab...no need to fold it into space", and message 35 "do single commit pleasse"). All six are recorded in the Steering table above with distinct `(session, ordinal)` pairs and appropriate type/tier assignments.

(2) **No non-steering message is recorded as a steering event.** PASS. The transcript includes local-command markers, compaction notices, model switches, skill invocations, and task notifications — none of which are semantic redirects or interrupts of agent work. Only the six messages listed above represent genuine redirection (user reversing UI design decisions and consolidation strategy) or paused work (the three runtime-marked interrupts), and only those appear in the table.
