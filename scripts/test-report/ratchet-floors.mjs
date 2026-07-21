/**
 * Floors-up-only ratchet (#496 E4).
 *
 * Diffs `tests/coverage-floors.json` and every matrix flow `minimumTests` against
 * a git merge-base (default: origin/main). Any decrease fails unless the
 * touched JSON carries an `approvedDeviation` / flow-level `approvedMinimumTestsDeviation`
 * marker explaining the constitutional exception.
 *
 * Usage:
 *   node scripts/test-report/ratchet-floors.mjs
 *   node scripts/test-report/ratchet-floors.mjs --base origin/main
 *   node scripts/test-report/ratchet-floors.mjs --base <sha>
 *
 * Pure comparison is exported for unit tests.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Compare coverage floor objects for any downward movement.
 * @param {unknown} base Floors on the merge base.
 * @param {unknown} head Floors on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffCoverageFloors(base, head) {
  const errors = [];
  if (!base || typeof base !== 'object' || !head || typeof head !== 'object') {
    return errors;
  }
  const baseObj = /** @type {Record<string, unknown>} */ (base);
  const headObj = /** @type {Record<string, unknown>} */ (head);
  const keys = new Set([...Object.keys(baseObj), ...Object.keys(headObj)]);
  for (const key of keys) {
    if (key === 'approvedDeviation' || key.startsWith('_')) continue;
    const b = baseObj[key];
    const h = headObj[key];
    if (typeof b === 'number' && typeof h === 'number') {
      if (h < b) {
        errors.push(`coverage floor "${key}" decreased ${b} → ${h}`);
      }
      continue;
    }
    if (b && typeof b === 'object' && h && typeof h === 'object') {
      const bb = /** @type {Record<string, number>} */ (b);
      const hh = /** @type {Record<string, number>} */ (h);
      for (const metric of new Set([...Object.keys(bb), ...Object.keys(hh)])) {
        if (
          typeof bb[metric] === 'number' &&
          typeof hh[metric] === 'number' &&
          hh[metric] < bb[metric]
        ) {
          errors.push(`coverage floor "${key}.${metric}" decreased ${bb[metric]} → ${hh[metric]}`);
        }
      }
    }
  }
  return errors;
}

/**
 * Compare matrix flow minimumTests floors for any downward movement.
 * @param {{ flows?: Array<{ id?: string; minimumTests?: number; approvedMinimumTestsDeviation?: string }> }} base Matrix on the merge base.
 * @param {{ flows?: Array<{ id?: string; minimumTests?: number; approvedMinimumTestsDeviation?: string }> }} head Matrix on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffMinimumTests(base, head) {
  const errors = [];
  const baseMap = new Map((base?.flows ?? []).filter((f) => f?.id).map((f) => [f.id, f]));
  for (const flow of head?.flows ?? []) {
    if (!flow?.id || flow.minimumTests === undefined) continue;
    const prev = baseMap.get(flow.id);
    if (!prev || prev.minimumTests === undefined) continue;
    if (flow.minimumTests < prev.minimumTests) {
      if (
        typeof flow.approvedMinimumTestsDeviation === 'string' &&
        flow.approvedMinimumTestsDeviation.trim()
      ) {
        continue;
      }
      errors.push(
        `flow "${flow.id}" minimumTests decreased ${prev.minimumTests} → ${flow.minimumTests} (add approvedMinimumTestsDeviation to allow)`,
      );
    }
  }
  return errors;
}

/**
 * Run the full floors-up-only ratchet (coverage floors + minimumTests).
 * @param {object} opts Comparison inputs.
 * @param {unknown} opts.baseFloors Floors JSON on the merge base.
 * @param {unknown} opts.headFloors Floors JSON on the working tree.
 * @param {object} opts.baseMatrix Matrix JSON on the merge base.
 * @param {object} opts.headMatrix Matrix JSON on the working tree.
 * @returns {{ errors: string[]; waived: boolean }} Remaining errors and whether a floor waiver applied.
 */
export function ratchetFloors({ baseFloors, headFloors, baseMatrix, headMatrix }) {
  const floors = diffCoverageFloors(baseFloors, headFloors);
  const mins = diffMinimumTests(baseMatrix, headMatrix);
  const errors = [...floors, ...mins];
  const waived =
    errors.length > 0 &&
    headFloors &&
    typeof headFloors === 'object' &&
    typeof (/** @type {{ approvedDeviation?: string }} */ (headFloors).approvedDeviation) ===
      'string' &&
    /** @type {{ approvedDeviation: string }} */ (headFloors).approvedDeviation.trim().length > 0;
  // Floor decreases require a top-level approvedDeviation; minimumTests each carry their own marker.
  const floorOnly = floors.length > 0 && mins.length === 0;
  if (floorOnly && waived) return { errors: [], waived: true };
  if (floors.length > 0 && waived) {
    // Waive only floors; still report minimumTests drops.
    return { errors: mins, waived: true };
  }
  return { errors, waived: false };
}

function readJsonAt(ref, relPath) {
  try {
    const raw = execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
  const out = { base: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) {
      out.base = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      out.help = true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/test-report/ratchet-floors.mjs [--base <ref>]');
    process.exit(0);
  }
  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.warn('ratchet-floors: no merge base found; skipping (local only)');
    process.exit(0);
  }

  const floorsPath = 'tests/coverage-floors.json';
  const matrixPath = 'tests/matrix.json';
  const headFloors = JSON.parse(readFileSync(path.join(root, floorsPath), 'utf8'));
  const headMatrix = JSON.parse(readFileSync(path.join(root, matrixPath), 'utf8'));
  const baseFloors = readJsonAt(baseRef, floorsPath);
  const baseMatrix = readJsonAt(baseRef, matrixPath);

  if (!baseFloors || !baseMatrix) {
    console.warn(`ratchet-floors: ${floorsPath} or ${matrixPath} missing on ${baseRef}; skipping`);
    process.exit(0);
  }

  const { errors } = ratchetFloors({ baseFloors, headFloors, baseMatrix, headMatrix });
  if (errors.length) {
    console.error(`ratchet-floors: floors may only move upward (base ${baseRef})`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      'To lower a floor deliberately, set approvedDeviation on coverage-floors.json or approvedMinimumTestsDeviation on the flow (constitutional exception).',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`ratchet-floors: ok (no decreases vs ${baseRef})`);
}

const isMain =
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
