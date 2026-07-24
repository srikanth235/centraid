/**
 * Diff-coverage gate (#532).
 *
 * Changed lines vs a merge base (default origin/main) must be ≥ threshold
 * (default 80%) covered according to Istanbul/v8 `coverage-final.json` from
 * `bun run coverage`. Uncovered hunks are named in the failure message.
 *
 * An optional `tests/diff-coverage-deviation.json` with non-empty
 * `approvedDeviation` waives the gate (constitutional exception).
 *
 * Pure comparison helpers are exported for unit tests.
 *
 * Usage:
 *   node scripts/test-report/diff-coverage.mjs
 *   node scripts/test-report/diff-coverage.mjs --base origin/main --threshold 80
 *   node scripts/test-report/diff-coverage.mjs --coverage coverage/coverage-final.json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_THRESHOLD = 80;
export const DEVIATION_PATH = 'tests/diff-coverage-deviation.json';

/**
 * Parse unified diff text into map of file → set of added line numbers
 * (new-file line numbers from +++ hunks).
 * @param {string} diffText diffText parameter.
 * @returns {Map<string, Set<number>>} Return value.
 */
export function parseUnifiedDiffAddedLines(diffText) {
  /** @type {Map<string, Set<number>>} */
  const files = new Map();
  let current = null;
  let newLine = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const rest = raw.slice(4).trim();
      // +++ b/path or +++ /dev/null
      if (rest === '/dev/null') {
        current = null;
        continue;
      }
      const filePath = rest.replace(/^[ab]\//, '');
      current = filePath;
      if (!files.has(current)) files.set(current, new Set());
      continue;
    }
    if (raw.startsWith('@@')) {
      // @@ -a,b +c,d @@
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      files.get(current)?.add(newLine);
      newLine += 1;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      // removed line — do not advance new-file line counter
    } else {
      // context line
      newLine += 1;
    }
  }
  return files;
}

/**
 * Whether a path is an instrumentable source file under packages/ or apps/.
 * Aligns with root vitest coverage include (package/app `src/` trees only):
 * package-root configs (stryker/vitest) are not instrumented and must not fail
 * the gate when they change.
 * @param {string} filePath filePath parameter.
 * @returns {boolean} Return value.
 */
