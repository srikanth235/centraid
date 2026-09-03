import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const BUDGET_PATH = path.join(root, "tests/experience-budgets/gateway.json");
const HARNESS_PATH = path.join(
  root,
  "packages/server/src/acp/backends/acp/fake-acp-harness.mjs"
);

export function parseArgs(argv) {
  const out = { samples: 25, warmup: 3, report: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--samples" && argv[i + 1]) out.samples = Number(argv[++i]);
    else if (argv[i] === "--warmup" && argv[i + 1])
      out.warmup = Number(argv[++i]);
    else if (argv[i] === "--report") out.report = true;
  }
  return out;
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function summarize(values) {
  return {
    n: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

export function compareToCeiling(p95Ms, metric) {
  const entry = /** @type {Record<string, unknown>} */ (metric ?? {});
  const ceiling = Number(entry.ceilingP95Ms);
  if (!Number.isFinite(ceiling) || ceiling <= 0)
    return {
      ok: false,
      message:
        "send-to-first-token: tests/experience-budgets/gateway.json has no positive `sendToFirstToken.ceilingP95Ms`. A probe that runs against no ceiling is not a gate — seed one from a real run (see this file's header) rather than deleting the step.",
    };
  return {
    ok: p95Ms <= ceiling,
    message:
      p95Ms <= ceiling
        ? `send-to-first-token: p95 ${p95Ms.toFixed(1)}ms of ${ceiling}ms ceiling`
        : `send-to-first-token: p95 ${p95Ms.toFixed(1)}ms exceeds the ${ceiling}ms ceiling. Find what was added between the send and the first token, or widen \`ceilingP95Ms\` in tests/experience-budgets/gateway.json with an \`approvedDeviation\` saying what the extra dead time buys.`,
  };
}

async function sample(runAcpTurn) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "send-to-first-token-"));
  const controller = new AbortController();
  let firstTokenMs = null;
  const started = performance.now();
  await runAcpTurn(
    {
      cwd,
      message: "hello",
      extraSystemPrompt: "",
      abortSignal: controller.signal,
      onEvent: (event) => {
        if (firstTokenMs === null && event?.type === "assistant.delta")
          firstTokenMs = performance.now() - started;
      },
    },
    {
      kind: "acp",
      acpArgs: [],
      binPath: HARNESS_PATH,
      extraArgs: ["--mode=normal"],
      permissionPolicy: "auto-allow",
    }
  );
  if (firstTokenMs === null)
    throw new Error(
      "send-to-first-token: the turn completed without ever emitting an `assistant.delta` — the fixture or the stream translation changed, and a missing measurement must not read as a fast one"
    );
  return firstTokenMs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runAcpTurn } = await import("@centraid/server/acp");
  const driver = /** @type {(i: unknown, c: unknown) => Promise<unknown>} */ (
    runAcpTurn
  );

  await Array.from({ length: args.warmup }).reduce(async (previous) => {
    await previous;
    await sample(driver);
  }, Promise.resolve());

  const values = [];
  await Array.from({ length: args.samples }).reduce(async (previous) => {
    await previous;
    values.push(await sample(driver));
  }, Promise.resolve());
  const stats = summarize(values);

  const line = `send-to-first-token: n=${stats.n} min=${stats.minMs.toFixed(1)}ms median=${stats.medianMs.toFixed(1)}ms p95=${stats.p95Ms.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms (host ${process.platform} ${process.arch}, ${os.cpus().length} cpus)`;

  if (args.report) {
    console.log(line);
    return 0;
  }

  const budget = JSON.parse(await readFile(BUDGET_PATH, "utf8"));
  const verdict = compareToCeiling(
    stats.p95Ms,
    budget?.metrics?.sendToFirstToken
  );
  console.log(line);
  console[verdict.ok ? "log" : "error"](verdict.message);
  return verdict.ok ? 0 : 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) process.exitCode = await main();
