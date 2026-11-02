/**
 * Release facts derived from commit subjects (there is no CHANGELOG file).
 *
 * Every commit subject reads `type(scope)!: subject (#N)` (`.githooks/commit-msg`).
 * The bump and the GitHub Release body are both pure functions over the commits
 * since the last `v*` tag; only `commitsSinceLastTag` touches git.
 */
import { execFileSync } from "node:child_process";

const SUBJECT =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<text>.+?)(?: \(#(?<issue>[1-9]\d*)\))?$/u;

/**
 * @typedef {string | { subject: string, body?: string }} CommitInput
 * @typedef {{ type: string, scope: string | null, text: string, issue: string | null, breaking: boolean }} ParsedCommit
 */

/**
 * Parse one commit. Unconventional subjects (merge, fixup), reverts and the
 * release commit itself are not releasable and yield null.
 * @param {CommitInput} input One commit subject, or subject plus body.
 * @returns {ParsedCommit | null} The parsed commit, or null when not releasable.
 */
export function parseCommit(input) {
  const subject = (typeof input === "string" ? input : input.subject).trim();
  const body = typeof input === "string" ? "" : (input.body ?? "");
  const m = SUBJECT.exec(subject);
  if (!m?.groups) return null;
  const { type, scope, bang, text, issue } = m.groups;
  if (type === "revert" || (type === "chore" && scope === "release")) {
    return null;
  }
  return {
    type,
    scope: scope ?? null,
    text,
    issue: issue ?? null,
    breaking: Boolean(bang) || /^BREAKING[ -]CHANGE:/mu.test(body),
  };
}

/**
 * Bump for a set of commits: any `feat` is a minor, otherwise a patch. A
 * breaking marker never picks major (agents never choose major before 1.0);
 * it is only reported. No releasable commits means not a candidate.
 * @param {CommitInput[]} commits Commits since the last tag.
 * @returns {{ bump: "patch" | "minor" | null, candidate: boolean, rationale: string, breaking: boolean, count: number }} Bump, candidacy and why.
 */
export function classifyBump(commits) {
  const parsed = commits.map(parseCommit).filter((c) => c !== null);
  if (parsed.length === 0) {
    return {
      bump: null,
      candidate: false,
      rationale: "no releasable commits since the last tag; not a candidate",
      breaking: false,
      count: 0,
    };
  }
  const breaking = parsed.some((c) => c.breaking);
  const feats = parsed.filter((c) => c.type === "feat").length;
  const note = breaking
    ? "; breaking marker present, but major is a human decision"
    : "";
  return {
    bump: feats > 0 ? "minor" : "patch",
    candidate: true,
    rationale:
      (feats > 0
        ? `${feats} feat commit(s) → minor`
        : "no feat commits → patch") + note,
    breaking,
    count: parsed.length,
  };
}

const GROUPS = [
  ["Features", (/** @type {ParsedCommit} */ c) => c.type === "feat"],
  ["Fixes", (/** @type {ParsedCommit} */ c) => c.type === "fix"],
  ["Other", () => true],
];

/**
 * GitHub Release body: releasable subjects grouped Features / Fixes / Other,
 * each with its `(#N)`. No releasable commits yields `Centraid <version>`.
 * @param {CommitInput[]} commits Commits since the last tag.
 * @param {string} version Version the notes are for.
 * @returns {string} Markdown release body.
 */
export function releaseNotes(commits, version) {
  const remaining = commits.map(parseCommit).filter((c) => c !== null);
  const sections = [];
  for (const [title, test] of GROUPS) {
    const picked = remaining.filter((c) => test(c));
    for (const c of picked) remaining.splice(remaining.indexOf(c), 1);
    if (picked.length === 0) continue;
    const lines = picked.map((c) => {
      const scope = c.scope ? `**${c.scope}**: ` : "";
      const issue = c.issue ? ` (#${c.issue})` : "";
      return `- ${scope}${c.text}${issue}${c.breaking ? " (breaking)" : ""}`;
    });
    sections.push(`## ${title}\n\n${lines.join("\n")}`);
  }
  return sections.length
    ? `${sections.join("\n\n")}\n`
    : `Centraid ${version}\n`;
}

/**
 * Commits since the newest `v*` tag reachable from HEAD (all history if none).
 * @param {string} cwd Directory inside the repository.
 * @returns {{ subject: string, body: string }[]} Subject and body per commit, newest first.
 */
export function commitsSinceLastTag(cwd) {
  const git = (/** @type {string[]} */ ...a) =>
    execFileSync("git", a, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  /** @type {string[]} */
  let range = [];
  try {
    const tag = git("describe", "--tags", "--abbrev=0", "--match", "v*").trim();
    range = [`${tag}..HEAD`];
  } catch {
    /* no tag yet: all history */
  }
  return git("log", "--no-merges", "--format=%s%x1f%b%x1e", ...range)
    .split("\x1E")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject = "", body = ""] = r.split("\x1F");
      return { subject, body };
    });
}
