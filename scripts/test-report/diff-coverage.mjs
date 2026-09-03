import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export const DEFAULT_THRESHOLD = 80;
export const DEVIATION_PATH = "tests/diff-coverage-deviation.json";

export function parseUnifiedDiffAddedLines(diffText) {
  const files = new Map();
  let current = null;
  let newLine = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const rest = raw.slice(4).trim();
      if (rest === "/dev/null") {
        current = null;
        continue;
      }
      const filePath = rest.replace(/^[ab]\//u, "");
      current = filePath;
      if (!files.has(current)) files.set(current, new Set());
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(?<startLine>\d+)(?:,\d+)?/u.exec(raw);
      newLine = Number(m?.groups?.startLine ?? 0);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      files.get(current)?.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // Intentionally empty.
    } else {
      newLine += 1;
    }
  }
  return files;
}

export function isInstrumentableSource(filePath) {
  if (!/^(?:packages|apps)\//u.test(filePath)) return false;
  const conventionalSource = filePath.includes("/src/");
  const blueprintRuntime = filePath.startsWith("packages/blueprints/apps/");
  if (!conventionalSource && !blueprintRuntime) return false;
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(filePath)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(filePath))
    return false;
  if (filePath.endsWith(".d.ts")) return false;
  if (filePath.includes("/dist/")) return false;
  return true;
}

export function lineHits(coverageMap, filePath, line) {
  const entry = findCoverageEntry(coverageMap, filePath);
  if (!entry) return null;
  const statementMap = entry.statementMap ?? {};
  const s = /** @type {Record<string, number>} */ (entry.s ?? {});
  let hits = 0;
  let matched = false;
  for (const [id, loc] of Object.entries(statementMap)) {
    if (!loc?.start) continue;
    const start = loc.start.line;
    const end = loc.end?.line ?? start;
    if (line >= start && line <= end) {
      matched = true;
      hits = Math.max(hits, s[id] ?? 0);
    }
  }
  if (!matched && entry.l && typeof entry.l === "object") {
    const lmap = /** @type {Record<string, number>} */ (entry.l);
    if (lmap[String(line)] !== undefined) return lmap[String(line)];
  }
  return matched ? hits : null;
}

function findCoverageEntry(coverageMap, filePath) {
  const norm = filePath.replace(/\\/gu, "/");
  for (const [key, value] of Object.entries(coverageMap)) {
    const k = key.replace(/\\/gu, "/");
    if (k === norm || k.endsWith(`/${norm}`) || k.endsWith(norm)) {
      return /** @type {Record<string, unknown>} */ (value);
    }
    if (k.includes(norm)) return /** @type {Record<string, unknown>} */ (value);
  }
  return null;
}

export function scoreDiffCoverage(changed, coverageMap, opts = {}) {
  const filter = opts.filter ?? isInstrumentableSource;
  const uncovered = [];
  let total = 0;
  let covered = 0;
  for (const [file, lines] of changed) {
    if (!filter(file)) continue;
    for (const line of [...lines].sort((a, b) => a - b)) {
      const hits = lineHits(coverageMap, file, line);
      if (hits === null) continue;
      total += 1;
      if (hits > 0) {
        covered += 1;
      } else {
        uncovered.push({ file, line, hits });
      }
    }
  }
  const percent = total === 0 ? 100 : (covered / total) * 100;
  return { total, covered, uncovered, percent };
}

export function evaluateDiffCoverage(score, threshold, approvedDeviation) {
  if (score.total === 0) {
    return {
      ok: true,
      reason: "no instrumentable changed lines",
      messages: [],
    };
  }
  if (score.percent + 1e-9 >= threshold) {
    return {
      ok: true,
      reason: `${score.percent.toFixed(1)}% ≥ ${threshold}% (${score.covered}/${score.total})`,
      messages: [],
    };
  }
  if (typeof approvedDeviation === "string" && approvedDeviation.trim()) {
    return {
      ok: true,
      reason: `waived via approvedDeviation (${score.percent.toFixed(1)}% < ${threshold}%)`,
      messages: [],
    };
  }
  const hunks = groupUncoveredHunks(score.uncovered).slice(0, 40);
  const messages = hunks.map(
    (h) =>
      `${h.file}:${h.start}${h.end === h.start ? "" : `-${h.end}`} (${h.count} uncovered line${h.count === 1 ? "" : "s"})`
  );
  return {
    ok: false,
    reason: `diff coverage ${score.percent.toFixed(1)}% < ${threshold}% (${score.covered}/${score.total} changed instrumentable lines)`,
    messages,
  };
}

