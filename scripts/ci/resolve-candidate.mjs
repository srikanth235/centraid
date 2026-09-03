#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

export const CANDIDATE_REF = "refs/candidates/latest";

export function parseLsRemote(stdout) {
  const line = (stdout ?? "").trim().split("\n")[0] ?? "";
  const sha = line.split(/\s+/u)[0] ?? "";
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
}

export function parseLastGreenRun(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const runs = Array.isArray(parsed?.workflow_runs) ? parsed.workflow_runs : [];
  for (const run of runs) {
    if (run?.conclusion !== "success") continue;
    const sha = String(run.head_sha ?? "");
    if (/^[0-9a-f]{40}$/u.test(sha)) return sha;
  }
  return null;
}

export function resolveCandidate({
  ref,
  fallbackSha,
  candidatePointer,
  lastGreenGate,
}) {
  const requested = (ref ?? "").trim();
  if (requested) {
    return {
      source: "dispatch-input",
      sha: requested,
      note: `a \`ref\` input was supplied, so this run tests \`${requested}\` and nothing else was consulted.`,
    };
  }
  const promoted = candidatePointer();
  if (promoted) {
    return {
      source: "candidate-pointer",
      sha: promoted,
      note: `testing the promoted candidate \`${promoted}\` from \`${CANDIDATE_REF}\`.`,
    };
  }
  const green = lastGreenGate();
  if (green) {
    return {
      source: "last-green-ci",
      sha: green,
      note: `no candidate has been promoted yet, so this run falls back to the last green \`ci.yml\` run on main (\`${green}\`). That is a WEAKER claim than a candidate — rung 2 answers a smaller question than rung 3.`,
    };
  }
  return {
    source: "workflow-sha",
    sha: fallbackSha,
    note: `neither a candidate nor a green \`ci.yml\` run could be read, so this run tests the workflow's own SHA (\`${fallbackSha}\`) — the pre-#915 behaviour, announced rather than assumed.`,
  };
}

function parseArgs(argv) {
  const out = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    ref: "",
    fallback: process.env.GITHUB_SHA ?? "",
    gateWorkflow: "ci.yml",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) out.repo = argv[++i];
    else if (argv[i] === "--ref" && argv[i + 1]) out.ref = argv[++i];
    else if (argv[i] === "--fallback-sha" && argv[i + 1])
      out.fallback = argv[++i];
    else if (argv[i] === "--gate-workflow" && argv[i + 1])
      out.gateWorkflow = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveCandidate({
    ref: args.ref,
    fallbackSha: args.fallback,
    candidatePointer: () => {
      const result = spawnSync(
        "git",
        ["ls-remote", "--exit-code", "origin", CANDIDATE_REF],
        { encoding: "utf8" }
      );
      return result.status === 0 ? parseLsRemote(result.stdout) : null;
    },
    lastGreenGate: () => {
      if (!args.repo) return null;
      const result = spawnSync(
        "gh",
        [
          "api",
          `repos/${args.repo}/actions/workflows/${args.gateWorkflow}/runs?branch=main&status=success&per_page=20`,
        ],
        { encoding: "utf8" }
      );
      return result.status === 0 ? parseLastGreenRun(result.stdout) : null;
    },
  });

  const summary = [
    "### Candidate resolution",
    "",
    `**${resolved.sha}** — source \`${resolved.source}\`.`,
    "",
    resolved.note,
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `sha=${resolved.sha}\nsource=${resolved.source}\n`
    );
  }
  if (!resolved.sha) {
    console.error(
      "::error title=No candidate::could not resolve any SHA to test — refusing to run a deep lane against nothing"
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
