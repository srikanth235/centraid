# Issue #643 — onboarding fit + scan-first pairing

## Checklist

- [x] Every onboarding step fits the device it runs on.
- [x] The hero scales on both axes.
- [x] The hero portrays the product, not one step.
- [x] Hero motion settles instead of looping.
- [x] Scanning is the primary pairing path.
- [x] Exactly one path is primary at a time.
- [x] A denied camera permission degrades with a reason.
- [x] The hierarchy is covered by a test.

## What changed

- `apps/mobile/src/screens/Onboarding.tsx`
  - Adaptive hero sizing, so that **every onboarding step fits the device it
    runs on** with its primary action above the fold. Measure the chrome row
    and the step block with `onLayout`, subtract them plus safe-area insets and
    padding from the window height, and hand the art the remainder capped at
    its natural size. Below `HERO_MIN` (96) the art hides entirely. Both
    measured blocks are siblings of the art, so their heights never depend on
    it and the fit converges in one pass rather than oscillating.
  - `ConnectionStep` reworked around a `showPaste` disclosure, so that
    **scanning is the primary pairing path** and pasting a ticket is the
    fallback. The default state shows only the scan action; the pairing-code
    box and its `Connect` button exist only once asked for. **Exactly one path
    is primary at a time** — choosing paste promotes `Connect` and demotes
    scanning to a link, and the link back restores the scan-first state. The
    lede swaps with the mode, so `centraid-gateway pair` is named in the paste
    panel rather than in the primary path.
  - The camera permission effect now handles the permanently-denied case: **a
    denied camera permission degrades with a reason** — it stops scanning,
    opens the paste panel, and says why — instead of re-rendering the same form
    behind a primary button that silently does nothing.
- `apps/mobile/src/screens/onboarding-home-art.tsx` (new)
  - `HomeArt` + `HOME_ART`: a single hero in which **the hero portrays the
    product, not one step** — a house whose door is the gateway mark, the four
    blueprint apps as lit windows, this phone and a laptop paired in, and a
    struck-through cloud — so the same art carries all three steps.
  - **The hero scales on both axes**: one uniform factor,
    `Math.min(width / HOME_ART.width, height / HOME_ART.height)`, so it fits
    the box it is given and cannot clip sideways on a narrow phone.
  - **Hero motion settles instead of looping.** The intro runs once on mount;
    only the sync dashes repeat, because the art sits above a form people are
    reading and typing into. `useReducedMotion()` settles the art immediately
    and never starts the dashes.
- `apps/mobile/src/screens/onboarding-art.tsx`
  - Added `ScanTargetMark`, the viewfinder glyph for the primary scan action.
  - Removed `VaultArt` and `OrbitArt`, superseded by the single hero.
- `apps/mobile/src/screens/onboarding-styles.ts` (new)
  - The flow's palette, stylesheet, and layout constants. Extracted because the
    change pushed `Onboarding.tsx` to 653 lines against the 625-line limit;
    splitting matches what this flow already does with its art rather than
    filing a size waiver. The padding constants live here too, so the
    stylesheet and the hero arithmetic that subtracts it cannot drift apart.
- `apps/mobile/src/screens/Onboarding.test.tsx`
  - Paste-based scenarios open the disclosure first, as a person would.
  - **The hierarchy is covered by a test**: a new case asserts scan is
    reachable on first render, no code box exists until asked for, and the way
    back to scanning works — so it cannot silently invert again.
  - Added the mocks the new code needs (`useWindowDimensions`,
    `useSafeAreaInsets`, `Line`/`LinearGradient`, and a reanimated stub). The
    driver is stubbed rather than the art, so the real artwork still renders in
    this suite and a crash in it fails the test.

Crosswalk — each checklist item and the change that realizes it:

