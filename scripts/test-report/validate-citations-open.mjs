/**
 * The open-citation gate (#864 Wave 0).
 *
 * Every ledger in `tests/` buys a deliberate hole with the same currency: a
 * GitHub issue number. `matrix.json` gaps, revisit triggers, app-seat and
 * app-state gaps, the consent ledger's missing adversaries, the skip budget,
 * the env-red inventory, and the flake quarantine all say "this is unfinished,
 * and #N is where it is being finished." The existing validators already refuse
 * a citation whose issue is CLOSED — but they read that state out of
 * `matrix.trackingIssues`, a hand-maintained snapshot of the world. So the one
 * failure they cannot see is the snapshot going stale: an issue closes on
 * GitHub, nobody edits the ledger, and every gate keeps passing while ~100
 * exceptions cite a dead tracker. That is exactly what happened before this
 * gate existed.
 *
 * This check closes that loop by asking GitHub itself. Two rules:
 *
 *   1. Every CITATION — a `trackingIssue` field anywhere in the matrix, a
 *      "tracked under #N" / "tracked gap (#N" claim in prose, a skip, env-red,
 *      or quarantine `issue` — must name an issue that is still open.
 *   2. Every `trackingIssues` entry that DECLARES `state: "open"` must really
 *      be open, because that declaration is what the offline validators trust.
 *
 * A bare `#N` that is not one of those forms is left alone on purpose: closed
 * issues are legitimate PROVENANCE ("originally #656", "#535 Phase 5", "the
 * ruling that held it"), and a gate that forbade them would push authors to
 * delete history rather than keep it. Only the live-tracking claim is checked.
 *
 * Network-dependent, so it is NIGHTLY-ONLY: the PR lane must not grow a
 * dependency on api.github.com. For the same reason an unreachable API is a
 * HARD FAILURE that says the check did not run — a silent pass here would
 * restore precisely the blind spot the gate exists to remove.
 *
 * Usage:  GITHUB_TOKEN=… node scripts/test-report/validate-citations-open.mjs
 * Exit:   0 clean, 1 on a closed citation, a stale ledger state, or an
 *         unreachable API.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export const REPO = "srikanth235/centraid";

/**
 * The prose forms that make a live tracking CLAIM, as opposed to provenance.
 * "Tracked under #864", "tracked gap (#864, originally #656)", "Remaining
 * depth tracked under #864" all match; "originally #656" does not.
 */
const TRACKING_PHRASE = /\btracked\s+(?:under|gap)\s*\(?\s*#(?<issue>\d+)/giu;

/** Blocks of the matrix that are a REGISTRY of issues, not citations of them. */
const REGISTRY_KEYS = new Set(["trackingIssues"]);

function addCitation(citations, issue, where) {
  const number = Number(issue);
  if (!Number.isInteger(number) || number < 1) return;
  if (!citations.has(number)) citations.set(number, []);
  citations.get(number).push(where);
}

/**
 * Walk one parsed ledger and collect every live-tracking citation in it.
 * Structural (`trackingIssue`, `issue`) and prose (`tracked under #N`) forms
 * are collected by shape rather than by an enumerated list of paths, so a new
 * grid added to the matrix is covered the day it lands instead of the day
 * someone remembers to extend this file. Pure.
 *
 * @param {unknown} node parsed JSON
 * @param {string} where dotted path of `node`, used verbatim in failures
 * @param {Map<number, string[]>} citations accumulator: issue -> citation sites
 * @returns {Map<number, string[]>} the same accumulator
 */
export function collectCitations(node, where, citations = new Map()) {
  if (typeof node === "string") {
    for (const match of node.matchAll(TRACKING_PHRASE))
      addCitation(citations, match.groups.issue, where);
    return citations;
  }
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries())
      collectCitations(child, `${where}[${child?.id ?? index}]`, citations);
    return citations;
  }
  if (!node || typeof node !== "object") return citations;
  for (const [key, value] of Object.entries(node)) {
    if (REGISTRY_KEYS.has(key)) continue;
    const childPath = `${where}.${key}`;
    if (key === "trackingIssue" || key === "issue")
      addCitation(citations, value, childPath);
    else collectCitations(value, childPath, citations);
  }
  return citations;
}

/**
 * The `trackingIssues` entries that CLAIM to be open. These are not citations,
 * but every offline validator reads its notion of "still open" from them, so a
 * stale entry silently re-opens the hole this gate closes.
 *
 * @param {object} matrix parsed tests/matrix.json
 * @returns {number[]} issue numbers declared open, ascending
 */
export function declaredOpenIssues(matrix) {
  return Object.entries(matrix?.trackingIssues ?? {})
    .filter(([, record]) => record?.state === "open")
    .map(([issue]) => Number(issue))
    .filter((issue) => Number.isInteger(issue) && issue > 0)
    .sort((a, b) => a - b);
}

/**
 * Resolve each issue's state through the REST API. `fetchImpl` is injected so
 * the gate's own tests drive every branch — open, closed, transport failure,
 * non-200 — without a network.
 *
 * @param {number[]} issues issue numbers to resolve
 * @param {{ fetchImpl: typeof fetch, token: string, repo?: string }} options injected fetch, the API token, and the repository to ask
 * @returns {Promise<{ states: Map<number, string>, unreachable: Array<{ issue: number, reason: string }> }>} resolved states, plus the issues the API could not answer for
 */