export function groupUncoveredHunks(uncovered) {
  const byFile = new Map();
  for (const u of uncovered) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file).push(u.line);
  }
  const hunks = [];
  for (const [file, lines] of byFile) {
    lines.sort((a, b) => a - b);
    let start = lines[0];
    let end = lines[0];
    let count = 1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === end + 1) {
        end = lines[i];
        count += 1;
      } else {
        hunks.push({ file, start, end, count });
        start = lines[i];
        end = lines[i];
        count = 1;
      }
    }
    hunks.push({ file, start, end, count });
  }
  hunks.sort(
    (a, b) =>
      b.count - a.count || a.file.localeCompare(b.file) || a.start - b.start
  );
  return hunks;
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return candidate;
    } catch {
      // Intentionally empty.
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = {
    base: null,
    threshold: DEFAULT_THRESHOLD,
    coverage: "coverage/coverage-final.json",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === "--threshold" && argv[i + 1])
      out.threshold = Number(argv[++i]);
    else if (argv[i] === "--coverage" && argv[i + 1]) out.coverage = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/test-report/diff-coverage.mjs [--base <ref>] [--threshold 80] [--coverage coverage/coverage-final.json]"
    );
    process.exit(0);
  }
  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.error("diff-coverage: no merge base found; pass --base <ref>");
    process.exitCode = 1;
    return;
  }

  const coveragePath = path.isAbsolute(args.coverage)
    ? args.coverage
    : path.join(root, args.coverage);
  if (!existsSync(coveragePath)) {
    console.error(
      `diff-coverage: missing ${path.relative(root, coveragePath)} — run \`bun run coverage\` first (json reporter writes coverage-final.json)`
    );
    process.exitCode = 1;
    return;
  }

  let coverageMap;
  try {
    coverageMap = JSON.parse(readFileSync(coveragePath, "utf8"));
  } catch (error) {
    console.error(`diff-coverage: failed to parse coverage map: ${error}`);
    process.exitCode = 1;
    return;
  }

  let diffText;
  try {
    diffText = execFileSync(
      "git",
      ["diff", `${baseRef}...HEAD`, "--unified=0", "--no-color"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }
    );
  } catch (error) {
    try {
      const committed = execFileSync(
        "git",
        ["diff", `${baseRef}...HEAD`, "--unified=0", "--no-color"],
        { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
      );
      const unstaged = execFileSync(
        "git",
        ["diff", "--unified=0", "--no-color"],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      const staged = execFileSync(
        "git",
        ["diff", "--cached", "--unified=0", "--no-color"],
        {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      diffText = committed + unstaged + staged;
    } catch {
      console.error(`diff-coverage: git diff failed: ${error}`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    const unstaged = execFileSync(
      "git",
      ["diff", "--unified=0", "--no-color"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    const staged = execFileSync(
      "git",
      ["diff", "--cached", "--unified=0", "--no-color"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    diffText = `${diffText}\n${staged}\n${unstaged}`;
  } catch {
    // Intentionally empty.
  }

  let approvedDeviation = null;
  const deviationAbs = path.join(root, DEVIATION_PATH);
  if (existsSync(deviationAbs)) {
    try {
      const dev = JSON.parse(readFileSync(deviationAbs, "utf8"));
      if (
        typeof dev.approvedDeviation === "string" &&
        dev.approvedDeviation.trim()
      ) {
        approvedDeviation = dev.approvedDeviation.trim();
      }
    } catch {
      // Intentionally empty.
    }
  }

  const changed = parseUnifiedDiffAddedLines(diffText);
  const score = scoreDiffCoverage(changed, coverageMap);
  const result = evaluateDiffCoverage(score, args.threshold, approvedDeviation);

  if (result.ok) {
    console.log(`diff-coverage: ok — ${result.reason} (base ${baseRef})`);
    return;
  }

  console.error(`diff-coverage: FAIL — ${result.reason} (base ${baseRef})`);
  console.error("Uncovered changed hunks:");
  for (const m of result.messages) console.error(`  - ${m}`);
  if (result.messages.length === 0) {
    console.error(
      "  (no hunk details; all changed lines missing from coverage map)"
    );
  }
  console.error(
    `Add tests covering the changed lines, or set approvedDeviation in ${DEVIATION_PATH}.`
  );
  process.exitCode = 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  main();
}
