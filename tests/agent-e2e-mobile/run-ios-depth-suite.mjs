// THE iOS DEPTH ROSTER — the claims only iOS can carry (#890 W4).
//
// Android gates PRs and runs the full roster on the per-merge canary and the
// nightly (D1, docs/decisions.md#mobile-testing-890). This lane is deliberately
// NOT a second copy of that roster. A macOS runner minute costs roughly ten
// Linux minutes, and re-proving on iOS, the same night, a claim Android already
// proved buys one thing — a second green — for that multiple. What it does not
// buy is the thing a nightly is for.
//
// So each member below is here because iOS is where its claim lives, and the
// comment says which fact makes that true. A member whose reason stops holding
// is removed; a member added without one is a duplicate wearing a new name.
//
//   pairing-canary          iOS is a SEPARATE ARTIFACT. The Release .app is a
//     different binary from the Android Release apk, built by a different
//     toolchain, autolinking a different native tree, over the XCUITest driver
//     rather than UIAutomator2. If it does not launch and pair, nothing else in
//     this lane means anything — so it runs first and short-circuits, exactly as
//     it does on the PR gate.
//   native-v0-resilience    The React Navigation stack, the safe-area insets and
//     the process-restart behaviour are all OS-mediated, and the Dynamic Island
//     inset the shell's layout is written against exists on no Android device.
//   photos-permissions      iOS's MediaLibrary refusal is a genuinely different
//     mechanism from Android's runtime permission — a different prompt, a
//     different authorization enum (iOS alone has "limited"), and a different
//     shape of denial for the takeover to render. Proving one does not prove
//     the other.
//   locker-gate             SecureStore is the iOS Keychain here and the Android
//     Keystore there, with different accessibility classes and different
//     survival across a process boundary. The claim IS the store's behaviour.
//   cold-start              tests/experience-budgets/mobile.json names both jobs
//     as probe hosts, and a launch time measured on a swiftshader-rendered
//     x86_64 emulator says nothing about a hardware-accelerated iOS simulator.
//     Per-platform evidence or no evidence.
//   scroll-frames           Same reason, and more sharply: the dropped-frame
//     denominator is per-device (targetHz is recorded beside every percentage),
//     so the two platforms' numbers are not comparable and neither substitutes.
//
// DELIBERATELY ABSENT, and why, so the next reader does not "fix" the omission:
// the Photos read/search/viewer/select journeys, the seven home-app covers,
// places-seat, volume-proof and sharing-reach. Every one of those asserts
// product logic over the replica — which is platform-independent by construction
// (one TypeScript source, one replica schema) — and Android runs all of them
// nightly. Their iOS-specific half is the native wiring, which
// `native-v0-resilience` proves once for all of them. That is the E-device-only
// ruling applied to this lane rather than quoted at it.

import { runSuite } from "./lib/run-suite.mjs";

// ONE authoritative member list, canary FIRST (`canaryCount: 1` below) —
// scripts/lint-e2e-wiring.mjs derives what this lane schedules by reading this
// array, so a member held in a second variable would be invisible to the linter
// that exists to catch exactly that.
const FLOWS = [
  "pairing-canary.mjs",
  "native-v0-resilience.mjs",
  "locker-gate.mjs",
  "cold-start.mjs",
  "scroll-frames.mjs",
  "photos-permissions.mjs",
];

// The nightly's iOS half of the #890 W4 envelope (≤45 min wall, ≈150 macOS
// minutes across the whole nightly). Derived, not observed — see
// flows/ios-depth-budget.md, which also carries the rule that this becomes a
// measured p95 ratchet off ledger/durations.json once three real runs exist.
const BUDGET_MS = 25 * 60_000;

process.exitCode = await runSuite({
  name: "ios-depth",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "nightly-ios",
  platform: "ios",
  canaryCount: 1,
  reuseAfter: 1,
  onBudgetBreach:
    "macOS minutes are the scarcest thing this repo spends — move a claim down a tier rather than raising the ceiling.",
});