export function isInstrumentableSource(filePath) {
  if (!/^(packages|apps)\//.test(filePath)) return false;
  // Coverage only instruments production sources under src/.
  if (!filePath.includes('/src/')) return false;
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return false;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (filePath.includes('/dist/')) return false;
  return true;
}

/**
 * Look up hit count for file:line in Istanbul coverage-final map.
 * Keys in coverage-final may be absolute or relative; we normalize.
 * @param {Record<string, unknown>} coverageMap coverageMap parameter.
 * @param {string} filePath Repo-relative path
 * @param {number} line 1-based line number
 * @returns {number | null} hits, or null if file/line not in map
 */
export function lineHits(coverageMap, filePath, line) {
  const entry = findCoverageEntry(coverageMap, filePath);
  if (!entry) return null;
  const statementMap =
    /** @type {Record<string, { start: { line: number }; end: { line: number } }>} */ (
      entry.statementMap ?? {}
    );
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
  // Prefer statement map; fall back to line-level map when present (some reporters).
  if (!matched && entry.l && typeof entry.l === 'object') {
    const lmap = /** @type {Record<string, number>} */ (entry.l);
    if (lmap[String(line)] !== undefined) return lmap[String(line)];
  }
  return matched ? hits : null;
}

/**
 * @param {Record<string, unknown>} coverageMap coverageMap parameter.
 * @param {string} filePath filePath parameter.
 */
function findCoverageEntry(coverageMap, filePath) {
  const norm = filePath.replace(/\\/g, '/');
  for (const [key, value] of Object.entries(coverageMap)) {
    const k = key.replace(/\\/g, '/');
    if (k === norm || k.endsWith(`/${norm}`) || k.endsWith(norm)) {
      return /** @type {Record<string, unknown>} */ (value);
    }
    // path suffix match against repo-relative
    if (k.includes(norm)) return /** @type {Record<string, unknown>} */ (value);
  }
  return null;
}

/**
 * Score changed lines against coverage map.
 * @param {Map<string, Set<number>>} changed Added lines by file
 * @param {Record<string, unknown>} coverageMap Istanbul coverage-final
 * @param {{ filter?: (path: string) => boolean }} [opts] Optional filters.
 * @returns {{ total: number; covered: number; uncovered: Array<{ file: string; line: number; hits: number | null }>; percent: number }} Return value.
 */
export function scoreDiffCoverage(changed, coverageMap, opts = {}) {
  const filter = opts.filter ?? isInstrumentableSource;
  /** @type {Array<{ file: string; line: number; hits: number | null }>} */
  const uncovered = [];
  let total = 0;
  let covered = 0;
  for (const [file, lines] of changed) {
    if (!filter(file)) continue;
    for (const line of [...lines].sort((a, b) => a - b)) {
      const hits = lineHits(coverageMap, file, line);
      // null ⇒ not in the coverage statement map (comment/blank/type-only or
      // outside the instrumented set). Skip rather than treat as uncovered.
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

/**
 * Decide pass/fail for a scored result.
 * @param {{ total: number; covered: number; uncovered: Array<{ file: string; line: number }>; percent: number }} score Diff coverage score.
 * @param {number} threshold threshold parameter.
 * @param {string | null | undefined} approvedDeviation approvedDeviation parameter.
 * @returns {{ ok: boolean; reason: string; messages: string[] }} Return value.
 */
export function evaluateDiffCoverage(score, threshold, approvedDeviation) {
  if (score.total === 0) {
    return { ok: true, reason: 'no instrumentable changed lines', messages: [] };
  }
  if (score.percent + 1e-9 >= threshold) {
    return {
      ok: true,
      reason: `${score.percent.toFixed(1)}% ≥ ${threshold}% (${score.covered}/${score.total})`,
      messages: [],
    };
  }
  if (typeof approvedDeviation === 'string' && approvedDeviation.trim()) {
    return {
      ok: true,
      reason: `waived via approvedDeviation (${score.percent.toFixed(1)}% < ${threshold}%)`,
      messages: [],
    };
  }
  const hunks = groupUncoveredHunks(score.uncovered).slice(0, 40);
  const messages = hunks.map(
    (h) =>
      `${h.file}:${h.start}${h.end !== h.start ? `-${h.end}` : ''} (${h.count} uncovered line${h.count === 1 ? '' : 's'})`,
  );
  return {
    ok: false,
    reason: `diff coverage ${score.percent.toFixed(1)}% < ${threshold}% (${score.covered}/${score.total} changed instrumentable lines)`,
    messages,
  };
}

/**
 * @param {Array<{ file: string; line: number }>} uncovered Uncovered line list.
 * @returns {Array<{ file: string; start: number; end: number; count: number }>} Return value.
 */
export function groupUncoveredHunks(uncovered) {
  /** @type {Map<string, number[]>} */
  const byFile = new Map();
  for (const u of uncovered) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file).push(u.line);
  }
  /** @type {Array<{ file: string; start: number; end: number; count: number }>} */
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
  hunks.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file) || a.start - b.start);
  return hunks;
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', candidate], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = {
    base: null,
    threshold: DEFAULT_THRESHOLD,
    coverage: 'coverage/coverage-final.json',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === '--threshold' && argv[i + 1]) out.threshold = Number(argv[++i]);
    else if (argv[i] === '--coverage' && argv[i + 1]) out.coverage = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/test-report/diff-coverage.mjs [--base <ref>] [--threshold 80] [--coverage coverage/coverage-final.json]',
    );
    process.exit(0);
  }
  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.error('diff-coverage: no merge base found; pass --base <ref>');
    process.exitCode = 1;
    return;
  }

  const coveragePath = path.isAbsolute(args.coverage)
    ? args.coverage
    : path.join(root, args.coverage);
  if (!existsSync(coveragePath)) {
    console.error(
      `diff-coverage: missing ${path.relative(root, coveragePath)} — run \`bun run coverage\` first (json reporter writes coverage-final.json)`,
    );
    process.exitCode = 1;
    return;
  }

  let coverageMap;
  try {
    coverageMap = JSON.parse(readFileSync(coveragePath, 'utf8'));
  } catch (err) {
    console.error(`diff-coverage: failed to parse coverage map: ${err}`);
    process.exitCode = 1;
    return;
  }

  let diffText;
  try {
    diffText = execFileSync('git', ['diff', `${baseRef}...HEAD`, '--unified=0', '--no-color'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // Include unstaged too for local pre-push? Prefer merge-base range; on clean
    // PR branch HEAD has all commits. Also include working tree for local checks.
    try {
      const committed = execFileSync(
        'git',
        ['diff', `${baseRef}...HEAD`, '--unified=0', '--no-color'],
        { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
      const unstaged = execFileSync('git', ['diff', '--unified=0', '--no-color'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const staged = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      diffText = committed + unstaged + staged;
    } catch {
      console.error(`diff-coverage: git diff failed: ${err}`);
      process.exitCode = 1;
      return;
    }
  }

  // Always merge working-tree changes so local uncommitted work is gated too.
  try {
    const unstaged = execFileSync('git', ['diff', '--unified=0', '--no-color'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const staged = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    diffText = `${diffText}\n${staged}\n${unstaged}`;
  } catch {
    // ignore
  }

  let approvedDeviation = null;
  const deviationAbs = path.join(root, DEVIATION_PATH);
  if (existsSync(deviationAbs)) {
    try {
      const dev = JSON.parse(readFileSync(deviationAbs, 'utf8'));
      if (typeof dev.approvedDeviation === 'string' && dev.approvedDeviation.trim()) {
        approvedDeviation = dev.approvedDeviation.trim();
      }
    } catch {
      // ignore malformed
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
  console.error('Uncovered changed hunks:');
  for (const m of result.messages) console.error(`  - ${m}`);
  if (result.messages.length === 0) {
    console.error('  (no hunk details; all changed lines missing from coverage map)');
  }
  console.error(
    `Add tests covering the changed lines, or set approvedDeviation in ${DEVIATION_PATH}.`,
  );
  process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
