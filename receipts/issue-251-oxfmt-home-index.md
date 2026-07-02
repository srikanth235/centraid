# Issue #251 — style: oxfmt the home-site index.html

GitHub issue: [#251](https://github.com/srikanth235/centraid/issues/251)

`scripts/home-site/public/index.html` was committed unformatted in #248, so the
repo-wide `oxfmt --check .` (`bun run format:check`) fails — `main` and every PR
branch inherit a red `check` CI job. This reformats the one offending file with
the repo's own formatter so CI goes green. Landed as its own commit, separate
from the audit-pack update (#249) it was discovered alongside.

## Checklist

- [x] Reformat scripts/home-site/public/index.html with oxfmt
- [x] Confirm bun run format:check passes across the repo
- [x] Confirm the change is formatting-only (no content change)

## What changed

**Reformat scripts/home-site/public/index.html with oxfmt.** Ran the repo's
formatter (`oxfmt scripts/home-site/public/index.html`, the write form of the
`format` npm script) over the single file. The change is large in line count
(~820 insertions / ~360 deletions) but every hunk is one of oxfmt's cosmetic
normalizations: re-indenting the `<head>`/`<style>`/`<body>` tree to the
two-space scheme, wrapping long `<link>`/element attribute lists across lines,
lowercasing hex color literals (`#3EC8B4` → `#3ec8b4`), normalizing CSS string
quotes (`"…"` → `'…'`), and canonicalizing CSS numbers (leading zero added,
`.6s` → `0.6s`; trailing zero trimmed, `0.30` → `0.3`).

**Confirm the change is formatting-only (no content change).** No text content,
tag structure, CSS rule set, or script logic changed — only the formatter's
whitespace, quote-style, hex-case, and numeric-literal canonicalizations, all of
which are semantically identical to the browser. The proof is idempotency: the
file is now in oxfmt's canonical form, so `oxfmt --check .` passes and re-running
`oxfmt` produces no further change.

## Decisions

- **Fixed in this branch rather than a standalone PR.** The red `check` job was
  surfaced by this branch's CI (PR #250) even though the offending file predates
  the branch; the maintainer asked to green CI here, so the fix rides along as a
  distinct commit rather than a separate PR. Kept it in its own commit (not
  folded into the #249 audit-pack change) so the two concerns stay reviewable
  apart.
- **Used the repo formatter verbatim, accepted its full output.** `oxfmt` is the
  tool `format:check` gates on, so its output is correct by definition; the large
  line delta is the cost of the file having been committed unformatted, not a
  sign of a semantic edit.

## Out of scope

- **The audit-pack update (#249).** Unrelated concern; committed separately on
  this same branch.
- **Any other unformatted files.** `oxfmt --check .` reported only this one file;
  no other formatting drift was touched.
- **Why #248 landed it unformatted.** Not investigated here — the fix is
  forward-only; a pre-commit/CI ordering gap (if any) is a separate question.

## Verification

```sh
# Reformat scripts/home-site/public/index.html with oxfmt
bunx oxfmt scripts/home-site/public/index.html

# Confirm bun run format:check passes across the repo
bun run format:check
#   All matched files use the correct format.  (510 files)

# Confirm the change is formatting-only (no content change): re-running the
# formatter is a no-op, i.e. the file is already canonical — the diff was
# entirely oxfmt normalizations, nothing hand-authored.
bunx oxfmt scripts/home-site/public/index.html && git diff --quiet -- scripts/home-site/public/index.html \
  && echo "idempotent: oxfmt produces no further change"
#   idempotent: oxfmt produces no further change
```

## Audit

Fresh-context sub-agent audit against the staged diff and issue #251.

1. **PASS** — '## What changed' matches the diff exactly: after stripping whitespace, lowercasing, and unifying quotes, a character-level word-diff of HEAD vs. staged shows zero alphabetic additions/removals; the only changes are numeric-zero canonicalizations (45 `+0`, e.g. `.6s`→`0.6s`, `0.30`→`0.3`) plus minor CSS punctuation, exactly the re-indent / attribute-wrap / hex-lowercase / quote / number normalizations described. No omission or misrepresentation.
2. **PASS** — each '- [x]' is realized: the diff reformats `scripts/home-site/public/index.html` (item 1); `#3EC8B4` is lowercased to `#3ec8b4` with zero uppercase hex remaining and the change is purely cosmetic (items 2 and 3, evidenced by the no-alphabetic-change proof and the receipt's idempotency check).
3. **PASS** — the '## Checklist' mirrors issue #251 verbatim: "Reformat scripts/home-site/public/index.html with oxfmt", "Confirm bun run format:check passes across the repo", "Confirm the change is formatting-only (no content change)" — same three items, in order.

Verdict: PASS

## Steering

Fresh-context sub-agent steering audit of session 43eec44a over the transcript.

Scanned all 366 records: no `[Request interrupted by user]` markers exist and no user message redirects or corrects the agent mid-task. The four user text messages ("update core pack", the create-pr command, "why CI failed", "fix the issue please here...need green CI") each arrived while the agent was idle after reporting completion — they are the initial task plus ordinary follow-up requests, not interrupts or corrections. Zero steering rows written.

Verdict: PASS

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-43eec44a-eed-1782972473-1 | claude-code | 43eec44a-eed3-44a5-a168-8d8b90666e07 | #251 | claude-opus-4-8 | 12371 | 64681 | 8644643 | 56335 | 133387 | 6.1968 | 41558 | 540492 | 22259211 | 177999 | style(home): oxfmt scripts/home-site/public/index.html (#251) -m The file was co |
