export type LedgerSectionSpec = {
  file: string;
  key: string;
  direction: string;
  budget?: string;
  base?: string | null;
  rows?: string;
  entries?: string;
  waiver?: string;
};

export const FLOORS_PATH = "tests/floors.json";
export const BUDGETS_PATH = "tests/budgets.json";
export const INVENTORY_PATH = "tests/inventory.json";
export const QUARANTINE_PATH = "tests/quarantine.json";
export const CLAIMS_PATH = "tests/claims.json";
export const JOURNEYS_PATH = "tests/journeys.json";
export const ROSTER_PATH = "tests/agent-e2e-mobile/roster.json";

const [F, B, I, Q, J] = [
  FLOORS_PATH,
  BUDGETS_PATH,
  INVENTORY_PATH,
  QUARANTINE_PATH,
  JOURNEYS_PATH,
];

/**
 * Every merged section: its direction, and the file its numbers lived in
 * before #915 Wave 4 (`base`, used for the merge-base fallback; `null` when the
 * section is new or is a mirror ratcheted at its own source).
 */
export const SECTIONS: ReadonlyArray<LedgerSectionSpec> = Object.freeze([
  {
    file: F,
    key: "coverage",
    direction: "up",
    base: "tests/coverage-floors.json",
  },
  {
    file: F,
    key: "mutation",
    direction: "up",
    base: "tests/mutation-floors.json",
  },
  { file: F, key: "minimumTests", direction: "mirror" },
  {
    file: B,
    key: "suiteWallClock",
    direction: "down",
    budget: "lanes",
    base: "tests/suite-wall-clock.json",
  },
  { file: B, key: "rungs", direction: "down", budget: "*" },
  // #927 — the journey ledger. `entries` holds every user-facing ceiling keyed
  // `surface / journey / volume / hardware`; `rigs` is the nightly rig register
  // that produces them. Both down-only, each with its own waiver scope.
  { file: J, key: "entries", direction: "down", budget: "*" },
  { file: J, key: "rigs", direction: "down", budget: "*" },
  {
    file: B,
    key: "designTokenCss",
    direction: "down",
    budget: "budgets",
    base: "tests/design-token-css-budget.json",
  },
  { file: B, key: "mobileSuites", direction: "mirror" },
  {
    file: I,
    key: "skips",
    direction: "down",
    budget: "_budget",
    entries: "exceptions",
    rows: "sites",
    base: "tests/skips.json",
  },
  {
    file: I,
    key: "envRed",
    direction: "down",
    budget: "_budget",
    entries: "exceptions",
    rows: "sites",
    base: "tests/env-red.json",
  },
  {
    file: I,
    key: "sleeps",
    direction: "down",
    budget: "_budget",
    entries: "population",
    base: "tests/sleep-inventory.json",
  },
  {
    file: I,
    key: "hygiene",
    direction: "down",
    budget: "budgets",
    entries: "population",
    base: "tests/hygiene-budgets.json",
  },
  {
    file: I,
    key: "commentDensity",
    direction: "down",
    entries: "population",
    base: "tests/comment-density-ratchet.json",
  },
  // The file-length exemptions (`max-lines`, oxlint.config.ts). `_budget` is
  // the row count and is down-only, so the set of files allowed past the
  // 625-line ceiling can only shrink; scripts/lint-oversized-files.mjs refuses
  // to build the override list if the two ever disagree.
  { file: I, key: "fileSize", direction: "down", budget: "_budget" },
  { file: I, key: "naCells", direction: "reference" },
  {
    file: I,
    key: "advisory",
    direction: "register",
    entries: "exceptions",
    rows: "steps",
    base: "tests/advisory-ledger.json",
  },
  { file: Q, key: "_policy", direction: "down", budget: "*", base: Q },
  {
    file: Q,
    key: "entries",
    direction: "register",
    entries: "exceptions",
    base: Q,
  },
  {
    file: Q,
    key: "lanes",
    direction: "register",
    entries: "exceptions",
    base: "tests/lane-quarantine.json",
  },
]);
