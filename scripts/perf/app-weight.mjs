import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

const DEBUG_SUFFIXES = [".map", ".txt", ".LICENSE.txt"];

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
  web: {
    budgetFile: "tests/experience-budgets/web.json",
    roots: ["apps/web/dist"],
    builtBy: "bun run web:build",
    extraDebugSuffixes: [".br", ".gz"],
  },
};

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

function isDebugSidecar(file, extraSuffixes = []) {
  return [...DEBUG_SUFFIXES, ...extraSuffixes].some((suffix) =>
    file.endsWith(suffix)
  );
}

async function weighDirectory(absRoot, extraSuffixes = []) {
  const files = await listFiles(absRoot);
  const sized = await Promise.all(
    files.map(async (file) => ({
      file: path.relative(absRoot, file),
      bytes: (await stat(file)).size,
      debug: isDebugSidecar(file, extraSuffixes),
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
    if (argv[i] === "--surface" && argv[i + 1]) out.surface = argv[++i];
    else if (argv[i] === "--report") out.report = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const surface = SURFACES[args.surface];
  if (!surface) {
    console.error(
      `app-weight: --surface must be one of ${Object.keys(SURFACES).join(", ")}`
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
      return present
        ? {
            rel,
            ...(await weighDirectory(abs, surface.extraDebugSuffixes ?? [])),
          }
        : { rel };
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