- Every onboarding step fits the device it runs on. → `Onboarding.tsx`: measure the chrome row and step block, hand the hero the remainder, hide it below `HERO_MIN`.
- The hero scales on both axes. → `onboarding-home-art.tsx`: one uniform `Math.min(width / VB_W, height / VB_H)` factor.
- The hero portrays the product, not one step. → `onboarding-home-art.tsx`: house, gateway door, four app windows, paired devices, struck-through cloud; one hero for all three steps.
- Hero motion settles instead of looping. → `onboarding-home-art.tsx`: single `intro` clock run once on mount; only the sync dashes repeat; `useReducedMotion()` settles immediately.
- Scanning is the primary pairing path. → `Onboarding.tsx`: `ScanTargetMark` on a brand-filled card as the default action, paste behind a disclosure link.
- Exactly one path is primary at a time. → `Onboarding.tsx`: `showPaste` swaps which action is filled and which is a text link, in both directions.
- A denied camera permission degrades with a reason. → `Onboarding.tsx`: the permission effect stops scanning, opens the paste panel, and sets an explanatory error.
- The hierarchy is covered by a test. → `Onboarding.test.tsx`: asserts scan-on-first-render, absent code box, and the return path.

## Decisions

- **Progressive disclosure rather than restyled buttons.** The issue was framed
  as a button-weight problem. Swapping the styles alone would not have fixed
  it: the 120pt monospace code box was the largest, most permanent element on
  the screen, and weight follows area, so the composition would still have read
  as "typing is the job". Hiding the fallback until it is asked for is what
  actually inverts the hierarchy — and it hands ~135pt back to the hero.
- **Fixed a defect outside the stated scope.** The permanently-denied camera
  path was a dead primary button, found while testing the new scan-first
  layout. Leaving it would have shipped a screen whose primary action can
  silently do nothing, so it is fixed here rather than deferred.
- **Split the stylesheet instead of waiving the file-size limit.** The change
  took `Onboarding.tsx` past the 625-line cap. The flow already splits its art
  out for exactly this reason, so a third module follows the established
  pattern; a waiver would have been the lower-effort, worse answer.
- **Android is untested.** The repo's convention is that mobile changes ship
  iOS and Android together. This has only been run on an iOS simulator, so the
  convention is not met — recorded in "Out of scope" rather than papered over.
- **Podfile.lock committed separately.** It is a real bug and a prerequisite
  for building, but unrelated to onboarding, so it is its own commit.

## Out of scope

- **Android.** The change is pure React Native + `react-native-svg` with no
  platform branches, but it has only been run on an iOS simulator. Per the
  repo's mobile convention this needs an Android pass before it ships.
- The desktop "Connect phone" QR screen that the new copy points at.
- `apps/mobile/ios/Podfile.lock`, stale for unrelated reasons. Committed
  separately: #630/#638 added `expo-clipboard`, `centraid-ocr`, and
  `centraid-network-status` to `package.json` without refreshing the lockfile,
  so a clean checkout cannot build iOS. Found because the simulator threw
  `Cannot find native module 'ExpoClipboard'`.

## Verification

Run on an iOS simulator (iPhone 17 Pro, iOS 26.x) against a real gateway —
`centraid-gateway serve` on an isolated data dir, tickets minted with
`pair --json`, redeemed over iroh. Not a mock.

- All three steps fit with the primary action above the fold, on a viewport
  where the pairing step previously overflowed by ~55pt.
- The hero resizes per step: near full size on the short profile and done
  steps, reduced on the pairing step, hidden entirely once the pairing-code box
  expands to hold a 527-character ticket.
- Scan-first state renders with no code box present.
- The disclosure reveals the code box, promotes `Connect`, demotes scanning to
  a link, and swaps the lede; the link back restores the scan-first state.
- Tapping scan raises the iOS camera permission prompt.
- Denying it lands on the paste panel with "Camera access is off for Centraid.
  Turn it on in Settings, or paste a code below." — previously this left a
  primary button that did nothing.
- A full paste-path pairing completes; the gateway logs
  `device plane: enrolled … as member You into vaults …` and the app advances
  through the profile step to the home springboard.

