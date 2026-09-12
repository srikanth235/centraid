// The commit-subject law, in commitlint's shape (#1005).
//
// commitlint is NOT installed and is not run: its API is asynchronous and an
// ESLint rule is synchronous, so the two cannot be composed. What is borrowed
// is the *config shape* — `rules: { name: [level, applicability, value] }` —
// because it is the one vocabulary every contributor and every editor plugin
// already reads for this question, and because writing the policy in a shape
// somebody else's tool understands keeps the door open to running that tool.
//
// `.governance/law/rules/commit-message-format.ts` reads this file and applies
// the three rules below to every commit in the arrival record and to the
// pending message.
export default {
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "build", "ci", "revert", "style"],
    ],
    "header-max-length": [2, "always", 100],
    // Not a commitlint rule: this repo additionally requires the GitHub issue
    // the commit answers to, at the end of the subject. Kept in the same shape
    // so the whole policy is readable in one place.
    "issue-ref": [2, "always", "\\(#[1-9][0-9]*\\)"],
  },
  // Subjects the shell directive skipped, and why. Merge and revert subjects
  // are git's own wording; the autosquash prefixes are rebase scaffolding.
  ignores: ["^Merge ", '^Revert "', "^fixup! ", "^squash! ", "^amend! "],
  // Bot authors have conventions of their own that this repo does not control.
  ignoreAuthors: ["dependabot", "renovate", "[bot]@"],
  waiverToken: "allow-commit-message-format",
};
