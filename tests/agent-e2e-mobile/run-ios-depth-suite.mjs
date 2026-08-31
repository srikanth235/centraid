// THE iOS RELEASE ROSTER — native depth plus app-level journeys (#908).
//
// Android remains the PR and merge-gating platform. This nightly lane also
// runs the product's app-level journeys against the iOS Release artifact so
// the question "does this app work on iOS?" has direct evidence, not an
// inference from Android plus one native smoke test. The roster is one ordered
// suite with explicit lifecycle boundaries: the canary pairs once, the empty
// Photos permission journey pairs a clean profile, and the app roster then
// pairs one fully seeded profile that every later journey reuses.
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
// App-level coverage is intentionally explicit below. The Android-only
// offline/share-intent branches remain guarded inside their flows; the iOS
// lane still exercises each supported iOS path and its product assertions.

import { runSuite } from "./lib/run-suite.mjs";

// ONE authoritative member list, canary FIRST (`canaryCount: 1` below) —
// scripts/lint-e2e-wiring.mjs derives what this lane schedules by reading this
// array, so a member held in a second variable would be invisible to the linter
// that exists to catch exactly that.
const FLOWS = [
  "pairing-canary.mjs",
  // Permission denial needs an empty Photos replica, so it owns the second
  // fresh pairing before the roster fixture is seeded.
  "photos-permissions.mjs",
  "ios-roster-bootstrap.mjs",
  "native-v0-resilience.mjs",
  // App-level coverage: every shipped first-party app/surface with a
  // scheduled mobile journey. Keep these names authoritative so
  // lint:e2e-wiring can prove the iOS lane really runs them.
  "docs-drive.mjs",
  "agenda-week.mjs",
  "notes-library.mjs",
  "tasks-board.mjs",
  "people-roster.mjs",
  "tally-derived.mjs",
  "sharing-invite.mjs",
  "places-seat.mjs",
  "locker-gate.mjs",
  "photos-library.mjs",
  "photos-viewer.mjs",
  "photos-search.mjs",
  "photos-select-write.mjs",
  // Platform probes remain part of the same release-artifact verdict.
  "cold-start.mjs",
  "scroll-frames.mjs",
];

// The expanded app-level roster's bounded iOS envelope. Derived, not observed;
// see flows/ios-depth-budget.md. This stays below the workflow's 140-minute
// backstop and is re-derived from measured CI p95s after three runs.
const BUDGET_MS = 79 * 60_000;

process.exitCode = await runSuite({
  name: "ios-depth",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "nightly-ios",
  platform: "ios",
  canaryCount: 1,
  reuseAfter: 1,
  onBudgetBreach:
    "the expanded iOS app roster exceeded its measured envelope; inspect CI failure classes and measured p95s before changing scope or budget.",
});
