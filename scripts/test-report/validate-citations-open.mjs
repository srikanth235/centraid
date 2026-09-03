import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export const REPO = "srikanth235/centraid";

const TRACKING_PHRASE = /\btracked\s+(?:under|gap)\s*\(?\s*#(?<issue>\d+)/giu;

const REGISTRY_KEYS = new Set(["trackingIssues"]);

function addCitation(citations, issue, where) {
  const number = Number(issue);
  if (!Number.isInteger(number) || number < 1) return;
  if (!citations.has(number)) citations.set(number, []);
  citations.get(number).push(where);
}

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

export function declaredOpenIssues(matrix) {
  return Object.entries(matrix?.trackingIssues ?? {})
    .filter(([, record]) => record?.state === "open")
    .map(([issue]) => Number(issue))
    .filter((issue) => Number.isInteger(issue) && issue > 0)
    .sort((a, b) => a - b);
}

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

export const LEDGERS = [
  "tests/claims.json",
  "tests/inventory.json",
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
    matrix: sources["tests/claims.json"],
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
