// Authoritative ownership for every mobile Maestro flow.
//
// A flow is either:
//   - CI-owned: exercised on the listed platforms as part of the named suite;
//   - manual: intentionally absent from CI, with a reason that makes the gap
//     explicit and reviewable.
//
// Keep this catalog declarative. The linter discovers the directory from disk,
// checks this catalog has neither omissions nor stale entries, and then proves
// each CI-owned entry is reachable from the canonical workflow surface for
// every platform it claims.

export const FLOW_CATALOG = Object.freeze({
  "tests/agent-e2e-mobile/flows/agenda-week.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/cold-start.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "lane-a",
  },
  "tests/agent-e2e-mobile/flows/docs-drive.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/home-loads.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "lane-a",
  },
  "tests/agent-e2e-mobile/flows/locker-gate.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/native-v0-resilience.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "lane-a",
  },
  "tests/agent-e2e-mobile/flows/notes-library.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/people-roster.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/photos-library.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "photos",
  },
  "tests/agent-e2e-mobile/flows/photos-permissions.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "photos",
  },
  "tests/agent-e2e-mobile/flows/photos-search.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "photos",
  },
  "tests/agent-e2e-mobile/flows/photos-select-write.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "photos",
  },
  "tests/agent-e2e-mobile/flows/photos-viewer.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "photos",
  },
  "tests/agent-e2e-mobile/flows/places-seat.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "standalone",
  },
  "tests/agent-e2e-mobile/flows/scroll-frames.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "standalone",
  },
  "tests/agent-e2e-mobile/flows/sharing-invite.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "standalone",
  },
  "tests/agent-e2e-mobile/flows/tally-derived.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/tasks-board.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "home-apps",
  },
  "tests/agent-e2e-mobile/flows/volume-proof.mjs": {
    ownership: "ci",
    platforms: ["ios", "android"],
    suite: "lane-a",
  },
});

export default FLOW_CATALOG;
