#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export const DEFER_MARKER = "<!-- mutation-pr-deferred -->";

export const DEFAULT_CAP_MS = 480_000;

export function resolveCapMs(flags, env) {
  const raw = flags?.cap ?? env.MUTATION_PR_CAP_MS ?? null;
  if (raw == null || raw === "") return DEFAULT_CAP_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `mutation-cap: cap must be a positive number of milliseconds, got \`${raw}\``
    );
  }
  return value;
}

export function casesFor({ capped, exitCode, durationMs }) {
  if (capped) {
    return [
      {
        id: "deferred",
        verdict: "skipped",
        durationMs: Math.round(durationMs),
        attempts: 1,
      },
    ];
  }
  return [
    {
      id: "affected-seeds",
      verdict: exitCode === 0 ? "passed" : "failed",
      durationMs: Math.round(durationMs),
      attempts: 1,
    },
  ];
}

export function deferComment({ capMs, durationMs, runUrl }) {
  return [
    DEFER_MARKER,
    "### Per-PR mutation deferred to the candidate",
    "",
    `This PR's affected mutation seeds ran past the rung-2 cap of ${Math.round(capMs / 1000)}s (stopped at ${Math.round(durationMs / 1000)}s), so the lane stopped and handed the question to rung 3.`,
    "",
    "**Nothing is skipped.** `candidate.yml` → `mutation-full` runs every seed with floors enforced on the merge commit, and a regression there files a rolling issue against the one commit that caused it. What you lose by merging now is the answer arriving *before* the merge rather than minutes after it; what you gain is a PR gate with a predictable ceiling.",
    "",
    `Run: ${runUrl || "(unknown)"}`,
    "",
    "_This comment is rewritten in place on every push — there is only ever one of it._",
  ].join("\n");
}

export function findMarkedCommentId(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  const first = trimmed.split("\n")[0].trim();
  return /^\d+$/u.test(first) ? first : null;
}

function parseArgs(argv) {
  const out = { cap: null, script: "test:mutation:pr" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cap-ms" && argv[i + 1]) out.cap = argv[++i];
    else if (argv[i] === "--script" && argv[i + 1]) out.script = argv[++i];
  }
  return out;
}

function commentOnPr(body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.CENTRAID_PR_NUMBER;
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !repo || !prNumber) {
    console.log(
      "mutation-cap: not a pull_request event (or no PR number) — skipping the deferral comment"
    );
    return;
  }
  const gh = (args) => spawnSync("gh", args, { encoding: "utf8", cwd: root });
  const listed = gh([
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    `[.[] | select(.body | contains("${DEFER_MARKER}")) | .id] | .[0] // empty`,
  ]);
  const existing =
    listed.status === 0 ? findMarkedCommentId(listed.stdout) : null;
  const result = existing
    ? gh([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${existing}`,
        "-f",
        `body=${body}`,
      ])
    : gh([
        "api",
        `repos/${repo}/issues/${prNumber}/comments`,
        "-f",
        `body=${body}`,
      ]);
  if (result.status !== 0) {
    console.error(
      `::warning title=mutation-pr deferral comment failed::${(result.stderr ?? "").trim()}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const capMs = resolveCapMs(args, process.env);
  const startedAt = Date.now();

  const child = spawn("bun", ["run", args.script], {
    cwd: root,
    stdio: "inherit",
  });
  let capped = false;
  const timer = setTimeout(() => {
    capped = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
  }, capMs);

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(`::error title=mutation-cap::${error.message}`);
      resolve(1);
    });
  });
  clearTimeout(timer);
  const durationMs = Date.now() - startedAt;

  const casesPath = path.join(root, "artifacts/mutation-cap/cases.json");
  mkdirSync(path.dirname(casesPath), { recursive: true });
  writeFileSync(
    casesPath,
    `${JSON.stringify(casesFor({ capped, exitCode, durationMs }), null, 2)}\n`
  );

  if (!capped) {
    process.exitCode = exitCode;
    return;
  }

  console.log(
    "::notice::mutation-pr deferred to rung 3 (candidate mutation-full)"
  );
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "";
  commentOnPr(deferComment({ capMs, durationMs, runUrl }));
  process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