export async function resolveIssueStates(
  issues,
  { fetchImpl, token, repo = REPO }
) {
  const states = new Map();
  const unreachable = [];
  const resolved = await Promise.all(
    issues.map(async (issue) => {
      const url = `https://api.github.com/repos/${repo}/issues/${issue}`;
      try {
        const response = await fetchImpl(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "centraid-citation-gate",
          },
        });
        if (!response.ok)
          return { issue, reason: `HTTP ${response.status} from ${url}` };
        const body = await response.json();
        if (typeof body?.state !== "string")
          return { issue, reason: `${url} returned no issue state` };
        return { issue, state: body.state };
      } catch (error) {
        return { issue, reason: `${url} — ${error?.message ?? error}` };
      }
    })
  );
  for (const entry of resolved) {
    if (entry.state) states.set(entry.issue, entry.state);
    else unreachable.push({ issue: entry.issue, reason: entry.reason });
  }
  return { states, unreachable };
}

/**
 * Turn resolved states into failures. Pure, so the message a human reads on a
 * red nightly is itself unit-tested.
 *
 * @param {{ citations: Map<number, string[]>, declaredOpen: number[], states: Map<number, string>, unreachable: Array<{ issue: number, reason: string }> }} input the collected citations, the ledger's open claims, and what the API answered
 * @returns {string[]} one error per stale citation or unresolved issue
 */
export function reportCitationErrors({
  citations,
  declaredOpen,
  states,
  unreachable,
}) {
  const errors = [];
  for (const { issue, reason } of unreachable)
    errors.push(
      `could not resolve issue #${issue} (${reason}); the open-citation check did NOT run — fix the API access and re-run rather than treating this as a pass`
    );
  for (const issue of [...citations.keys()].sort((a, b) => a - b)) {
    if (states.get(issue) !== "closed") continue;
    errors.push(
      `citation #${issue} is CLOSED but still marks a live exception at ${citations
        .get(issue)
        .sort()
        .join(", ")}; re-home it to the successor umbrella or reopen #${issue}`
    );
  }
  for (const issue of declaredOpen) {
    if (states.get(issue) !== "closed") continue;
    errors.push(
      `matrix.trackingIssues #${issue} declares state "open" but the issue is CLOSED; every offline validator trusts that field, so correct it to "closed" and re-home whatever cites it to the successor umbrella`
    );
  }
  return errors;
}

/**
 * The whole gate over already-parsed inputs. Separated from `main` so the tests
 * exercise the real control flow (including the missing-token refusal) without
 * touching the filesystem or the network.
 *
 * @param {{ sources: Record<string, object>, matrix: object, token?: string, fetchImpl?: typeof fetch, repo?: string }} options the parsed ledgers keyed by path, the matrix, the API token, and an optional injected fetch
 * @returns {Promise<{ errors: string[], checked: number }>} the failures to print and how many issues were resolved
 */
export async function validateOpenCitations({
  sources,
  matrix,
  token,
  fetchImpl,
  repo = REPO,
}) {
  if (typeof token !== "string" || !token.trim())
    return {
      errors: [
        "GITHUB_TOKEN is not set, so issue state cannot be read and the open-citation check did NOT run. Export a token with `repo` (or public_repo) read scope — in GitHub Actions pass the workflow's secrets.GITHUB_TOKEN into this step's env; locally use `GITHUB_TOKEN=$(gh auth token)`.",
      ],
      checked: 0,
    };
  const citations = new Map();
  for (const [name, parsed] of Object.entries(sources))
    collectCitations(parsed, name, citations);
  const declaredOpen = declaredOpenIssues(matrix);
  const issues = [...new Set([...citations.keys(), ...declaredOpen])].sort(
    (a, b) => a - b
  );
  const { states, unreachable } = await resolveIssueStates(issues, {
    fetchImpl: fetchImpl ?? fetch,
    token,
    repo,
  });
  return {
    errors: reportCitationErrors({
      citations,
      declaredOpen,
      states,
      unreachable,
    }),
    checked: issues.length,
  };
}

/** The ledgers this gate reads, relative to the repository root. */
export const LEDGERS = [
  "tests/matrix.json",
  "tests/skips.json",
  "tests/env-red.json",
  "tests/quarantine.json",
];

async function main() {
  const parsed = await Promise.all(
    LEDGERS.map(async (file) =>
      JSON.parse(await readFile(path.join(root, file), "utf8"))
    )
  );
  const sources = Object.fromEntries(
    LEDGERS.map((file, index) => [file, parsed[index]])
  );
  const { errors, checked } = await validateOpenCitations({
    sources,
    matrix: sources["tests/matrix.json"],
    token: process.env.GITHUB_TOKEN,
  });
  if (errors.length) {
    for (const error of errors) console.error(`citations: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `citations: ${checked} cited issues resolved against ${REPO}; every live exception cites an open issue`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
