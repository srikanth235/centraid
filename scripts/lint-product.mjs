#!/usr/bin/env node
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

export const PRODUCT_GATES = Object.freeze([
  "test:ratchet",
  "lint:engine-conformance",
  "test:advisory-expiry",
  "lint:law-registry",
  "lint:ledgers",
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
]);

const secs = (ms) => (ms / 1000).toFixed(1);

function runOne(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("bun", ["run", name], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
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

export async function runGates(names, options = {}) {
  const write = options.write ?? ((s) => process.stderr.write(s));
  const run = options.run ?? runOne;
  const label = options.label ?? "gates";
  const jobs = Math.max(1, options.jobs ?? Math.max(2, availableParallelism()));
  const started = Date.now();
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
