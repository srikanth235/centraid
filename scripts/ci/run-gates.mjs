#!/usr/bin/env node
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

const args = process.argv.slice(2);
const gates = args.filter((a) => !a.startsWith("--"));
const jobsFlag = args.find((a) => a.startsWith("--jobs="));
const jobs = jobsFlag
  ? Number(jobsFlag.slice("--jobs=".length))
  : Math.max(2, Math.min(4, availableParallelism() - 2));

if (gates.length === 0) {
  process.stderr.write("run-gates: no gates given\n");
  process.exit(2);
}

const started = Date.now();
const results = [];
let cursor = 0;
let running = 0;

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

function pump(resolveAll) {
  while (running < jobs && cursor < gates.length) {
    const name = gates[cursor++];
    running += 1;
    runOne(name).then((res) => {
      running -= 1;
      results.push(res);
      const mark = res.code === 0 ? "✓" : "✗";
      process.stderr.write(
        `  ${mark} ${res.name.padEnd(26)} ${secs(res.ms).padStart(6)}s  ` +
          `(${results.length}/${gates.length})\n`
      );
      if (results.length === gates.length) resolveAll();
      else pump(resolveAll);
    });
  }
}

process.stderr.write(`▶ ${gates.length} gates, ${jobs} at a time\n`);
await new Promise((resolve) => {
  pump(resolve);
});

const failed = results.filter((r) => r.code !== 0);
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);

for (const f of failed) {
  process.stderr.write(`\n${"─".repeat(70)}\n✗ ${f.name}\n${"─".repeat(70)}\n`);
  process.stderr.write(f.out.trimEnd() + "\n");
}

process.stderr.write(
  `\n${failed.length === 0 ? "✓" : "✗"} ${results.length - failed.length}/${
    results.length
  } gates passed in ${secs(Date.now() - started)}s` +
    ` — slowest: ${slowest.map((r) => `${r.name} ${secs(r.ms)}s`).join(", ")}\n`
);

if (failed.length > 0) {
  process.stderr.write(
    `\nFailed: ${failed.map((f) => f.name).join(", ")}\n` +
      `Re-run one with: bun run <gate>\n`
  );
  process.exit(1);
}
