#!/usr/bin/env node
/**
 * "We only ship a build somebody promoted" (#915 Wave 1).
 *
 * Release SHA selection used to be implicit: whatever `HEAD` happened to be
 * when `publish.mjs` ran. Nothing in the chain resolved a SHA, nothing checked
 * one, and so a tag could be cut on a commit that no deep rung had ever
 * exercised — the release would be green, because every release lane BUILDS the
 * tree rather than testing it.
 *
 * Rung 3 (`candidate.yml`) publishes `refs/candidates/latest` on every green
 * promotion. This is the guard that reads it, and it is enforced in three
 * places so the answer arrives as early as possible:
 *
 *   prepare.mjs               before anything is versioned — the useful one
 *   classify.mjs --require-candidate   for a caller that only classifies
 *   release.yml `require-candidate`    the backstop, after the tag exists
 *
 * The escape is `--allow-uncandidated`, and it PRINTS THE REASON it was used.
 * A hatch that leaves no trace is a hatch nobody can audit later.
 */
import { execFileSync } from "node:child_process";

/** The ref rung 3 moves on every green promotion. */
export const CANDIDATE_REF = "refs/candidates/latest";

/**
 * Read `refs/candidates/latest` from the remote.
 *
 * @param {(file: string, args: string[]) => string} run Command runner, injected for tests.
 * @returns {string|null} The promoted SHA, or null when the ref does not exist.
 */
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

/**
 * Decide whether a SHA may be released.
 *
 * Pure: the caller supplies the two facts, so the decision and its message can
 * be tested without a network or a repo.
 *
 * @param {{head: string, candidate: string|null, allowUncandidated: boolean, reason?: string}} input Facts.
 * @returns {{ok: boolean, message: string}} Verdict and the line to print.
 */
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

/**
 * Enforce the guard, exiting the process on refusal.
 *
 * @param {{argv: string[], run?: (file: string, args: string[]) => string, exit?: (code: number) => void}} options CLI arguments and injectable effects.
 * @returns {{ok: boolean, message: string}} The verdict, for callers that continue.
 */
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
  // An unreadable HEAD (a fresh fixture repo with no commits, say) is not a
  // candidate either — it is reported as such rather than crashing, because a
  // guard that throws is indistinguishable from a guard that is broken.
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
