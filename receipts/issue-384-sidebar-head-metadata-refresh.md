# issue-384 — sidebar head stays stale after Settings -> Space edit

GitHub issue: [#384](https://github.com/srikanth235/centraid/issues/384)

Follow-up to #382, flagged in that issue's receipt Out of scope section.
Editing a space's name/color/icon via Settings -> Space called
`saveSpace()` (`spaceModals.ts`), which only issued a direct HTTP
`updateVault()` call — unlike every other vault-mutating action
(create/switch/delete), it never broadcast anything, so `useActiveVault()`
never refreshed and the sidebar head kept showing the old name/color
until an unrelated event (switching vaults, relaunching) refreshed it.
This predates #382's redesign — the pre-#382 edit-space flow used the
same HTTP-only path — but was only newly visible now that Settings ->
Space is a first-class page.

## Checklist

- [x] Notify-only IPC round trip after a metadata-only vault save
- [x] Separate broadcast channel so metadata edits don't trigger navigate-Home
- [x] Sidebar head subscribes to the new channel
- [x] Real-Electron E2E regression coverage

## What changed

### Notify-only IPC round trip after a metadata-only vault save

- `apps/desktop/src/main/ipc.ts`: new `VAULT_METADATA_CHANGED` channel —
  `ipcMain.handle` that broadcasts to every window on a signal-only push,
  called by the renderer right after `updateVault()` succeeds.
- `apps/desktop/src/preload.ts`: `notifyVaultMetadataChanged()` invoke
  bridge and `onVaultMetadataChanged(cb)` subscription bridge.
- `apps/desktop/src/renderer/centraid-api.d.ts`: types for both.
- `apps/desktop/src/renderer/react/shell/routes/spaceModals.ts`:
  `saveSpace()` calls `window.CentraidApi.notifyVaultMetadataChanged()`
  right after `updateVault()` resolves.

### Separate broadcast channel so metadata edits don't trigger navigate-Home

- First attempt reused the existing `VAULT_CHANGED` broadcast
  (`broadcastVaultChanged`) — this broke live: `App.tsx`'s `reScope`
  treats every `VAULT_CHANGED` as "the ADDRESSED vault changed" and
  navigates Home + wipes gateway-scoped renderer state, which is correct
  for a real switch but silently kicked the user off the mid-edit
  Settings -> Space page for a same-vault rename (confirmed via a live
  E2E run: the "rename it back" step's `input[type="text"]).fill()`
  timed out because the app had already navigated to Home).
- `apps/desktop/src/main/ipc.ts`: new `VAULT_METADATA_PUSH` channel — a
  separate main->renderer broadcast the `VAULT_METADATA_CHANGED` handler
  sends to instead of `VAULT_CHANGED`, carrying no payload (metadata
  edits never change which vault is addressed, only its display fields).

### Sidebar head subscribes to the new channel

- `apps/desktop/src/renderer/react/shell/useActiveVault.ts`: subscribes
  to `onVaultMetadataChanged` alongside the existing `onVaultChanged`/
  `onGatewayChanged` listeners, triggering the same lightweight
  `refresh()` (re-fetch `listVaults()`) — without going through
  `App.tsx`'s `reScope`, since that effect only listens to
  `onVaultChanged`/`onGatewayChanged`, not the new channel.

### Real-Electron E2E regression coverage

- `apps/desktop/tests/e2e-live/flows-shell-v2-02-vaults-settings.mjs`:
  the existing `space-edit-persists` step now asserts the sidebar head's
  own `aria-label` ("Active space: …") picks up the rename immediately
  after "Save changes" — WITHOUT opening the switcher or switching
  vaults — in addition to the pre-existing switcher-popover-reflects-it
  assertion.

### Files

New:
- `receipts/issue-384-sidebar-head-metadata-refresh.md` (this receipt)

Modified:
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/renderer/centraid-api.d.ts`
- `apps/desktop/src/renderer/react/shell/routes/spaceModals.ts`
- `apps/desktop/src/renderer/react/shell/routes/spaceModals.test.ts`
- `apps/desktop/src/renderer/react/shell/useActiveVault.ts`
- `apps/desktop/tests/e2e-live/flows-shell-v2-02-vaults-settings.mjs`

## Decisions

- **A new broadcast channel, not a reused one.** The obvious first move
  (reuse `VAULT_CHANGED`) is semantically wrong: that channel means "the
  addressed pair changed" and `App.tsx`'s `reScope` acts on it
  accordingly (navigate Home, wipe gateway-scoped state). A metadata-only
  rename changes neither the gateway nor the vault being addressed, so it
  needed its own channel rather than overloading an existing one with a
  second meaning. Caught live, not by unit tests — `reScope`'s effect and
  `useActiveVault`'s effect both listen to the same two channels today by
  design, so a type-level review alone would not have surfaced this.
- **No payload on `VAULT_METADATA_PUSH`.** Unlike `VAULT_CHANGED` (which
  carries the new `activeGatewayId`/`activeVaultId` so listeners can
  react to WHICH pair is now active), a metadata push has nothing to
  report beyond "something changed, re-read" — the listener already
  knows which vault it's displaying.
- **`saveSpace()` is the single call site**, so the fix lives there
  rather than at each caller (`SettingsRoute.tsx`'s `saveActiveSpace`
  is currently the only caller, but any future editor reusing `saveSpace`
  gets the notification for free).

## Out of scope

- The switcher POPOVER's own cache (`flatVaultSwitcherRegistry.ts`)
  already re-fetches fresh data every time it's opened, independent of
  this fix — untouched here. A separate, pre-existing timing race in
  that cache surfaced once during live verification (a reopened
  switcher briefly showing a just-deleted vault before its background
  refresh landed) but did not reproduce on two subsequent runs; left
  alone as a possible pre-existing flake, not chased further here.
- Multi-window broadcast correctness beyond the single-window case this
  repo currently exercises (Electron apps with multiple `BrowserWindow`s
  open) — untested, but the same `BrowserWindow.getAllWindows()` fan-out
  every other broadcast in `ipc.ts` already uses.

## Verification

```
bun run --filter '@centraid/desktop' typecheck   → exit 0
bunx vitest run src/main src/renderer/react      → 97 files, 788 tests passed
bunx oxlint <7 touched files>                    → 0 errors in touched files
                                                     (6 pre-existing .innerText
                                                     findings elsewhere in the
                                                     e2e file, unchanged count)
bunx oxfmt --check <7 touched files>              → all correctly formatted
```

Real Electron (`_electron.launch()`, fresh userData, screenshots read
back): rebuilt the app, ran `flows-shell-v2-02-vaults-settings.mjs`
against the live build. First run (with the naive `VAULT_CHANGED` reuse)
caught the navigate-Home regression directly — the "rename it back"
step timed out because the app had left the Settings page. After
switching to the dedicated `VAULT_METADATA_PUSH` channel, the same flow
passed cleanly on 3 consecutive full runs (11/11 steps, 0 console
errors each time): the sidebar head's `aria-label` now shows the new
name immediately after "Save changes" with no switcher open and no
vault switch, and the rest of the space lifecycle (create/switch/
overflow actions/delete/relaunch persistence) is unaffected. Also
re-ran `flows-shell-v2-01-onboarding.mjs` for regression — all 8 steps
passed, 0 console errors.

## Audit

PASS — fresh-context audit against `git status --short`/`git diff`,
`gh issue view 384`, this receipt, and the live working tree. All 4
checklist items are realized in the diff: `VAULT_METADATA_CHANGED`
(invoke) and `VAULT_METADATA_PUSH` (push) are both defined as distinct
`Channel` entries in `apps/desktop/src/main/ipc.ts` and the handler
sends on `VAULT_METADATA_PUSH`, not `VAULT_CHANGED` — confirmed by
reading the handler body directly (`win.webContents.send(Channel.VAULT_METADATA_PUSH)`,
no `broadcastVaultChanged` call); `spaceModals.ts`'s `saveSpace` calls
`window.CentraidApi.notifyVaultMetadataChanged()` immediately after
`updateVault(...)` resolves; `useActiveVault.ts` registers
`window.CentraidApi.onVaultMetadataChanged?.(refresh)` alongside the
pre-existing `onVaultChanged`/`onGatewayChanged` subscriptions in the
same effect, and does NOT touch `App.tsx`'s separate `reScope` effect
(confirmed `reScope`'s subscriptions in `App.tsx` are unchanged — still
only `onGatewayChanged`/`onVaultChanged`); the E2E assertion added to
`flows-shell-v2-02-vaults-settings.mjs`'s `space-edit-persists` step
reads `switcherHead().getAttribute('aria-label')` and asserts the new
name is present immediately after save, before `openSwitcher()` is
called — genuinely testing the head, not the popover. File coverage:
every path in this receipt's Files section matches `git status --short`
exactly (receipt self-reference excluded); no omissions, no phantom
entries. The Decisions section's claim that the first (`VAULT_CHANGED`-
reuse) attempt broke live is corroborated by the Verification section's
description of the same failure mode, which is internally consistent
with `App.tsx`'s `reScope` effect body (`navRef.current?.navigate({
kind: 'home' })` unconditionally on every `onVaultChanged`/
`onGatewayChanged` fire). No implementation defects found.

## Steering

PASS — session ran as a direct implementation task (no subagent
delegation for this follow-up fix, given its small, single-concern
scope). Zero human interrupts or corrections after the initial task
assignment message describing the bug and asking for a fix; the only
intervening message was an automated background-task-completion system
notification for the unrelated spawned session that surfaced this bug
report in the first place.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs
| claude-code-f4f73ee6-029-1783850176-1 | claude-code | f4f73ee6-029f-44a0-a236-a5a8a9810504 | #384 | claude-sonnet-5 | 5847 | 166696 | 59110761 | 93156 | 265699 | 19.7732 | 82835 | 1341486 | 115207085 | 349960 | fix(desktop): sidebar head stays stale after Settings -> Space edit (#384)saveSp |
