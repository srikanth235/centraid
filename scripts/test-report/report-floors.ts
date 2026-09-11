import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  dict,
  errorMessage,
  fromAsync,
  has,
  isRecord,
  items,
  type Loose,
} from "./record.ts";

const floorsPath = path.resolve("tests/floors.json");
const floors = JSON.parse(await readFile(floorsPath, "utf8")).coverage;
console.log("\nCoverage floors enforced by `bun run coverage`:");
for (const [scope, floor] of Object.entries(floors)) {
  if (typeof floor === "number") {
    console.log(`  repo-wide                     lines ${floor}%`);
  } else {
    console.log(
      `  ${scope.padEnd(30)} lines ${String(dict(floor).lines).padStart(2)}% · branches ${String(dict(floor).branches).padStart(2)}%`
    );
  }
}
console.log(
  "Run `bun run coverage` to measure and enforce these ratchet-only floors.\n"
);
