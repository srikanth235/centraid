import { promises as fs } from "node:fs";
import path from "node:path";

import { FLOW_CATALOG } from "./ci-flow-catalog.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const shard = process.argv[2];
const platform = process.argv[3];
const shardSuites = {
  core: "lane-a",
  photos: "photos",
  "home-apps": "home-apps",
};
const standalone = {
  "photos-library": "tests/agent-e2e-mobile/flows/photos-library.mjs",
  "photos-viewer": "tests/agent-e2e-mobile/flows/photos-viewer.mjs",
  "photos-search": "tests/agent-e2e-mobile/flows/photos-search.mjs",
  "photos-select-write": "tests/agent-e2e-mobile/flows/photos-select-write.mjs",
  "photos-permissions": "tests/agent-e2e-mobile/flows/photos-permissions.mjs",
  "home-docs": "tests/agent-e2e-mobile/flows/docs-drive.mjs",
  "home-agenda": "tests/agent-e2e-mobile/flows/agenda-week.mjs",
  "home-notes": "tests/agent-e2e-mobile/flows/notes-library.mjs",
  "home-tasks": "tests/agent-e2e-mobile/flows/tasks-board.mjs",
  "home-people": "tests/agent-e2e-mobile/flows/people-roster.mjs",
  "home-tally": "tests/agent-e2e-mobile/flows/tally-derived.mjs",
  "home-locker": "tests/agent-e2e-mobile/flows/locker-gate.mjs",
  places: "tests/agent-e2e-mobile/flows/places-seat.mjs",
  sharing: "tests/agent-e2e-mobile/flows/sharing-invite.mjs",
  "photos-frames": "tests/agent-e2e-mobile/flows/scroll-frames.mjs",
};
const runtimeSlugs = {
  "cold-start": "mobile-cold-start",
  "native-v0-resilience": "native-v0-resilience",
  "volume-proof": "mobile-volume-proof",
  "scroll-frames": "mobile-scroll-frames",
};
const runtimeSlug = (flow) => runtimeSlugs[flow] ?? flow;
const elapsedMs = Math.max(
  0,
  Date.now() - Number(process.env.MOBILE_E2E_SHARD_STARTED_AT ?? Date.now())
);

async function writeSetupFailure(flow, reason) {
  const owner = `tests/agent-e2e-mobile/flows/${flow}.mjs`;
  const directory = path.join(repoRoot, "artifacts", "e2e");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, `${flow}-${platform}.json`),
    `${JSON.stringify(
      {
        lane: "e2e",
        owner,
        name: flow,
        platform,
        status: "failed",
        phase: "setup",
        reason,
        capturedAt: new Date().toISOString(),
        measurements: [{ name: "wall clock", value: elapsedMs, unit: "ms" }],
      },
      null,
      2
    )}\n`
  );
}

if (!shard || !["ios", "android"].includes(platform)) {
  throw new Error("usage: verify-ci-shard.mjs <shard> <ios|android>");
}

const suite = shardSuites[shard];
const expected = Object.entries(FLOW_CATALOG)
  .filter(([, entry]) =>
    shard === "all"
      ? entry.ownership === "ci" && entry.platforms.includes(platform)
      : suite
        ? entry.ownership === "ci" &&
          entry.suite === suite &&
          entry.platforms.includes(platform)
        : false
  )
  .map(([owner]) => path.basename(owner, ".mjs"));
if (standalone[shard]) expected.push(path.basename(standalone[shard], ".mjs"));
if (expected.length === 0)
  throw new Error(`unknown or empty CI shard: ${shard}`);

if (suite === "photos" || suite === "home-apps") {
  const resultName =
    suite === "photos"
      ? `${platform}-photos-functionality.json`
      : `${platform}-home-app-functionality.json`;
  let result;
  try {
    result = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, "artifacts/e2e-suites", resultName),
        "utf8"
      )
    );
  } catch (error) {
    await Promise.all(
      expected.map((flow) =>
        writeSetupFailure(
          flow,
          "shard ended before its suite result was written"
        )
      )
    );
    throw new Error(`${platform}/${shard} emitted no suite result`, {
      cause: error,
    });
  }
  const actual = result.results.map((entry) =>
    path.basename(entry.file, ".mjs")
  );
  if (
    actual.length !== expected.length ||
    expected.some((flow) => !actual.includes(flow))
  ) {
    throw new Error(
      `${platform}/${shard} result roster mismatch: expected ${expected.join(", ")}; got ${actual.join(", ")}`
    );
  }
  console.log(
    `${platform}/${shard}: ${actual.length} structured results present`
  );
  process.exit(0);
}

if (shard === "all") {
  const missing = [];
  for (const flow of expected) {
    try {
      await fs.access(
        path.join(
          repoRoot,
          "artifacts",
          "e2e",
          `${runtimeSlug(flow)}-${platform}.json`
        )
      );
    } catch {
      missing.push(flow);
    }
  }
  if (missing.length > 0) {
    await Promise.all(
      missing.map((flow) =>
        writeSetupFailure(
          flow,
          "job ended before its flow evidence was written"
        )
      )
    );
    throw new Error(
      `${platform}/${shard} emitted no evidence for: ${missing.join(", ")}`
    );
  }
  console.log(
    `${platform}/${shard}: ${expected.length} evidence records present`
  );
  process.exit(0);
}

const runEntries = await fs
  .readdir(path.join(import.meta.dirname, "runs"), { withFileTypes: true })
  .catch(() => []);
const missing = [];
for (const flow of expected) {
  const candidates = runEntries.filter(
    (entry) =>
      entry.isDirectory() && entry.name.startsWith(`${runtimeSlug(flow)}-`)
  );
  const verdicts = await Promise.all(
    candidates.map((entry) =>
      fs
        .access(
          path.join(import.meta.dirname, "runs", entry.name, "verdict.md")
        )
        .then(() => true)
        .catch(() => false)
    )
  );
  if (!verdicts.some(Boolean)) missing.push(flow);
}
if (missing.length > 0) {
  await Promise.all(
    missing.map((flow) =>
      writeSetupFailure(flow, "shard ended before its flow verdict was written")
    )
  );
  throw new Error(
    `${platform}/${shard} emitted no verdict for: ${missing.join(", ")}`
  );
}
console.log(`${platform}/${shard}: ${expected.length} flow verdicts present`);
