#!/usr/bin/env node
// The rung-1 product/contract bundle (#915 Wave 4).
//
// `check:push` listed 59 gate names. Thirty-eight of them run in under a
// second each and exist only because a gate needs a name in package.json —
// they are not thirty-eight decisions a developer makes, they are one:
// "does this diff satisfy the repo's contracts?". Naming them individually
// cost the reader a 59-line command and cost the runner thirty-eight
// concurrency slots that the long poles wanted.
//
// So they collapse into one name, `lint:product`, run here at full machine
// parallelism (they are tiny single-threaded node processes; the pool that
// runs `check:push` is deliberately capped at four because several of ITS
// members are themselves parallel).
//
// WHAT THIS DELIBERATELY DOES NOT DO: import each gate's module and call an
// exported check function in-process. Every one of these scripts is a CLI
// whose work runs behind an `import.meta.filename` main guard and ends in
// `process.exit`, so hosting them in one process means monkey-patching
// `process.exit` and `process.argv` per gate. A bundle that swallows one
// gate's failure is strictly worse than the ~3 seconds it saves, and
// `check:push`'s wall clock is bounded by `test:affected` either way — the
// win this bundle exists for is the name count, not the clock. Each gate is
// therefore spawned exactly as `check:push` used to spawn it (`bun run
// <gate>`), with the same per-gate buffered output, so failure attribution is
// bit-identical to what `scripts/ci/run-gates.mjs` reported before.
//
// The membership list is a contract: `scripts/ci/gate-classes.json` classifies
// every gate, and `scripts/ci/gate-classes.test.mjs` fails if a member is
// unclassified, is hygiene-class (those belong to the weekly lane), or is also
// named separately in `check:push`.
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

/**
 * The bundle's membership. Ordered longest-first the way `run-gates.mjs`
 * orders its own list, so the pool starts the slowest members while the
 * shorter ones fill in behind them.
 */
export const PRODUCT_GATES = Object.freeze([
  "test:ratchet",
  "lint:engine-conformance",
  "test:advisory-expiry",
  "lint:law-registry",
  "lint:ledgers",
  "lint:test-reachability",
  "lint:tsconfigs",
  "test:accessibility",
  "lint:mobile-design",
  "lint:css",
  "security:lifecycle",
  "lint:container-opacity",
  "lint:hairline",
  "lint:design-md",
  "lint:aria-labels",
  "lint:site-tokens",
  "lint:motion-rule",
  "lint:quality-knobs",
  "lint:design-tokens",
  "lint:mobile-testids",
  "lint:logical-insets",
  "check:mobile-suite-budgets",
  "check:ui-receipt",
  "lint:turbo-cache",
  "lint:path-filters",
  "lint:e2e-flows",
  "lint:e2e-wiring",
  "lint:e2e-claims",
  "lint:seat-verbs",
  "check:na-cells",
  "lint:list-anchoring",
  "lint:app-conformance",
  "lint:protocol-routes",
  "lint:acp-min-versions",
  "lint:packages",
  "lint:node-version",
  "test:quarantine",
  "lockfile:lint",
  "security:unsafe-edges",
  "lint:ci-egress",
  "lint:no-nul-bytes",
]);

const secs = (ms) => (ms / 1000).toFixed(1);

/**
 * Spawn one root package script, buffering its output.
 * @param {string} name The root package script to run, e.g. `lint:hairline`.
 * @returns {Promise<{name: string, code: number, ms: number, out: string}>} The gate's exit code, wall clock, and combined output.
 */
function runOne(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("bun", ["run", name], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    /** @type {Buffer[]} */
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    child.on("error", (err) => {
      resolve({ name, code: 1, ms: Date.now() - t0, out: String(err) });
    });
    child.on("close", (code) => {
      resolve({
        name,
        code: code ?? 1,
        ms: Date.now() - t0,
        out: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

/**
 * Run every named gate at bounded concurrency, printing a progress line per
 * gate and the full buffered output of each failure at the end. Every gate
 * runs even after one fails: one pass tells you everything that is wrong.
 *
 * @param {readonly string[]} names The gates to run, longest-first.
 * @param {{jobs?: number, label?: string, write?: (s: string) => void, run?: typeof runOne}} [options] Pool size, the noun used in progress lines, the sink for those lines, and the gate runner (injected by the tests).
 * @returns {Promise<{results: Array<{name: string, code: number, ms: number, out: string}>, failed: string[], ms: number}>} Every gate's result, the names that failed, and the lane's wall clock.
 */
export async function runGates(names, options = {}) {
  const write = options.write ?? ((s) => process.stderr.write(s));
  const run = options.run ?? runOne;
  const label = options.label ?? "gates";
  const jobs = Math.max(1, options.jobs ?? Math.max(2, availableParallelism()));
  const started = Date.now();
  /** @type {Array<{name: string, code: number, ms: number, out: string}>} */
  const results = [];
  let cursor = 0;
  let running = 0;

  write(`▶ ${names.length} ${label}, ${jobs} at a time\n`);
  if (names.length > 0) {
    await new Promise((resolve) => {
      const pump = () => {
        while (running < jobs && cursor < names.length) {
          const name = names[cursor++];
          running += 1;
          run(name).then((res) => {
            running -= 1;
            results.push(res);
            const mark = res.code === 0 ? "✓" : "✗";
            write(
              `  ${mark} ${res.name.padEnd(28)} ${secs(res.ms).padStart(6)}s  (${results.length}/${names.length})\n`
            );
            if (results.length === names.length) resolve();
            else pump();
          });
        }
      };
      pump();
    });
  }

  const failures = results.filter((r) => r.code !== 0);
  for (const f of failures) {
    write(`\n${"─".repeat(70)}\n✗ ${f.name}\n${"─".repeat(70)}\n`);
    write(`${f.out.trimEnd()}\n`);
  }
  const ms = Date.now() - started;
  write(
    `\n${failures.length === 0 ? "✓" : "✗"} ${results.length - failures.length}/${results.length} ${label} passed in ${secs(ms)}s\n`
  );
  if (failures.length > 0) {
    write(
      `\nFailed: ${failures.map((f) => f.name).join(", ")}\nRe-run one with: bun run <gate>\n`
    );
  }
  return { results, failed: failures.map((f) => f.name), ms };
}

if (process.argv[1] === import.meta.filename) {
  const { failed } = await runGates(PRODUCT_GATES, { label: "product gates" });
  if (failed.length > 0) process.exit(1);
}
