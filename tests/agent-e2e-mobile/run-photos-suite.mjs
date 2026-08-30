import path from "node:path";

import { runMobileSuite } from "./lib/suite-runner.mjs";

const FLOWS = [
  "photos-library.mjs",
  "photos-viewer.mjs",
  "photos-search.mjs",
  "photos-select-write.mjs",
  "photos-permissions.mjs",
];
const FLOW_NAMES = [
  "Photos library",
  "Photos viewer",
  "Photos search",
  "Photos select and write",
  "Photos permissions",
];
const BUDGET_MS = 8 * 60_000;
const flowsDir = path.join(import.meta.dirname, "flows");

await runMobileSuite({
  suite: "Photos functionality",
  budgetMs: BUDGET_MS,
  flows: FLOWS.map((file, index) => ({
    name: FLOW_NAMES[index],
    file: path.join(flowsDir, file),
    // The denial journey is deliberately last and pairs from clean app state:
    // its OS permission mutation and empty-vault premise cannot contaminate
    // the fixture-backed functionality chain.
    reusePairedState: index > 0 && index < FLOWS.length - 1,
    requiredForFollowing: index === 0,
  })),
});
