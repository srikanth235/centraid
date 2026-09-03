#!/usr/bin/env node
import { execFileSync } from "node:child_process";

export const CANDIDATE_REF = "refs/candidates/latest";

export function readCandidatePointer(run) {
  let stdout;
  try {
    stdout = run("git", ["ls-remote", "origin", CANDIDATE_REF]);
  } catch {
    return null;
  }
  const sha = (stdout ?? "").trim().split(/\s+/u)[0] ?? "";
  return /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
}

export function judgeCandidate({ head, candidate, allowUncandidated, reason }) {
  if (candidate && head === candidate) {
    return {
      ok: true,
      message: `release-guard: ${head} is the promoted candidate (${CANDIDATE_REF})`,
    };
  }
  if (allowUncandidated) {
    return {
      ok: true,
      message: `release-guard: OVERRIDDEN with --allow-uncandidated. ${head} is not ${CANDIDATE_REF}${candidate ? ` (which is ${candidate})` : " (no candidate has ever been promoted)"}. Reason given: ${reason?.trim() || "(none given — say why in the receipt)"}`,
    };
  }
  if (!candidate) {
    return {
      ok: false,
      message: `release-guard: no candidate has ever been promoted, so nothing is releasable yet. \`candidate.yml\` moves ${CANDIDATE_REF} on every green push to main; wait for one, or pass --allow-uncandidated with a reason.`,
    };
  }
  return {
    ok: false,
    message: `release-guard: HEAD is ${head}, but the promoted candidate is ${candidate}. Releases ship builds rung 3 promoted and rungs 4-5 tested — otherwise the release lanes only prove the tree BUILDS, which they would have done for a broken commit too. Release the candidate, wait for HEAD to be promoted, or pass --allow-uncandidated with a reason.`,
  };
}

export function assertHeadIsCandidate({
  argv,
  run = (file, args) => execFileSync(file, args, { encoding: "utf8" }),
  exit = (code) => process.exit(code),
}) {
  const allowIndex = argv.indexOf("--allow-uncandidated");
  const allowUncandidated = allowIndex !== -1;
  const reason =
    allowUncandidated &&
    argv[allowIndex + 1] &&
    !argv[allowIndex + 1].startsWith("--")
      ? argv[allowIndex + 1]
      : process.env.CENTRAID_UNCANDIDATED_REASON;
  let head = "(unknown)";
  try {
    head = run("git", ["rev-parse", "HEAD"]).trim() || head;
  } catch {
    head = "(unknown)";
  }
  const verdict = judgeCandidate({
    head,
    candidate: readCandidatePointer(run),
    allowUncandidated,
    reason,
  });
  if (!verdict.ok) {
    console.error(verdict.message);
    exit(1);
    return verdict;
  }
  console.error(verdict.message);
  return verdict;
}
