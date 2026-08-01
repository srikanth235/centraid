# Onboarding test scenarios

Manual/agent-driven test scenarios for the onboarding mechanism across all three client surfaces (post #603 onboarding rethink, #599 household model, #628 unified mobile offline).

**Drivers.** Browser tool against the web PWA, the iOS simulator tool against a mobile dev build, and Playwright/manual against the Electron desktop are **all first-class**. Android is a required parity pass, not an optional one — mobile changes ship iOS + Android together.

Related automated coverage: `apps/desktop/tests/e2e/onboarding-home.spec.ts` (§1.1/§1.2/§1.4), `apps/web/tests/e2e/web-pwa.spec.ts`, `apps/mobile/src/screens/Onboarding.test.tsx`, `tests/agent-e2e-mobile/flows/`, `packages/gateway/src/serve/build-gateway.test.ts`. This doc is the superset checklist; **[auto]** marks scenarios with an automated equivalent today. ⚠️ Several mobile e2e flows are currently broken — see [Broken test assets](#broken-test-assets-fix-before-relying-on-them).

---

## Mechanism summary (what we are testing)

- **Auto-founding.** A gateway with a fresh data dir _and_ zero `members` rows creates two vaults on first boot — `Shared` then `Personal` — and enrolls the host endpoint as member "You" with `admin` on both (`packages/gateway/src/serve/build-gateway.ts:1019`). **`Personal` is the default everywhere**, never `Shared`: `Personal` is founded with a durable `personal` marker in its own `core_vault.settings_json`, and `defaultVaultId()` prefers the marked vault (falling back to the oldest only when none is marked). Listing order follows the same marker (#665): `VaultRegistry.list()` puts the default vault FIRST and the remainder in creation order, so `Personal` heads every client-facing vault list (`GET /_vault/vaults` and `GET /_vault/scopes` alike) and a client that reads element 0 as "primary" agrees with `defaultVaultId()`. With no marked vault the head is the oldest, exactly as before. The marker survives the desktop fresh path renaming `Personal` to the owner's display name, which a name match would not. The **never-inhabited guard**: an erased-but-inhabited gateway (members exist, vaults gone) boots with zero vaults and reports vault health `error`; it is never re-founded.
- **Pair tickets are the only enrollment path.** Single-use, default TTL 15 min, minted via the desktop Household → Devices panel, `POST /centraid/_gateway/devices/ticket`, or `centraid-gateway pair`. Redeemed exclusively over iroh ALPN `centraid/gw-pair/1` (the HTTP `POST /centraid/_gateway/pair` route is gone). A redeemed device gets an **enrollment row** bound to a member with per-vault roles — there is no bearer token.
- **Desktop first-run** branches on platform: chooser "Start fresh on this Mac" vs "Connect with a ticket". The local gateway is **latched off** (`deferLocalStart`) until `setActiveGateway({id:'local'})` lifts it — this is also what defers the macOS keychain prompt. Steps: `identity → (ticket) connect → (local) service`. There is no `complete` step; finishing writes `onboardingCompletedAt` and unmounts the gate. The fresh path then renames the auto-founded `Personal` vault to the display name (non-fatal on failure). Desktop gateway mode is **detached by default** (`centraid-gateway` daemon on port 17832, survives app quit); `CENTRAID_EMBEDDED_GATEWAY=1` forces in-process (e2e does this).
- **Web PWA** gets no chooser — ticket is the only method. State lives under `centraid.web.v1.*`: `connection` (localStorage if "remember this device", sessionStorage otherwise), `settings` (`onboardingCompletedAt`), `iroh-device-key`, `iroh-bridge`.
- **Mobile** runs a three-step machine `connect → profile → done` (`apps/mobile/src/screens/Onboarding.tsx:36`) rendered _outside_ the nav container, gated on `centraid.v1.profile.onboarded`. Profile comes **after** pairing (desktop/web collect it before). Pairing accepts two payload shapes and stores only the `gw` dial hint — `t`/`s` are discarded. Paired gateways become **Spaces**, a device-local `(gatewayId, vaultId)` registry. Requires a **dev build**: `CentraidTunnel` is a local native module, so `isTunnelAvailable()` is false in Expo Go and onboarding becomes a dead end.

---

## Test rigs

### Gateway (shared by all surfaces)

```bash
centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 17832
```

Auto-founds `Shared` + `Personal`. Web UI serves on **API port + 1**, falling back to an ephemeral port with a warning — read the `web app: http://127.0.0.1:<p>` startup line.

Mint tickets:

```bash
centraid-gateway pair --data-dir ./gw-data --vault Shared --ttl-minutes 15 --role write --json
```

Other flags: `--new-member <label>`, `--member <id-or-label>`, `--grant <vault>:<role>`, `--qr`. Fresh gateway state = delete the data dir. **The data dir cannot be copied/moved to a new path** — the host credential is keyed by path, so a copied dir dies with `KeyStore AES-GCM authentication failed` (verified 2026-07-29). For CI-shaped runs, `tests/agent-e2e-mobile/lib/ci-gateway.mjs` starts a tokenless loopback gateway on `127.0.0.1:18789`.

### Browser (web PWA)

Fresh-state reset = a new browser profile / incognito window. Clearing `centraid.web.v1.*` from local **and** session storage plus the SW iroh-bridge caches also works but is easy to get half-right. To exercise uncommitted client code: `bun run --cwd apps/web build && node packages/gateway/scripts/embed-web.mjs`, then restart serve.

### Desktop (Electron)

Launch: `bun run dev:desktop`, or Playwright via `apps/desktop/tests/e2e/fixtures.ts` — `launchApp()` runs `_electron.launch` against built `dist/main.js` (build first) with an isolated `--user-data-dir`, `CENTRAID_DATA_DIR` pointed into a temp workspace, and `CENTRAID_EMBEDDED_GATEWAY=1`.

State locations (macOS): userData `~/Library/Application Support/Centraid` — `centraid-settings.json` (0600, atomic tmp+rename), `connections.json` (gateway profiles), `connection-secrets.bin` (one safeStorage ciphertext: iroh keys, loopback tokens, wrapping keys), `phone-link/`. **Gateway data is NOT in userData** — `$CENTRAID_DATA_DIR` or the platform default dir (`gateway.db`, `keys/`, `vault/`, `gateway-logs/`).

**Clean first-run reset = delete all four userData files/dirs AND the gateway data dir.** Deleting only settings leaves the gateway inhabited → the fresh path _adopts_ existing vaults (see C10). E2E seeding: `seedRemoteGateway(env, gw)` pre-writes `onboardingCompletedAt` (pass `{onboarding:true}` to keep first-run); no seeding = true fresh install. Always `closeApp()` (bounded wait + SIGKILL) before relaunch tests — the single-instance lock can outlive `close()`.

Desktop selectors are thin: only `first-run-choice`, `onboarding-view` (+ `data-step`, `data-mounted`), `onboarding-service-accept`/`-decline`, and `pair-panel` exist as testids. ConnectFlow/HandshakeLadder/VaultStep have **none** — drive by role/name (`textbox "Your name"`, `button "Continue"`, radios `Color <hex>`). Traps: `docs/traps/electron-screenshot.md` (hidden window background-throttling, iframe capture).

### Mobile (iOS simulator — primary)

Dev build required; Expo Go cannot pair.

```bash
bun install
bun run --filter=@centraid/mobile ios
```

Then Metro **from `apps/mobile/`** (from the repo root it fails `Unable to resolve module expo`):

```bash
cd apps/mobile && bunx expo start --dev-client
```

Driving: use the iOS simulator tool — `attach` the live panel first, then `screenshot` / `tap` / `text` to verify headlessly. Bundle id is `dev.centraid.mobile`, but **Android debug builds get `.debug`** (`dev.centraid.mobile.debug`) — resolve it per platform, never hardcode.

**Reset to a genuinely clean first run: `xcrun simctl erase <udid>`.** App delete and Maestro `clearState` are _not_ sufficient — `expo-secure-store` items live in the iOS keychain and survive app deletion (see **G2**, the highest-value scenario in this doc).

Simulator constraints and traps:

- **No camera on the sim** → the QR path cannot be exercised; **paste is the only sim-testable pairing route**. (On Android, `emulator -camera-back webcam0` can point at a QR on screen — untested here, treat as speculative.)
- Cold JS bundle dominates first launch — allow ~120 s (`FIRST_LAUNCH_TIMEOUT_MS`).
- First keystroke on a clean sim raises iOS's multilingual keyboard sheet; provoke and dismiss it with a throwaway character before the real input.
- `clearState` wipes the dev client's cached Metro URL → `No script URL provided` redbox. Recover with `xcrun simctl openurl <udid> "dev.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`.
- Never cache CocoaPods: a Pods cache hit makes Expo skip `pod install`, which is the only thing that runs the centraid-tunnel podspec's `prepare_command` fetching `Iroh.xcframework`. It fails on the _second_ native change, not the first.
- iOS build needs **Xcode ≥ 26.4** (Expo SDK 57 / `swift-tools-version: 6.2`); verify with `bun run ci:xcode`.

### Mobile selectors — there are no testIDs

`Onboarding.tsx` has **zero `testID`s**. Automation must match on **visible text** (buttons are `Pressable` wrapping `<Text>`, so the label is the a11y name) or on **placeholder** for the two `TextInput`s. Note that `accessibilityLabel` on a RN `TextInput` does not reach the iOS a11y tree — the placeholder becomes `hintText`; anchor relatively. The only real a11y labels in the flow are the colour swatches: `` `Colour ${hex}` `` with `accessibilityState.selected`.

Load-bearing strings:

| Step | Strings |
| --- | --- |
| connect | `Connect your gateway.` · `DEVICE NAME` · `PAIRING CODE` · placeholder `Paste the one-line ticket` · `Continue with pasted code` (→ `Connecting…`) · `Scan QR instead` |
| profile | `Who's using this phone?` · placeholder `Your name` · `COLOUR` · error `Enter a name so the people you share with know who you are.` |
| done | `You're all set, <firstName>.` · `Enter Centraid` |
| home | `YOUR APPS` · `Open vault menu` · `Pair desktop` / `Connect your computer` / `Desktop is offline` |
| settings | section `Desktop link` · `Pair another` · `Unpair` · a11y `Paste pairing ticket` · `Pair with ticket` |

Worktree trap: `bun install` + `bun run build` inside the worktree, private data dirs, no symlinked `node_modules` (`docs/traps/worktrees.md`).

---

## A. Gateway founding (server-side preconditions)

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| A1 | **[auto]** Fresh data dir auto-founds | Start `serve` with an empty data dir | `Shared` + `Personal` exist; **Personal** is the default ticket target (`personal` marker, not creation order); Shared is oldest so it heads `vault list`; host endpoint enrolled as "You", `admin` on both; `/info` carries no founding/status fields |
| A2 | **[auto]** Restart of inhabited gateway is a no-op | Restart serve on the A1 dir | Same two vaults; no new vault, member, or enrollment rows |
| A3 | **[auto]** Erased-but-inhabited is NOT re-founded | Delete vault dirs, keep `gateway.db`; restart | Zero vaults mounted; vault health `error`; no re-founding; recovery is `docs/recovery/vault-erase.md` |
| A4 | Corrupt vault does not trigger re-founding | Corrupt a vault dir so it fails to mount; restart | `isFresh()` counts failed mounts → no founding; vault appears under `failedMounts` |

## B. Web PWA — new device (primary driver)

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| B1 | **[auto]** Happy path | Fresh profile → open web UI → mint self-pair ticket → paste → complete identity | No method chooser, no URL field; connects over iroh; identity (name + colour) collected; `centraid.web.v1.settings.onboardingCompletedAt` set |
| B2 | Remember-device ON → revisit | B1 with remember checked; close tab; reopen | `connection` + `iroh-device-key` in **localStorage**; persistent storage requested; revisit skips onboarding, reconnects with no ticket |
| B3 | Remember-device OFF → revisit | B1 unchecked; close tab; reopen | `connection` was sessionStorage-only → gone; ticket flow again; a _new_ ticket needed; gateway accumulates a second enrollment (flag the stale-device-row UX) |
| B4 | Expired ticket | `--ttl-minutes 1`, wait out expiry, paste | Client-side expiry check rejects before dialing; `ticket_expired` copy; no enrollment |
| B5 | Burned ticket | Redeem once, paste the same ticket in a second fresh profile | `invalid_ticket` (single-use DELETE-on-consume); second device not enrolled |
| B6 | Malformed / wrong-kind payload | Garbage; a desktop `centraid-pair` payload; truncated base64 | Rejected at decode (`kind !== "centraid-gw-pair"`, missing `gw`/`t`/`s`); no dial for undecodable input |
| B7 | Wrong secret does NOT burn the ticket | Craft right `t` + wrong `s`; attempt; then redeem the genuine ticket | First fails; genuine ticket **still redeems** (hash mismatch returns before deletion) |
| B8 | Gateway unreachable at redeem | Stop the gateway; paste a valid ticket | Fails at the `reach` stage / `unreachable` copy; retry without losing entered state; offline banner suppressed pre-onboarding |
| B9 | Gateway down on revisit | With a remembered connection, stop the gateway, reload | App boots (no re-onboarding); offline state surfaced; recovers when the gateway returns, no re-pair |
| B10 | Concurrent double-redeem race | Two profiles submit the same ticket simultaneously | Exactly one wins (`BEGIN IMMEDIATE`, `changes === 1`); loser gets `invalid_ticket`; one enrollment row |
| B11 | Read-only role | Mint `--role read`; onboard | Pairs; blob trust `readonly`; Viewer affordances only (no peer-device revoke) |
| B12 | Vault-targeted ticket | Mint `--vault Shared`; onboard | Active vault is Shared, not the Personal default (an unnamed mint lands in Personal) |
| B13 | Installed PWA pass | Repeat B1–B2 from the installed PWA | Same behaviour; storage survives; install banner doesn't interfere |

---

## C. Desktop — first run, fresh path (primary driver)

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| C1 | **[auto]** Happy path — "Start fresh on this Mac" | Clean userData + clean gateway data dir → launch → `first-run-choice` → fresh → identity → service decline | **Before** commit: `getSettings().gatewayUrl === ""` (defer latch — no gateway spawn, no keychain prompt); after Continue: gateway starts, active vault = `Personal`, renamed to the display name; final vault list `['<name>','Shared']`; `onboardingCompletedAt` set; no `complete` step — gate unmounts straight into the app |
| C2 | Identity validation & controls | On identity: empty name, 60+ char paste, Enter key, colour radios | Continue disabled until trimmed name non-empty (`data-state` idle→ready); `maxLength=60` clips; Enter submits; radiogroup `Color <hex>` updates `data-selected` + `--onb-accent`. ⚠️ Initial colour is **random** — pin it for snapshot tests |
| C3 | Fresh-path failure & inline retry | Make the local gateway fail to start (e.g. corrupt data dir perms); press Continue | Error renders in `role="alert"`; **retry = press Continue again**; error clears only on next attempt |
| C4 | Supervisor backoff dead end | Force repeated start failures, keep pressing Continue | Backoff message ("backing off after a failed start… retrying automatically"), then after loop-break: "…use Settings → Gateway → Restart" — but **Settings is unreachable pre-onboarding**. Confirm the trap; candidate UX fix |
| C5 | No-vaults error | Point `CENTRAID_DATA_DIR` at an A3-state (erased-inhabited) dir; choose fresh | No auto-founding; `loadLocalVaults` yields zero vaults → "The gateway on this Mac has no spaces yet — restart Centraid and try again." Verify restart doesn't silently re-found |
| C6 | Vault rename fails non-fatally | Make `updateVault` fail (e.g. kill gateway right after commit) | Onboarding still completes; vault remains named "Personal"; only a console line `[first-run] renaming the Personal vault failed` — no toast. Decide if silent is acceptable |
| C7 | Service step gating | Complete fresh path on a build where `installGatewayService` is exposed vs not | Step appears only for local gateway + capability present; default **off**; decline writes `offerGatewayService:false` (un-awaited — see bug list) and finishes |
| C8 | Service install failure | Accept the service install with the CLI missing/broken | Error surfaced from stdout/stderr (`Service install failed` fallback); user can decline and still finish onboarding |
| C9 | Keychain prompt timing (macOS) | Watch for the Keychain prompt across the flow | Nothing before the fresh-path Continue (that's the whole point of the latch); prompt fires during local gateway start (first `writeSecrets`). Note: unpackaged builds always show the keychain note; packaged never do |
| C10 | ⚠️ Reinstall over existing data adopts — and renames the wrong vault | Keep an inhabited gateway data dir; wipe userData only; run the fresh path | Gateway adopts existing vaults (never-inhabited guard); `connectFreshLocalGateway` finds the owner vault by its `personal` marker, so a renamed Personal vault is still resolved and the rename lands on the right vault. Only a data dir founded BEFORE the marker (or one whose personal vault was erased) still falls back to `vaults[0]` = **Shared**, which is entered but never renamed (`ownerVault:false`) |
| C11 | Back from identity | On the fresh path press Back | Returns to the chooser (`first-run-choice`); no state committed; latch still down |

## D. Desktop — first run, ticket path (ConnectFlow)

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| D1 | **[auto]** Ticket path CTA gating | Chooser → ticket → identity → connect | ConnectFlow lands on `details` directly (no method grid); Continue disabled until non-empty ticket; local gateway **never starts** (`gatewayUrl` stays `""` throughout) |
| D2 | Ticket decode is local | Paste garbage / an expired ticket on the test step | Pure local decode, no dial: "That pairing code is not valid." / "This pairing code has expired." Ladder shows a single decode stage |
| D3 | Friendly commit errors | Force each failure at commit: burned ticket, expired, malformed, gateway stopped, bad payload | `FRIENDLY_ERRORS` map verbatim: `invalid_ticket` "…double-check you copied the whole thing.", `ticket_expired` "…ask for a new one.", `invalid_input` "…looks malformed…", `unreachable` "…check that it's running.", `bad_response` "…sent back something unexpected." Unknown codes surface the raw server message |
| D4 | Error step Back/Retry | After a commit failure | Back → vault step, `commitError` cleared; Retry re-dispatches commit; banner is `role="alert"` |
| D5 | Locked vault row | Reach the vault step with a valid ticket | Row is locked to the ticket's vault with copy "Fixed by the pairing ticket…"; commit button reads **"Enter Centraid"** (onboarding context) |
| D6 | "Start over" mid-connect loses input | Enter ticket + device name + remember, then Start over (→ identity), then re-enter connect | ConnectFlow unmounted → ticket/label/remember/report all reset. Acceptable but verify no orphaned side effects when nothing was committed |
| D7 | ⚠️ Back-out after successful redeem | Complete commit (`done` not yet finished), then quit or Start over before `finish()` | The enrollment, active-gateway flip, and iroh key **already happened** with `onboardingCompletedAt` unset → relaunch shows the chooser again with a live remote gateway registered. Verify what the chooser does with pre-existing connections; candidate bug (no rollback) |
| D8 | Remember-device default | Complete the ticket path without touching the checkbox | Default is **false** on desktop; profile row in `connections.json` has `rememberDevice:false`; verify what that means for offline replica behaviour post-onboarding |
| D9 | Device-name label | Set a device name during connect; then mint surfaces on the gateway | Label propagates to the gateway's device list (`connections.json` label + enrollment label) |
| D10 | ⚠️ Empty vault list dead end | Craft a gateway-method report with no `ticket`/`vaults` (e.g. connectivity fallback report) and advance | Vault step renders an empty list, no create option, no hint — while Continue stays enabled. Confirm and file (known suspect, `connectFlow-core.ts:334`) |
| D11 | Ladder cosmetics on ticket flow | Kill the bridge / make the test throw on a ticket flow | Synthesized failure reports use a `reach` stage ("Reach gateway") even though a ticket never dials — cosmetic confusion, note it |

## E. Desktop — state on disk, settings, keychain

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| E1 | Corrupt settings re-triggers onboarding | Truncate/garbage `centraid-settings.json`; relaunch | `readPersisted` swallows the parse error, returns defaults → **returning user silently dropped into first-run**. Their gateway data is intact (fresh path adopts, see C10). Decide if a repair/backup path is needed |
| E2 | Unknown/wrong-typed settings fields dropped | Hand-write pre-#603 founding-era fields into settings; relaunch | `narrow()` drops them silently; no migration layer (v0 policy); no crash |
| E3 | Corrupt connections.json | Write a non-array; relaunch | `GatewayError("invalid_input")` → startup `dialog.showErrorBox`. Verify the app doesn't half-launch |
| E4 | Atomicity | Kill the app mid-onboarding-save repeatedly | tmp+rename means settings are never partially written; either pre- or post-state on relaunch |
| E5 | Linux safeStorage fallback | Run on Linux without libsecret | 0600 `CENTRAID-DEVICE-SECRETS-V1` file fallback; auto-adopts into safeStorage when libsecret returns; encrypted-file + no libsecret → hard error. macOS/Windows with unavailable safeStorage → "OS keychain is unavailable; unlock the platform keychain before pairing." |
| E6 | Secrets survive settings wipe | Delete settings only; re-onboard fresh | `connection-secrets.bin` still has old iroh keys/tokens; verify re-onboarding reuses or cleanly replaces them (no duplicate enrollments on the same EndpointId) |

## F. Desktop — post-onboarding: multi-gateway, mint surface, lifecycle

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| F1 | Returning user | Relaunch after C1 | Boot short-circuits to the app; local gateway starts eagerly; no chooser |
| F2 | Quit mid-onboarding | Quit at chooser / identity / connect; relaunch | Nothing about the in-progress step persists → restarts at the chooser; no gateway spawn or keychain prompt occurred (unless D7 committed side effects). On Windows/Linux closing the window quits; on macOS the window closes, app stays, `activate` recreates → **onboarding restarts from the chooser** |
| F3 | Down-alert suppressed during first run | Sit on the chooser with the monitor running | No alert while `onboardingCompletedAt` undefined; a _failed settings read_ still alerts |
| F4 | ⚠️ Tray state after deferred start | Complete C1, inspect the tray menu | `setTrayGatewayRunning` is called only at boot (latch down → "stopped") and never again → tray likely reads **"Gateway: stopped"** for the whole session after onboarding. Confirm and file |
| F5 | Add a second gateway | Sidebar switcher → "Add vault…" → ConnectFlowModal ("Add vault") with a ticket from gateway B | Methods forced to `['gateway']`; on done, toast `Connected · <label>`, active gateway+vault already flipped; both rows in `connections.json` |
| F6 | Switch gateways | Toggle between local and remote | Non-active embedded gateways shut down; iroh dialers closed except active; per-gateway active vault restored (`activeVaultByGateway`). Switching away from a **detached** local gateway leaves the daemon running (by design) |
| F7 | Remove a gateway | Gateway → Components → **Connections** → Remove the remote; confirm `local` offers no Remove | Host-framed surface (the only one, #665): status rail, transport, vault names, Test connection / Rename / Remove. Remote removal falls back active to `local` (also lifts the latch) and drops its iroh key; `local` → no Remove button at all (`local_not_removable`) |
| F7b | Disconnect a vault (vault-worded path) | Settings → **Vault** on a vault served by a remote connection → "On this device" → Disconnect | Section absent when the active vault is on `local`. Confirm names EVERY sibling vault on the same connection ("… shares its connection with \"Family\" — disconnecting removes both from this device…") and never says "gateway"; on confirm the Settings dialog closes, the host falls back to `local`, and `onGatewayChanged` bounces the shell Home |
| F8 | Re-pair same gateway dedupes | Redeem a second ticket for an already-connected EndpointId | `findReusableProfile` reuses the profile — no duplicate connection; relayHint/rememberDevice refreshed |
| F9 | Mint surface (Household → Devices) | Sidebar → Household → DevicesCard → `pair-panel` | TTL presets 15 min/1 h/24 h; targets self/existing/new member; validations "Give the new person a name." / "Choose at least one space this device may reach."; QR is renderer-generated SVG (`alt="One-time Centraid pairing QR code"`) — this is what mobile scans; clipboard failure copy present |
| F10 | Embedded vs detached quit behaviour | Quit the app in each mode | Embedded: gateway closed with WAL checkpoint on quit. Detached: daemon survives quit (deliberate); relaunch re-adopts via `decideControl` (`own`) |
| F11 | Detached adoption refusals | Start the app while a foreign/hung daemon holds the data dir | `foreign` → "a live gateway holds this data directory, but this desktop has no matching device credential…"; probe-failed → "gateway.db is locked but the daemon is not answering — refusing to start a second writer". Both must surface legibly in onboarding/startup |
| F12 | Service mode has no uninstall | Install the OS service (C7), then look for removal in the UI | **No uninstall path exists in the desktop UI** — only the CLI. Candidate gap |
| F13 | Second instance during onboarding | Launch a second app instance mid-onboarding | Loser quits immediately (single-instance lock); first window focused; no state corruption |
| F14 | Deep link mid-onboarding | Open a `centraid://` OAuth-finish link while on the chooser | Window focused, link delivered to a renderer showing FirstRunGate — verify nothing crashes and the link isn't lost/misapplied |
| F15 | Auto-update overlap | (Packaged) update arrives mid-onboarding | Update pill lives in the sidebar (not mounted during onboarding); a relaunch-to-update mid-flow drops step state → behaves like F2. Verify no forced relaunch fires |
| F16 | Platform copy | Run the chooser on Windows/Linux | "Start fresh on this Mac" / "This Mac" / `displayLabel: "This Mac"` are hardcoded — wrong platform copy. Confirm and file |

## DM. Ticket minting & authorization (gateway-side)

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| DM1 | Mint from the desktop panel | See F9 | Ticket decodes with `vaultName`/`exp`; QR renders |
| DM2 | Self-pair role clamp | As a `write` member, mint a self ticket requesting `admin` | Clamped or `role_above_own` — self-pair cannot exceed roles held |
| DM3 | Invite requires admin everywhere | As admin of A only, mint a new-member ticket granting A+B | `403 not_admin` |
| DM4 | New-member label handling | `--new-member "Priya"` with grants; and one unnamed | Member row created **at mint time**; unnamed default `New member (<vaultName>)`; no phantom members |
| DM5 | Mint validation errors | Bad bodies: no addressable vault, bad role, bad grants, no iroh endpoint | `vault_required` / `invalid_role` / `invalid_grants` / `409 no_iroh_endpoint` |
| DM6 | Unbounded TTL (known gap) | `ttlMinutes: 525600` | Accepted — only `> 0` is checked. Decide if intended; candidate hardening issue |

## EH. Household / second member

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| EH1 | Second member joins (browser) | Admin mints `--new-member --grant Shared:write`; second fresh profile onboards | Enrolled with `write` on Shared only; cannot see Personal; roster shows both members |
| EH2 | Existing-member second device | Mint `--member <id>`; onboard a new profile | Binds to the **existing** member (no new member row); inherits roles |
| EH3 | Member visibility scoping | As the EH1 member, list members/devices | Sees only those sharing a vault; cannot PATCH/DELETE the admin |

## FR. Revocation & recovery

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| FR1 | Self-unpair from web | Remove the gateway in the web client | `purgeIrohDeviceState()` + tunnel caches cleared; revisit → ticket onboarding |
| FR2 | Admin revokes a peer | `DELETE /devices/:enrollmentId` for EH1's device | Allowed (admin in that vault); planes severed live; the revoked client's next dial fails |
| FR3 | Revoked device UX (known gap) | After FR2, reload the revoked client | ⚠️ No client-side revocation detection on **any** surface — expect a dial failure surfaced as `unreachable`/offline, not a "you were removed" state or auto-purge. Record actual behaviour; candidate UX issue |
| FR4 | Last-admin-device guard | Revoke the sole admin's only device | `last_admin_confirmation_required` — typed confirmation demanded |
| FR5 | Restore-after-erase | Run `docs/recovery/vault-erase.md` on an A3 gateway, reconnect a previously-enrolled device | Vaults mount; existing enrollments still admit (enrollment lives in `gateway.db`, not the vault) |

---

## G. Mobile — first run & pairing (primary driver)

Reset with `xcrun simctl erase` unless a scenario says otherwise.

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| G1 | **[auto-ish]** Happy path, paste ticket | Erased sim → launch dev build → assert `Connect your gateway.` → device name defaults to `iPhone` → paste a fresh ticket → `Continue with pasted code` → name + colour → `Enter Centraid` | Button shows `Connecting…` during pair; profile step follows pairing; done heading personalises (`You're all set, <first name>.`); lands on Home with `YOUR APPS`. Gateway shows one new enrollment |
| G2 | **⚠️ Keychain survives app delete** (highest-value) | Complete G1 → delete the app (or Maestro `clearState`) → reinstall → launch | **Suspected bug**: `phoneLink.secretKey` / `phoneLink.ticket` are keychain items and survive. `hydrateVaultLinks()` finds an empty registry; legacy-slot synthesis has been removed, so the expected-correct behaviour is a clean connect step. Verify first; file if confirmed |
| G3 | Expired ticket | Mint `--ttl-minutes 1`, wait, paste | Client-side pre-check (gw-pair only): `This pairing ticket has expired — mint a new one on the gateway.` No dial |
| G4 | Burned ticket | Redeem on the sim, then paste the same ticket again after erase | `pair_failed` with the gateway's refusal (`Pairing was refused by the gateway.` fallback) |
| G5 | Garbage payload | Paste random text | `That is not a Centraid pairing code. Scan the desktop QR, or paste a ticket from \`centraid-gateway pair\`.`; `scannedRef` resets so retry works |
| G6 | Ticket missing `vaultName` | Craft a valid gw-pair token with `vaultName` removed | Rejected at parse (parser requires `vaultName` to be a string) → `invalid_qr` copy, not a dial failure |
| G7 | Stale desktop `centraid-pair` payload | Paste an old desktop-shape payload | Accepted by the parser (no expiry pre-check on this shape — gw-pair only) → dials → fails server-side with `pair_failed`. Note the asymmetry |
| G8 | Empty submit gives no feedback | Tap `Continue with pasted code` with an empty field | **Current behaviour**: `submit()` returns silently — no error, no spinner. Record as a UX gap |
| G9 | Gateway down during pair | Stop the gateway; paste a valid ticket | `Could not reach your gateway: …` (`tunnel_failed`); no timeout is configured anywhere in the pairing path, so note how long it hangs — candidate issue |
| G10 | No back navigation | On profile or done, try swipe-back and (Android) hardware back | **No back handling exists** anywhere in the flow — no `NavigationContainer` is mounted. Confirm the user cannot get stuck or crash |
| G11 | Profile validation | Advance from profile with an empty/whitespace name | `Enter a name so the people you share with know who you are.` — the only validation in the flow |
| G12 | Colour selection | Pick each swatch via a11y `Colour <hex>` | `accessibilityState.selected` moves; default is `#128A78` (BRAND_TEAL); choice persists to `centraid.v1.profile.color` |
| G13 | Kill app mid-flow | Force-quit after pairing but before saving the profile | Relaunch: `profile.onboarded` is still false (written only at profile save) → onboarding restarts at **connect**, but a Space already exists → pasting a second ticket creates a duplicate/second enrollment. Verify and record |
| G14 | Expo Go dead end | Launch under Expo Go | `isTunnelAvailable()` false → both `Continue with pasted code` and `Scan QR instead` are hidden; the note says "You can pair later from Settings" but Settings is unreachable. Confirm the dead end; candidate copy/flow fix |

## H. Mobile — post-pair bootstrap & replica

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| H1 | Pairing does not block on sync | Time from `Continue with pasted code` to the profile step | Advances as soon as `pair()` resolves; nothing awaits the replica |
| H2 | First Home render | Land on Home after G1 | `loading` → `ready`; all eight tiles render, uninstalled ones dimmed and routed to pair; `ReplicaStatusBar` appears **only** inside Photos/Docs, not Home |
| H3 | Replica identity probe | Watch the first bootstrap after pairing | `vaultId` starts `""`; probe fills it via `fetchReplicaBootstrapPage`. ⚠️ `ReplicaProvider.tsx:141` sets `gatewayId` from the **desktop display name**, contradicting the "keys on EndpointId" contract in `spaces.ts` |
| H4 | Two gateways with the same name | Pair gateway A and gateway B, both named `Gateway` | Exposes the H3 defect — replica DB namespace collision. Expect divergence/data mixing; high-value regression test |
| H5 | Old gateway rejected by compat wall | Pair against a gateway without `multiVaultReplica` + `crossVaultPlacements` | Red `ReplicaErrorBanner`: `Update Centraid on the desktop, then reconnect. This mobile version requires multi-vault offline sync and cross-vault placements.` |
| H6 | Compat unknown while offline | Pair, then go offline before the capability probe caches `"supported"` | `Reconnect to the desktop once to verify it supports this mobile offline version.` |
| H7 | Banner suppressed during onboarding | Force a replica error while still on the connect step | `ReplicaErrorBanner` is suppressed while `!onboarded` — confirm no red banner leaks into onboarding |
| H8 | Bootstrap progress | Watch a vault with lots of history | Phases `first-page → backfill → complete`; line reads `<label>: recent items ready; older history syncing` |
| H9 | Scope cap | Pair a gateway with more than four vaults | At most `MAX_MOUNTED_NATIVE_SCOPES` (4) mount, active vault first |
| H10 | No notification prompt during onboarding | Complete G1 on an erased sim | Push wake registers a token **only if** notification permission was already granted → no prompt during first run |

## I. Mobile — returning, offline, revoked

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| I1 | Warm cold start | Relaunch after G1 | Gate restores from `profile.onboarded`; tunnel starts; `/info` → `/scopes` → replica pulls + SSE; Home shows apps. No re-pairing |
| I2 | **[#628]** Offline with a complete vault | Airplane-mode / stop the gateway, relaunch | `resolveIdentity` returns the cached base with `online: false` — the app opens the local replica **read-only** rather than erroring; Home shows `Desktop is offline`; status bar `Offline on this phone` |
| I3 | ⚠️ Offline with an incomplete vault | Pair, kill before the replica probe runs, then go offline and relaunch | `vaultId === ""` → probe path → no base → throws `REPLICA_UNPAIRED_MESSAGE`, which the banner **suppresses** → **silent no-data state**. Confirm; candidate bug |
| I4 | Gateway asleep vs device offline | Toggle network vs stop the gateway | Distinct states: `device-offline` vs `gateway-asleep`; `Wake help` alert offers `Open Centraid on your paired desktop and keep it online, then try again.` |
| I5 | Recovery without re-pair | Bring the gateway back after I2 | Reconnects and syncs (`Syncing recent changes…` → `Updated <relative>`) with no ticket |
| I6 | Scoped revocation | Revoke one vault's access server-side | `onScopeRevoked` purges the session, clears the pinned thumbnail pack, drops cached scope + freshness |
| I7 | Full enrollment revoked (known gap) | `DELETE /devices/:enrollmentId` for the phone, then relaunch | No device-wide revocation detection → tunnel dial fails → proxy 502 → `gateway-asleep` / `Desktop is offline`. Indistinguishable from an offline gateway. Same gap as **FR3** |
| I8 | Background sync registration | Background the app after onboarding | BGTaskScheduler/WorkManager registered, `minimumInterval: 15`; no crash on an erased sim |

## J. Mobile — vaults, re-pair, unpair

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| J1 | Second gateway as a vault | Settings → `Desktop link` → `Pair another` → paste a ticket from gateway B | Both appear in the switcher (Home avatar → `Open vault menu` → `Switch vault`); switching stops the tunnel only when `gatewayId` differs |
| J2 | Second vault, same gateway | Switcher → `ADD A VAULT` | `addActiveGatewayVault()` reuses the gateway identity + endpoint hint; tunnel is **not** restarted; Space id is minted, not content-derived |
| J3 | Vault upsert identity | Re-pair the same `(gatewayId, vaultId)` | Upserts in place — no duplicate row; the minted vault-registry id and its ticket key are preserved |
| J4 | Settings pairing cannot name the device | Pair via Settings rather than onboarding | Uses `defaultDeviceName()` only — no device-name field. Note the inconsistency with onboarding |
| J5 | Forget a vault does not purge data | Switcher → remove → confirm `Remove` in the `Remove from this phone?` alert | Row + `spaces.ticket.<id>` deleted, but the replica SQLite, thumbnail packs, intent outbox, and freshness cache **remain**. Verify leftover bytes in `PhoneStorage`; candidate bug |
| J6 | Unpair keeps the device key | Settings → `Unpair`, then re-pair | `phoneLink.secretKey` is deliberately kept → same EndpointId presented on re-pair. Confirm the gateway reuses/replaces rather than accumulating |
| J7 | Dangling active id repair | Corrupt `vaults.activeId` to a removed id; relaunch | `hydrateVaultLinks()` repairs to `registry[0]` and re-projects the active slot |
| J8 | Tunnel status copy | Watch Settings while the gateway stops/starts | `Checking…` → `Connected (port N)` → `Connecting…` → `Error: <err>` → `Not connected` |

## K. Mobile — permissions & platform parity (iOS + Android)

Every mobile change ships both platforms; run K1–K7 on **both** before calling a scenario done.

| ID | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| K1 | Camera prompt timing | Tap `Scan QR instead` on a fresh install | OS prompt fires only on tap (not at launch); string is `Centraid uses the camera to scan the pairing QR code shown on your desktop.` |
| K2 | Camera denied in onboarding | Deny, then tap `Scan QR instead` again | **Current behaviour**: silently falls back to the plain form — no denial message, no Settings deep link; second tap is a no-op once `canAskAgain` is false. Settings' scanner _does_ have proper denial copy. Record the inconsistency |
| K3 | Simulator has no camera | Attempt the QR path on the sim | Cannot scan — confirms paste is the only sim-testable route; make sure the fallback is discoverable |
| K4 | Android device-name default | Fresh Android run | Defaults to `Android phone` (vs `iPhone`) |
| K5 | **Android copy bug** | Open the vault switcher and the remove alert on Android | `ON THIS IPHONE` and `"…will be removed from this iPhone."` are hardcoded on both platforms. Confirm and fix |
| K6 | Android debug bundle id | Install a debug build | `dev.centraid.mobile.debug` — automation must resolve per platform |
| K7 | Secure storage parity | Complete G2's reinstall test on Android | Android uses EncryptedSharedPreferences/Keystore; expect the keychain-survival asymmetry to be **iOS-only**. Verify — it changes what "fresh install" means per platform |
| K8 | No deep-link pairing | Open `centraid://` and `dev.centraid.mobile://` URLs with a pairing payload | Schemes are registered for share-intent / dev client only; **nothing consumes a pairing URL**. Confirm no half-path exists |

## L. Cross-surface parity

| ID | Scenario | Expected |
| --- | --- | --- |
| L1 | Profile step ordering | Desktop/web collect identity **before** connect; mobile collects it **after** pairing. Decide whether this is intended; it affects what a failed pair leaves behind |
| L2 | Same ticket, three surfaces | One ticket redeems on exactly one surface — the other two get `invalid_ticket` |
| L3 | One member, three devices | Mint `--member <id>` tickets for web, desktop, and phone; all bind to one member and appear in one roster group |
| L4 | Revocation UX parity | All three surfaces degrade to a generic offline/unreachable state on revocation (FR3/I7) — none says "you were removed" |
| L5 | Role enforcement parity | A `read` ticket produces Viewer affordances on every surface |
| L6 | Desktop QR → mobile scan (physical device only) | The Household pair-panel QR (renderer-generated SVG) scans and pairs a real phone; sim cannot test this — schedule a device pass |

---

## Current test-asset notes

1. Swift wire-conformance tests in `modules/centraid-tunnel/ios/Tests` are not wired into CI; the Kotlin suite is.
2. Desktop E2E documentation reports 55 tests. Onboarding-save and settings-fetch fault injection remain documented but deliberately unautomated because the contextBridge is frozen.
3. `shouldOfferServiceInstall` and `DEFAULT_OFFER_GATEWAY_SERVICE` are retained for the detached-gateway service preference and covered by their focused unit tests; the onboarding UI separately gates the service step by capability.

## Known code gaps and suspected bugs to resolve while testing

1. No client-side handler for remote revocation on any surface (**FR3**, **I7**).
2. No upper bound on `ttlMinutes` (**DM6**).
3. No timeout or retry anywhere in the mobile pairing path (**G9**).
4. ~~Desktop fresh path falls back to `vaults[0]` when no "Personal" vault exists → renames **Shared** on reinstall-over-data (**C10**).~~ FIXED: the owner vault carries a durable `personal` marker; pre-marker data dirs still fall back to Shared but are never renamed.
5. Desktop tray never refreshes after the deferred local gateway starts — stuck on "Gateway: stopped" (**F4**).
6. Desktop back-out after a successful ticket redeem leaves committed side effects with onboarding incomplete — no rollback (**D7**).
7. Desktop ConnectFlow vault step can render an empty, actionless list with Continue enabled (**D10**).
8. Desktop corrupt settings silently reset → returning user re-onboards (**E1**).
9. Desktop `declineService` saves settings un-awaited — a failed save is invisible (**C7**).
10. Chooser copy hardcodes "Start fresh on this Mac" on all platforms (**F16**).
11. Mobile `ReplicaProvider` rewrites the vault entry's `gatewayId` to the desktop display name (**H3/H4**).