Gates — re-runnable as written:

```sh
cd apps/mobile
bun run typecheck                        # clean for the touched files
bun run lint                             # clean
bun run test src/screens/Onboarding.test.tsx   # 8 passed
bun run test                             # 290 passed across 53 files
cd ../.. && bun run knip                 # no findings for these files
```

Reproducing the live pairing run, with the gateway on an isolated data dir so
it cannot touch a real vault:

```sh
bun run build --filter=@centraid/gateway...
node packages/gateway/dist/cli/cli.js serve --data-dir "$TMPDIR/gw" --port 18900 &
node packages/gateway/dist/cli/cli.js pair --data-dir "$TMPDIR/gw" --port 18900 --json
# paste the ticket into the app's fallback panel; then confirm the enrollment:
grep enrolled "$TMPDIR/gw"/../gateway.log
```

Pre-existing and untouched: `@centraid/time-engine` / `@centraid/protocol`
resolution failures from unbuilt workspace packages, which affect other suites
and none of the onboarding files.

## Audit

1. **"What changed" faithfully describes the diff** — PASS
   - `Onboarding.tsx`: diff shows `useWindowDimensions`, `useSafeAreaInsets`, hero sizing logic with `onLayout` measurement, `showPaste` state controlling disclosure, and camera-denied fallback (lines 324-343, 400, 414-426). Receipt says "Measure the chrome row and the step block with `onLayout`, subtract them plus safe-area insets and padding from the window height, and hand the art the remainder capped at its natural size" — matches exactly.
   - `onboarding-home-art.tsx`: NEW file with `HomeArt` component rendering house with door/gateway, blueprint apps as windows, phone+laptop with ticks, struck-through cloud. Intro `withDelay(120, withTiming(...))` + `withRepeat()` on ants. Receipt says "intro plays ONCE on mount and settles. Only the sync dashes repeat" — confirmed in lines 957-964.
   - `onboarding-art.tsx`: `ScanTargetMark` added (lines 793-865); `OrbitArt` removed (deleted 68 lines). Receipt says "Added `ScanTargetMark`, the viewfinder glyph for the primary scan action. Removed `VaultArt` and `OrbitArt`" — matches.
   - `onboarding-styles.ts`: NEW file with palette `C`, stylesheet constants `AVATAR`, `PAD_H`, `PAD_TOP`, `PAD_BOTTOM`, `HERO_GAP`, and `styles` StyleSheet (195 lines). Receipt says "The flow's palette, stylesheet, and layout constants. Extracted because the change pushed `Onboarding.tsx` to 653 lines against the 625-line limit" — confirmed.
   - `Onboarding.test.tsx`: New mocks for `useWindowDimensions`, `useSafeAreaInsets`, `Line`/`LinearGradient`, reanimated stub (lines 96-130). New test "offers scanning first and keeps the code box out of the way" (lines 185-197). Receipt says "Added the mocks the new code needs...The hierarchy is covered by a test: a new case asserts scan is reachable on first render, no code box exists until asked for, and the way back to scanning works" — matches.

2. **Each checklist item is realized in the diff** — PASS
   - [x] Every onboarding step fits the device it runs on: `Onboarding.tsx` lines 324-343 calculate `spare` space and set `heroHeight`, wrapping the hero in `{showHero ? ... : null}` (line 363).
   - [x] The hero scales on both axes: `onboarding-home-art.tsx` line 941 computes `const scale = Math.max(0, Math.min(width / HOME_ART.width, height / HOME_ART.height))`.
   - [x] The hero portrays the product, not one step: `onboarding-home-art.tsx` lines 876-886 header comment; `HomeArt` renders house/door/apps/devices/cloud. Same art passed to all three steps in `Onboarding.tsx` (line 365).
   - [x] Hero motion settles instead of looping: `onboarding-home-art.tsx` lines 957-964 show `intro` runs once via `withDelay(...withTiming(...))`, `ants` repeats forever via `withRepeat(...)`.
   - [x] Scanning is the primary pairing path: `Onboarding.tsx` lines 514-533 show scan button as primary when `!showPaste`, paste link as secondary.
   - [x] Exactly one path is primary at a time: `Onboarding.tsx` lines 497-533 implement toggle: when `showPaste` true, "Connect" is primary; when false, scan button is primary.
   - [x] A denied camera permission degrades with a reason: `Onboarding.tsx` lines 414-426 handle permanently-denied case: `setScanning(false); setShowPaste(true); setError("Camera access is off...")`.
   - [x] The hierarchy is covered by a test: `Onboarding.test.tsx` lines 185-197 new test case asserts scan button present, textarea null, PAIRING CODE not shown initially, then reveals box, then can return to scan.

