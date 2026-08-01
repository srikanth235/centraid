/**
 * App-weight gate (issue #659 R3d).
 *
 * `apps/mobile`'s `ci:bundle` and `apps/desktop`'s `build:react` already produce
 * the exact artifacts a user downloads, on every PR that touches those paths —
 * and nothing has ever weighed them. A bundle can double in size and every gate
 * in the repo stays green, because the only byte ceilings we own measure what a
 * BROWSER transfers from the e2e harness, not what ships.
 *
 * This script weighs a built directory and asserts it against the `appWeight`
 * entry in the surface's file under `tests/experience-budgets/`. Those ceilings
 * are tighten-only (PERF_BUDGET_SOURCES in scripts/test-report/ratchet-floors.mjs),
 * so a "just bump it" fix is a reviewed edit rather than a quiet one.
 *
 * Two numbers per surface:
 *   - shippedBytes      — everything a user actually receives (source maps and
 *                         other debug sidecars excluded; they are diagnostics,
 *                         not product weight, and their size tracks the code's
 *                         anyway so fencing both double-counts).
 *   - largestChunkBytes — the single biggest shipped file. A total that holds
 *                         while one chunk swallows everything is the shape a
 *                         code-split is supposed to prevent, and a total-only
 *                         budget cannot see it.
 *
 * Year-3 declared volume (docs/coding-standards.md D6): NONE. App weight is a
 * property of the build, not of the vault — it is the one budget in this family
 * that is volume-independent, and that is why it can gate on the PR lane
 * (already-built artifacts, ~30 ms) rather than nightly.
 *
 * Usage:
 *   node scripts/perf/app-weight.mjs --bg-elev desktop
 *   node scripts/perf/app-weight.mjs --bg-elev mobile
 *   node scripts/perf/app-weight.mjs --bg-elev desktop --report   # print, never fail
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/** Debug sidecars that land in a build output but are not product weight. */
const DEBUG_SUFFIXES = [".map", ".txt", ".LICENSE.txt"];

/**
 * Where each surface's shipped bytes live, and which budget file owns them.
 * A surface may name several roots (mobile exports ios and android separately);
 * every root must exist or the run fails — a silently-absent directory would
 * weigh 0 bytes and pass, which is the failure mode this whole script exists
 * to close.
 */
const SURFACES = {
  desktop: {
    budgetFile: "tests/experience-budgets/desktop.json",
    roots: ["apps/desktop/dist/renderer"],
    builtBy: "bun run --cwd apps/desktop build",
  },
  mobile: {
    budgetFile: "tests/experience-budgets/mobile.json",
    roots: ["dist/mobile-bundle-smoke/ios", "dist/mobile-bundle-smoke/android"],
    builtBy: "bun run --cwd apps/mobile ci:bundle",
  },
};

/** Recursively list every file under `dir` as absolute paths. */
async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(full);
      return [full];
    })
  );
  return nested.flat();
}

function isDebugSidecar(file) {
  return DEBUG_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

/** Weigh one root: shipped bytes, the largest shipped file, and the tail. */
async function weighDirectory(absRoot) {
  const files = await listFiles(absRoot);
  const sized = await Promise.all(
    files.map(async (file) => ({
      file: path.relative(absRoot, file),
      bytes: (await stat(file)).size,
      debug: isDebugSidecar(file),
    }))
  );
  const shipped = sized
    .filter((entry) => !entry.debug)
    .toSorted((left, right) => right.bytes - left.bytes);
  return {
    shippedFileCount: shipped.length,
    shippedBytes: shipped.reduce((sum, entry) => sum + entry.bytes, 0),
    debugBytes: sized
      .filter((entry) => entry.debug)
      .reduce((sum, entry) => sum + entry.bytes, 0),
    largestChunkBytes: shipped[0]?.bytes ?? 0,
    largest: shipped.slice(0, 5),
  };
}

/**
 * Pure budget comparison.
 * @param {{ shippedBytes: number; largestChunkBytes: number }} weighed Observed.
 * @param {{ maxTotalBytes?: number; maxLargestChunkBytes?: number }} budget Ceilings.
 * @param {string} label Surface/root label for the message.
 * @returns {string[]} Human-readable breach messages (empty = pass).
 */
function compareWeight(weighed, budget, label) {
  const errors = [];
  if (
    typeof budget.maxTotalBytes === "number" &&
    weighed.shippedBytes > budget.maxTotalBytes
  ) {
    errors.push(
      `${label}: shipped ${weighed.shippedBytes} B > ceiling ${budget.maxTotalBytes} B`
    );
  }
  if (
    typeof budget.maxLargestChunkBytes === "number" &&
    weighed.largestChunkBytes > budget.maxLargestChunkBytes
  ) {
    errors.push(
      `${label}: largest chunk ${weighed.largestChunkBytes} B > ceiling ${budget.maxLargestChunkBytes} B`
    );
  }
  return errors;
}

function parseArgs(argv) {
  const out = { surface: null, report: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bg-elev" && argv[i + 1]) out.surface = argv[++i];
    else if (argv[i] === "--report") out.report = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const surface = SURFACES[args.surface];
  if (!surface) {
    console.error(
      `app-weight: --bg-elev must be one of ${Object.keys(SURFACES).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  const budgets = JSON.parse(
    await readFile(path.join(root, surface.budgetFile), "utf8")
  );
  const budget = budgets.metrics?.appWeight ?? {};

  const errors = [];
  const weighed = await Promise.all(
    surface.roots.map(async (rel) => {
      const abs = path.join(root, rel);
      const present = await stat(abs).then(
        (entry) => entry.isDirectory(),
        () => false
      );
      return present ? { rel, ...(await weighDirectory(abs)) } : { rel };
    })
  );
  const results = [];
  for (const entry of weighed) {
    if (!("shippedBytes" in entry)) {
      errors.push(
        `${entry.rel} is missing — build it first (${surface.builtBy}). An absent directory weighs 0 B and would pass.`
      );
      continue;
    }
    results.push({ root: entry.rel, ...entry });
    errors.push(...compareWeight(entry, budget, entry.rel));
  }

  console.log(`\n============ APP WEIGHT (${args.surface}) ============`);
  for (const result of results) {
    console.log(
      `${result.root}: shipped ${result.shippedBytes} B across ${result.shippedFileCount} files ` +
        `(largest ${result.largestChunkBytes} B; ${result.debugBytes} B of debug sidecars excluded)`
    );
    for (const entry of result.largest) {
      console.log(`    ${String(entry.bytes).padStart(9)} B  ${entry.file}`);
    }
  }
  console.log(
    `ceilings: total ${budget.maxTotalBytes ?? "none"} B, largest chunk ${
      budget.maxLargestChunkBytes ?? "none"
    } B  (${surface.budgetFile})`
  );
  console.log("=====================================================\n");

  if (args.report) return;
  if (errors.length) {
    for (const error of errors) console.error(`app-weight: ${error}`);
    console.error(
      `app-weight: tighten the build or raise the ceiling in ${surface.budgetFile} — that raise is a tighten-only ratchet edit and needs approvedDeviation.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`app-weight: ok (${args.surface})`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) await main();
