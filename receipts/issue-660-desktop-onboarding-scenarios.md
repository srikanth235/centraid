# issue-660 — Desktop onboarding: real-gateway A–F scenario pass and the defects it found

GitHub issue: [#660](https://github.com/srikanth235/centraid/issues/660)

Desktop onboarding had never been exercised end-to-end against a **real**
gateway. The e2e suite runs a mock, so every crash, lock, and credential-desync
path was untested — and could not be tested, because an ad-hoc-signed dev build
re-prompts for the macOS login password on every restart. This change unblocks
unattended runs, executes the A–F matrix (32 scenarios) against a real daemon,
and fixes what it found.

## Checklist

- [x] Unattended desktop runs: dev-only device-secret hatch, hard-stopped by `app.isPackaged`
- [x] A–F scenario matrix executed against a real gateway
- [x] A returning user is offered "Start fresh on this Mac."
- [x] Every gateway CLI failure was reported as a held lock
- [x] Missing device credentials produced no window at all
- [x] The desktop never restarted its own dead daemon
- [x] A port conflict died silently
- [x] Dismissing the background-service tip retired the feature permanently
- [x] The startup error screen's "Try again" did not retry
- [x] First-run friction: raw error text, no way back from import, unbounded read, mixed vocabulary, no CTA cue

## What changed

### Unattended desktop runs: dev-only device-secret hatch, hard-stopped by `app.isPackaged`

`apps/desktop/src/main/gateway-secrets.ts` gains `insecureSecretsRequested()`:
`CENTRAID_INSECURE_DEVICE_SECRETS === "1" && !app.isPackaged`. It reuses the
existing Linux/no-libsecret plaintext path (`CENTRAID-DEVICE-SECRETS-V1`, 0600)
rather than adding a second on-disk format, so there is one fallback shape to
reason about. `app.isPackaged` is the hard stop — a shipped build ignores the
variable outright, so a real user's custody can never be downgraded by an
environment variable.

The adopt-back-into-custody branch in `readSecrets()` now asks
`shouldUseFileFallback()` rather than `safeStorage.isEncryptionAvailable()`.
That single expression covers all four cases (adopt when custody is available,
skip under the hatch, skip-and-warn on Linux without libsecret, throw on an
unavailable macOS keychain) and replaces a three-branch form whose `else` arm
called a predicate purely for its side effect.

The same file gains `hasGatewayWrappingKey()` — a read-only probe that never
mints — which the credential-gap detection in the next commit consumes.

`docs/dev-environment.md` documents the hatch: the ad-hoc-signing cause, the
`!app.isPackaged` guard, the requirement that each run own its `--user-data-dir`,
and the automatic switch back to OS custody once the keychain is usable again.

`apps/desktop/src/main/gateway-secrets.test.ts` mocks `app.isPackaged` and adds
one broad test covering three things at once, matching the file's existing
compound-test house style: the hatch writes the magic-prefixed 0600 file on a
Mac whose keychain is perfectly available; a second read does **not** rewrite
the store; and a packaged build ignores the variable.

### A–F scenario matrix executed against a real gateway

32 scenarios across six families. A (virgin install, 8), B (ticket/pairing, 5),
C (warm boot, 4) and F (service offer, 6) all passed. D (crash/lock, 6) produced
three failures and E (keystore desync, 3) produced one; all four are fixed below.

Two previously suspected defects were **disproved** and are recorded here so
they are not chased again:

- **Warm boot does start the gateway.** The suspicion was that
  `ensureLocalGatewayActive` is only reachable from the connect flow. In fact
  `apps/desktop/src/main.ts` → `loadSettings()` → `resolveEffective` starts it
  once `onboardingCompletedAt` is set; the connect-flow call is only the
  first-run deferral lift. Observed respawn in ~3s.
- **Quit → relaunch does not orphan the daemon.** Quit deliberately leaves it
  running (H1); relaunch adopts it via the persisted loopback token. No
  `'foreign'` error.

`apps/desktop/tests/e2e/onboarding-home.spec.ts` carries the onboarding-flow
assertions for the reshaped fresh path.

### A returning user is offered "Start fresh on this Mac."

The most serious finding. `packages/client/src/react/boot.tsx` read settings as
`getSettings().catch(() => ({}))`. An empty object has no `onboardingCompletedAt`,
so **any** failure to read settings rendered the first-run chooser — inviting a
person with a real, populated vault to start over. This is not hypothetical: it
reproduced in two independent scenarios (D4 and D5), because a gateway that
cannot be assessed is exactly a gateway whose settings cannot be read.

`boot.tsx` now distinguishes three states via a `SettingsRead` union: read
failed, read succeeded with no stamp (a genuine first run), read succeeded with
a stamp. Only the middle case may show the chooser. A failed read renders the
new `packages/client/src/react/screens/StartupErrorScreen.tsx` (with
`packages/client/src/react/screens/StartupErrorScreen.module.css`) — calm,
non-alarming, one **Try again** action, and nothing destructive. Its lead line
is "Your data is safe and exactly where you left it". The host's message is
quoted verbatim under "What Centraid reported", with the Electron IPC wrapper
stripped.

The screen deliberately uses the app's own themed surface rather than the
onboarding stage's forced-dark look: this person already has a theme and a
vault, so the moment should read as the app they know, not as a second welcome.
Tokens only — no hex or px duplicating a token.

`packages/client/src/react/boot.test.tsx` is new and covers all three branches
plus recovery through retry.

### Every gateway CLI failure was reported as a held lock

`apps/desktop/src/main/detached-gateway.ts` ran the `lock-status` CLI with
`spawnSync` and treated **any** non-JSON stdout as a fail-closed `{held:true}`.
Three unrelated situations collapsed into one wrong sentence — "gateway.db is
locked but the daemon is not answering — refusing to start a second writer" —
with no holder pid:

- a `KeyStoreError` from a missing or replaced wrapping key, where the lock is
  actually **free** and the real problem is device custody;
- a 5s `spawnSync` timeout because the CLI itself blocks on the stopped holder's
  SQLite lock;
- a genuinely held lock.

`apps/desktop/src/main/detached-gateway-core.ts` gains a `LockProbe` union with
a pure `classifyLockStatus`, a `lockViewFor` that keeps fail-closed as the
*safety* default (the bug was the misdiagnosis, never the refusal), and a
`describeLockRefusal` that emits four distinct messages. `stderrDetail` skips
Node's `ExperimentalWarning` noise so the `KeyStoreError` line survives.

`detached-gateway.ts` now preserves `spawnSync`'s `ETIMEDOUT` signal, which was
previously discarded and is the only way to see "the CLI blocked on the holder".
When the CLI cannot name the holder — exactly the blocked case — `lsof -t`
recovers the OS pid **without opening the database**. It is best-effort, never a
decision input, and degrades cleanly where `lsof` is absent.

`apps/desktop/src/main/detached-gateway-core.test.ts` covers the classifier.

### Missing device credentials produced no window at all

Two compounding faults. `apps/desktop/src/main.ts` called `loadSettings()` and,
on failure, `dialog.showErrorBox` **before** `createWindow` — a modal NSAlert
with nothing behind it, which blocked startup for 30s+ and made unattended
recovery impossible precisely when it was needed. The window is now created
first and startup failures are logged and surfaced in-window through the
renderer's own settings rejection, which is what `StartupErrorScreen` renders.
The `dialog` import is gone.

Separately, deleting `connection-secrets.bin` while the gateway data directory
remained caused a silent re-mint of a new wrapping key that could not open the
existing envelopes. `detached-gateway-core.ts` gains `deviceCustodyGap` and
`describeDeviceCustodyGap`; `detached-gateway.ts` checks the gap **before**
`getOrCreateGatewayWrappingKey`, so "this Mac holds no device credential for
this gateway" throws its own actionable message instead of decaying into a lock
refusal.

A bonus fix in `main.ts`: `void installAuthInjector()` reads settings, so it
rejected for the same reasons as the gateway boot, and the bare `void` filed a
startup diagnosis as an `unhandledRejection` in `crash.log`. It is now caught.

### The desktop never restarted its own dead daemon

Loss was detected correctly (a "Gateway down" banner in ~2s, not a spinner), but
`apps/desktop/src/main/local-gateway.ts` cached the handle and nothing ever
revived it — dead for the full 90s observed. `reviveLocalGatewayIfDead` restarts
owned, detached gateways **only when the pid is actually gone**; a wedged but
alive daemon still holds `gateway.db` and is left to the down alert.

`apps/desktop/src/main/gateway-supervisor-core.ts` gains `claimRevival`, a rate
limiter (3 per 10 minutes, ≥15s apart, window resets) so a crash-looping gateway
cannot spin. `apps/desktop/src/main/gateway-monitor.ts` calls it on a failed
local heartbeat. `apps/desktop/src/main/gateway-supervisor-core.test.ts` covers
the limiter.

`ensureLocalGateway`'s cached-handle fast path is deliberately left without a
liveness check, with a comment explaining why: it is read on every settings poll,
so a check there would restart a crash-looping daemon every few seconds with no
budget.

### A port conflict died silently

A leftover daemon on `127.0.0.1:17832` bound to a *different* data directory made
a fresh-directory launch die behind `stdio:'ignore'`, surfacing as an opaque 30s
"did not become ready". `detached-gateway.ts` probes port identity before
spawning and `detached-gateway-core.ts` gains `describePortConflict`, which names
the conflicting pid.

### Dismissing the background-service tip retired the feature permanently

`packages/client/src/react/screens/GatewayServiceTip.tsx` is the **only** caller
of `installGatewayService` in the entire client (verified by grep before and
after). Dismiss wrote `offerGatewayService: false`, which hid the tip forever —
so one click removed the capability with no way back.

The component now models `loading | unset | dismissed | installed` instead of a
binary decided flag that conflated "declined" with "installed". When dismissed
it renders a standing, low-key control that reaches the same install path:
Dismiss now dismisses the *promotion*, not the *feature*. The dismissal stays
genuinely sticky — the tip itself never returns.
`packages/client/src/react/screens/GatewayServiceTip.module.css` styles it
deliberately as not-a-card (no border, no elevation, no accent dot) so it cannot
read as a second tip.

Wiring this surfaced a latent bug: `busy` was never cleared on the success path.
That was invisible while every decision unmounted the component, but a control
that survives dismissal would have rendered permanently disabled and stuck on
"Installing…".

`packages/client/src/react/screens/GatewayScreen.tsx` names the consequence at
the moment of failure — while a local gateway is down, other devices cannot
reach the vault either — and its stale mount comment (which claimed the tip
"renders itself away once the user has decided") is corrected.
`packages/client/src/react/screens/GatewayServiceTip.test.tsx` is new.

### The startup error screen's "Try again" did not retry

Found by an independent verification pass on the fix above — a regression
introduced by this very change set, which is why it is recorded here rather than
quietly folded in. `StartupErrorScreen`'s primary CTA called `boot.tsx`'s
`start()`, which only re-reads settings. It never reset the gateway supervisor's
give-up state, so once the supervisor had stopped retrying the button did
nothing — verified by clearing the root cause completely (SIGKILL the lock
holder; restore `connection-secrets.bin`) and pressing it: still on the error
screen 90s later. The message it then surfaced told the user to use
**Settings → Gateway → Restart**, which is unreachable from a screen with no
sidebar and no navigation.

`apps/desktop/src/main/gateway-supervisor-core.ts` gains a pure
`claimManualRetry` with a `MANUAL_RETRY_FLOOR_MS` of 3s.
`apps/desktop/src/main/local-gateway.ts` gains `retryLocalGatewayStart`, which
clears the revival budget and delegates to the existing restart path (clearing
`supervisor` and `nextAttemptAt`) to run a real stop→start; its `loopBroken`
message no longer names Settings, because the screen quoting it cannot reach
Settings. `apps/desktop/src/main/ipc-core.ts` adds a `GATEWAY_START_RETRY`
channel and `apps/desktop/src/main/ipc.ts` its handler — the existing
`GATEWAY_RESTART` cannot serve this case because its first statement is
`loadSettings()`, which is precisely the call that is failing. It reads
persisted settings only and refuses remote gateways.
`apps/desktop/src/main/local-gateway.test.ts` is new and covers the retry
contract: that an explicit retry clears the give-up latch and re-attempts the
start, that the recovery path resolves once the cause is cleared, and that the
refusal message no longer names Settings.
`apps/desktop/src/main/preload-core.ts` exposes `retryGatewayStart` (added to
`apps/desktop/src/preload.ts` first; moved when the merge with `main` picked up
PR #661's extraction of the preload body into the Electron-free core, and
covered by that core's `apps/desktop/src/main/preload-core.test.ts`) and
`packages/client/src/centraid-api.d.ts` types it as optional, so a web host that
owns no local gateway is unaffected. `packages/client/src/react/boot.tsx` calls
it before re-running `start()`.

The retry-versus-hammering tradeoff is deliberate and commented: an explicit
press clears `loopBroken`, `nextAttemptAt`, and the `claimRevival` budget, and
has **no exhaustion**. Those budgets bound *automatic* attempts; a person
pressing the button is asserting information the supervisor cannot have (they
just killed the holder, they just restored the credential). Telling someone
"you're out of tries" on a screen whose only other exit is quitting the app is
how this bug happened. The single surviving bound is the 3s floor, which absorbs
double-clicks and a held Enter key; a refusal does not slide the floor forward,
so leaning on the button cannot push the next real attempt out of reach.

### First-run friction: raw error text, no way back from import, unbounded read, mixed vocabulary, no CTA cue

All in `packages/client/src/react/screens/OnboardingScreen.tsx` with
`packages/client/src/react/screens/OnboardingScreen.module.css`:

- A failed fresh dial showed the raw exception verbatim. It now leads with one
  plain sentence and folds the technical text into a collapsed "Technical
  detail"; `role="alert"` stays on the human-readable part. No error taxonomy
  was invented, because the message text cannot reliably distinguish causes.
  (Sabotage showed the pre-fix copy leaked *both* a jargon prefix and raw SQLite
  text: "Couldn't read this gateway's spaces: gateway.db is locked".)
- The connecting step said "Setting up your vault." while its failure headline
  said "Couldn't start your gateway." — two unintroduced terms for one moment.
  It now says **Centraid** throughout, and **spaces** for vaults, per
  `docs/glossary.md`.
- The import step had no way back: name and colour could not be revisited and
  the "I have data to import" choice could not be un-made. It now has a Back
  affordance that returns to identity with state intact.
- The import step read whole files into memory (`btoa` over a per-byte array),
  so a multi-GB export hung or killed the renderer with only "Import staging
  failed". A named `MAX_IMPORT_BYTES` guard now refuses oversized files
  **before** reading, naming the actual size and limit.
- The identity CTA silently disabled itself with no cue; a quiet hint now
  explains why, without turning an untouched field red.

`packages/client/src/react/screens/OnboardingScreen.test.tsx` covers the changed
behaviour.

The additions pushed `OnboardingScreen.tsx` to 704 lines, past the 625-line
`repo-hygiene` cap, so it was decomposed rather than waived — 704 → 426, by
extracting three cohesive siblings:
`packages/client/src/react/screens/OnboardingErrorNote.tsx` (the one failure
shape every step renders through),
`packages/client/src/react/screens/OnboardingIdentityStep.tsx` (the avatar and
identity form, plus the `AVATAR_PALETTE` and `initials()` that only ever fed it,
and the name-focus effect whose `step` guard becomes redundant at mount), and
`packages/client/src/react/screens/OnboardingImportStep.tsx` (the file picker,
`MAX_IMPORT_BYTES`, staging call, and Back affordance). `stagedCount`,
`pendingResult`, and the paired error setters stay in the parent, so the import
child never reaches the completion payload. This was a pure refactor: no copy,
markup, `data-testid`, or CSS changed, and `OnboardingScreen.test.tsx` passes
**unmodified** (identical SHA before and after).

## Decisions

- **The hatch reuses the existing plaintext fallback rather than adding a
  format.** One on-disk shape is easier to audit than two, and the Linux path
  already had the 0600 + magic-prefix discipline.
- **`app.isPackaged`, not the variable's absence, is the guard.** A shipped
  build must not be talked out of the keychain by an environment variable under
  any circumstances.
- **Fail-closed stays the default for lock probing.** The defect was reporting
  the wrong *cause*, not refusing to start a second writer. Refusal is correct.
- **`lsof -t`, not `fcntl(F_GETLK)`.** Node has no `F_GETLK` binding, and adding
  native code for a diagnostic-only pid is out of proportion. `lsof` is what the
  gateway CLI itself uses; the message degrades cleanly when it returns nothing.
- **`ensureLocalGateway`'s fast path keeps no liveness check.** Revival is driven
  by the monitor with an explicit budget instead; a check on the hot path would
  restart a crash-looping daemon on every settings read.
- **`StartupErrorScreen` uses the app's themed surface, not the onboarding
  stage's forced-dark look.** The person already has a theme and a vault.
- **No error taxonomy in onboarding copy.** One honest sentence plus the raw
  detail beats guessing a cause from message text.

## Out of scope

- **Streaming or chunked import.** The gateway's import route is a single JSON
  POST; supporting large files needs a contract change. Noted at the
  `MAX_IMPORT_BYTES` constant.
- **`packages/client/src/react/shell/routes/settingsAccountData.ts`** has the
  same whole-file-into-memory pattern and no size guard. The onboarding refusal
  copy is worded so it does not promise Settings handles large files better.
- **Mobile's unreachable-gateway copy** (`apps/mobile/src/lib/gateway.ts`) is the
  true moment-of-failure surface for "my phone can't reach my vault", and
  `packages/client/src/react/shell/routes/gatewayModals.ts` is its web
  equivalent. Both are the honest place to explain that a local gateway only
  runs while Centraid is open.
- **The `/centraid/_gateway/devices` 404 during first run.** The route mounts
  only when `devicePairing` is supplied, which the CLI daemon does and the
  desktop embed does not. The client already swallows it and returns `[]`, so
  this is console noise, not a user-visible fault.
- **`embedded-gateway-layout.test.ts` depends on port 17832 being free.** Found
  while running the matrix; it fails if any daemon is listening. Not fixed here.
- **The crash-loop OS notification** (`apps/desktop/src/main/gateway-monitor.ts`)
  still ends with "Use Settings → Gateway to restart it manually." It is usually
  seen while the shell is up and Settings *is* reachable, but it can fire while
  the startup error screen is showing, where the advice is equally unreachable.
  Left for a follow-up decision rather than reworded without live verification of
  the notification path.
- **One unexplained Electron exit**, in 1 of 5 launches into the SIGSTOPped-holder
  state; three dedicated stability iterations stayed alive with the error screen
  rendered. Not reproduced, not explained — recorded so it is not forgotten.
- **A transient HTTP 500** from the gateway during its own boot window, observed
  once mid-respawn; it self-heals, but refusing connections would be more honest
  than serving a 500.

## Verification

Full gate set on the integrated tree, from the worktree root:

```sh
bun run --cwd packages/client typecheck && bun run --cwd apps/desktop typecheck
bun run lint && bun run format:check && bun run lint:css && bun run lint:design-tokens
bun run knip
bun run --cwd packages/client test
bun run --cwd apps/desktop test
```

Results: typecheck clean both packages; `lint` exit 0; `format:check` "All
matched files use the correct format." across 3232 files; `lint:css` "no dead
classNames"; `lint:design-tokens` "403 grandfathered hex value(s), 28 literal
font stack(s), **zero regressions**"; `knip` exit 0; client **1509 passed
(195 files)**; desktop **267 passed (27 files)**.

Onboarding e2e against a rebuilt tree:

```sh
bun run build
cd apps/desktop && ../../node_modules/.bin/playwright test -c tests/e2e/playwright.config.ts onboarding-home
```

**10 passed (1.3m)** — including 1.1 (CTA gating), 1.2 (fresh path auto-founds
Shared + Personal and lands on home) and 1.4 (returning user boots straight to
home).

Every fix was **sabotage-verified**: the fix was reverted, the new test was
confirmed to fail, and the fix restored. A test that passes without its fix is
not evidence. Representative failures observed under sabotage:

- The first-run chooser defect, reproduced verbatim — with the old
  `catch(() => ({}))` restored, the test rendered
  `data-testid="first-run-choice"` containing **"Start fresh on this Mac"** on a
  machine with completed onboarding.
- Lock classification — `expected { kind: 'reported', held: true } to strictly
  equal { kind: 'custody-mismatch' }`, and `expected 'reported' to be
  'cli-failed'`.
- Refusal messages — `expected 'gateway.db is locked but the daemon i…' to
  contain 'device credentials'`, and `expected 1 to be 4`.
- Revival budget — `expected true to be false` for the interval, the cap, and
  the window reset.
- Import size guard — without it the 3 GB file reached `vaultImportStage`:
  `TypeError: Cannot read properties of undefined (reading 'total')`.
- Post-dismissal reachability — `expected null not to be null` at
  `expect(q("gateway-service-standing")).not.toBeNull()`.
- The device-secret hatch — reverting the adopt condition triggers
  `expected "writeFileSync" to not be called at all, but actually been called 1
  times`; dropping the `!app.isPackaged` guard makes a packaged build write the
  plaintext magic prefix.

Real-daemon before/after, run unattended with
`CENTRAID_INSECURE_DEVICE_SECRETS=1` and a fresh `--user-data-dir` per scenario:

- **D4** (holder SIGSTOPped) — before: "locked … refusing to start a second
  writer", no pid, plus the first-run chooser. After: "a process is holding
  gateway.db in … and is not responding (OS holder pid 55858) — reading the lock
  timed out against it too", rendered in-window with **Try again**.
- **D5** (wrong wrapping key, lock free) — after: "this device can no longer
  unlock the gateway key store … its device credentials are missing or were
  replaced … gateway.db itself is not locked".
- **E2** (`connection-secrets.bin` removed) — before: no window at all within
  30s. After: a window naming the missing device credential.
- **D1** (own daemon SIGTERMed) — before: dead for the full 90s. After:
  `gwPid=none` at ~5s → `gwPid=24654 probe={"ok":true,"status":200}` at ~10s.
- **Port conflict** — before: opaque 30s "did not become ready". After, at ~2s:
  "another process (pid 29963) is already listening on 127.0.0.1:17832 and it is
  not this desktop's gateway for …".

An **independent verification pass** then re-ran these against the final
integrated build and corroborated them outside the fixing agent's own claims:
the D4 pid in the message matched `ps -p` (state `T`, stopped) and `lsof` naming
it sole holder of `gateway.db`; D5's "gateway.db itself is not locked" was
confirmed by `lsof` showing no holders at all before launch; `crash.log` was
never created (against a 1486-byte pre-fix `unhandledRejection` file); and the
happy path and warm boot were unregressed (home in 1–5s, adopting the running
daemon). That pass is also what found the "Try again" regression above.

The retry fix, same scenario run against the pre-fix and fixed builds — delete
`connection-secrets.bin`, launch, press Try again with the cause still present,
restore the credential, press again:

- **Before:** "failed to start repeatedly and stopped retrying … use Settings →
  Gateway → Restart to try again"; after the second press, `recovered into the
  shell: false (after 90s)`, no daemon on 17832.
- **After:** "is backing off after a failed start; retrying automatically"; says
  'stopped retrying'? **false**; says 'Settings'? **false**; after the second
  press, `recovered into the shell: true (after 1s)`, sidebar present, daemon
  pid 76852, and `port 17832 after cleanup: FREE`.

## Audit

**PASS** — The receipt accurately describes the diff and all checklist items are realized.

(1) **What changed describes the diff**: PASS. The receipt enumerates 17 modified files and 6 new files; git diff HEAD shows exactly those changes. Spot-checked substance: `insecureSecretsRequested()` and `hasGatewayWrappingKey()` in gateway-secrets.ts; `SettingsRead` union and `readSettings()` in boot.tsx; new `StartupErrorScreen.tsx`; `classifyLockStatus()` and `LockProbe` union in detached-gateway-core.ts; `MAX_IMPORT_BYTES` guard and `ErrorNote` component in OnboardingScreen.tsx; `reviveLocalGatewayIfDead` and `claimRevival` rate limiter; four-message `describeLockRefusal`; `GatewayServiceTip` state machine; back affordance in onboarding. All verify against diffs.

(2) **Checklist items realized**: PASS. All 9 items have corresponding code changes. Keywords verified in diff: device-secrets hatch (`insecureSecretsRequested`), A–F matrix execution (detached-gateway.ts structure), returning-user fix (`SettingsRead` + `StartupErrorScreen`), lock classification (`classifyLockStatus` + `LockProbe`), custody-gap detection (`deviceCustodyGap` in detached-gateway-core.ts), daemon revival (`reviveLocalGatewayIfDead` + rate limiter), port-conflict detection (`describePortConflict`), service-tip state machine (`Decision` enum + `dismissed` case), onboarding UX (`MAX_IMPORT_BYTES` + back button).

(3) **Checklist mirrors issue**: PASS. Receipt's 9 checklist items match GitHub issue #660's 7 defects + 1 blocker. Issue has "A returning user", "Every gateway CLI failure", "Missing device credentials", "desktop never restarted", "port conflict", "Dismissing background-service tip", "First-run friction", and "Unattended desktop runs"; receipt mirrors all with identical scope.

## Steering

**PASS** — Two genuine steering events identified and recorded; no false positives.

(1) **Every steering event recorded**: PASS. The session contains two human-steering events, both recorded as rows in the `### Steering` table: (a) Message at 07:03:24Z, ordinal 592, type=correction, user asked agent to "take a step back...can you make changes more elegant?" mid-task after code changes were made. Recorded as `steer-62298c7b4a81-1785481404-1`. (b) Message at 07:42:48Z, ordinal 1097, type=interrupt, user expressed concern "C/D/E gateway scnarioes has been running for 31 mins...some problem here" during a long-running background task execution. Recorded as `steer-62298c7b4a81-1785483768-2`. Both events are legitimate mid-task redirections/interrupts.

(2) **No false positives**: PASS. Examined all 60 user messages in the session. Messages excluded as non-steering: initial problem report (#1), restart requests (#2), context summaries (#3, #30), local CLI commands (#4–9, #12–14, #17–24, #31–39, #46–48), model-change commands, approvals (#16: "go ahead"), ordinary questions (#20: "what is the fix", #25: "what is the ix"), simple continuations (#26: "continue"), task notifications (#40–58), final instruction (#60: "generate PR"). Only messages #27 and #49 constituted mid-task interrupts or corrections that redirected the agent's course.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-62298c7b-4a8-1785486601-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 2898 | 1987896 | 93683873 | 516362 | 2507156 | 72.1898 | 2898 | 1987896 | 93683873 | 516362 | feat(desktop): unattended device secrets for restart-heavy tests (#660)An ad-hoc |
| claude-code-62298c7b-4a8-1785488586-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 117 | 95832 | 12209322 | 42945 | 138894 | 7.7778 | 3015 | 2083728 | 105893195 | 559307 | feat(desktop): unattended device secrets for restart-heavy tests (#660)An ad-hoc |
| claude-code-62298c7b-4a8-1785488631-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 4 | 9668 | 415044 | 808 | 10480 | 0.2882 | 3019 | 2093396 | 106308239 | 560115 | feat(desktop): unattended device secrets for restart-heavy tests (#660)An ad-hoc |
| claude-code-62298c7b-4a8-1785489035-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 21 | 15101 | 2363993 | 9125 | 24247 | 1.5046 | 3040 | 2108497 | 108672232 | 569240 | feat(desktop): unattended device secrets for restart-heavy tests (#660)An ad-hoc |
| claude-code-62298c7b-4a8-1785489092-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 4 | 8106 | 439274 | 2014 | 10124 | 0.3207 | 3044 | 2116603 | 109111506 | 571254 | fix(desktop): tell gateway lock, custody, and port failures apart (#660)The lock |
| claude-code-62298c7b-4a8-1785489142-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 2 | 1118 | 223690 | 613 | 1733 | 0.1342 | 3046 | 2117721 | 109335196 | 571867 | fix(client): never offer a fresh start when settings fail to read (#660)boot.tsx |
| claude-code-62298c7b-4a8-1785489194-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 2 | 718 | 224808 | 600 | 1320 | 0.1319 | 3048 | 2118439 | 109560004 | 572467 | fix(client): keep the background service installable after a dismissal (#660)Gat |
| claude-code-62298c7b-4a8-1785489245-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 2 | 1052 | 225526 | 615 | 1669 | 0.1347 | 3050 | 2119491 | 109785530 | 573082 | fix(client): take the friction out of first run (#660)A failed fresh dial showed |
| claude-code-62298c7b-4a8-1785492698-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 2322 | 1239083 | 54900321 | 261433 | 1502838 | 41.7419 | 5372 | 3358574 | 164685851 | 834515 |  |
| claude-code-62298c7b-4a8-1785492874-1 | claude-code | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | claude-opus-5 | 35 | 18959 | 1641817 | 5216 | 24210 | 1.0700 | 5407 | 3377533 | 166327668 | 839731 | test(desktop): adopt the shared fake clock in the retry suite (#660)PR #661 land |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-62298c7b4a81-1785481404-1 | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | correction | classifier | make changes more elegant | feat(desktop): unattended device secrets | 592 | 2026-07-31T07:03:24.066Z |
| steer-62298c7b4a81-1785483768-2 | 62298c7b-4a81-4f6a-85d2-a9be8a64becc | #660 | interrupt | structural |  | feat(desktop): unattended device secrets | 1097 | 2026-07-31T07:42:48.798Z |