3. **Checklist mirrors the issue's checklist** — PASS
   - Receipt checklist (lines 3-12) matches issue #643 body checklist exactly: both have 8 items covering fit, hero scales, portrays product, settles motion, scanning primary, one path primary, denied permission, hierarchy tested.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-7f2c208793ce-1785419131-1 | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | correction | classifier | Rethink from scratch: examine Centraid fundamentals | PENDING | 1 | 2026-07-30T09:55:31.318Z |
| steer-7f2c208793ce-1785419131-2 | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | interrupt | structural |  | PENDING | 2 | 2026-07-30T09:58:26.853Z |
| steer-7f2c208793ce-1785419131-3 | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | correction | classifier | Redirect to semi-technical user perspective | PENDING | 3 | 2026-07-30T10:04:32.770Z |
| steer-7f2c208793ce-1785419131-4 | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | correction | classifier | Return to house/rooms analogy; focus Docs and Photos | PENDING | 4 | 2026-07-30T10:12:32.628Z |
| steer-7f2c208793ce-1785419131-5 | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | correction | classifier | Devices must play central role; reconsider vault representation | PENDING | 5 | 2026-07-30T10:15:32.901Z |
| steer-7f2c208793ce-1785419131-6 | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | correction | classifier | Simplify: reduce visual complexity | PENDING | 6 | 2026-07-30T10:20:02.719Z |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-7f2c2087-93c-1785419558-1 | claude-code | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | claude-opus-5 | 21 | 47527 | 2481239 | 20646 | 68194 | 2.0539 | 1058 | 4213890 | 93822136 | 652613 |  |
| claude-code-7f2c2087-93c-1785419634-1 | claude-code | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | claude-opus-5 | 2 | 2211 | 236882 | 173 | 2386 | 0.1366 | 1060 | 4216101 | 94059018 | 652786 |  |
| claude-code-7f2c2087-93c-1785419775-1 | claude-code | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | claude-opus-5 | 8 | 3591 | 957081 | 4312 | 7911 | 0.6088 | 1068 | 4219692 | 95016099 | 657098 |  |
## Steering

**Verdict:** PASS

1. **Every human-steering event in the transcript is recorded** — PASS
   - Six steering events identified: one interrupt ("wait.." at 09:58:26) and five corrections (rethink at 09:55:31, redirect to semi-technical perspective at 10:04:32, return to house analogy at 10:12:32, emphasize devices at 10:15:32, simplify at 10:20:02). All six are present in the `### Steering` table as rows 1–6.

2. **No non-steering message is recorded as steering** — PASS
   - Tool results, status checks ("done?"), build notifications, and ordinary task messages ("can you pair the simulator please", "just push the code to a feature branch") are absent from the steering table. Only genuine redirects that changed the agent's direction mid-task are recorded.

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-7f2c2087-93c-1785418975-1 | claude-code | 7f2c2087-93ce-411a-a9e8-a3ad3472241f | #643 | claude-opus-5 | 1037 | 4166363 | 91340897 | 631967 | 4799367 | 87.5146 | 1037 | 4166363 | 91340897 | 631967 |  |
