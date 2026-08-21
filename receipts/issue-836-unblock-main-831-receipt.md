# Issue #836 — unblock main: #831's receipt is missing its `## Out of scope` section

GitHub issue: [#836](https://github.com/srikanth235/centraid/issues/836)

`receipt-per-issue` rule 2 is checked on **every tracked receipt**, not only
the ones a change set adds. `receipts/issue-831-clear-four-app-interfaces.md`
merged without `## Out of scope`, so `main` itself is red and every commit
made from a branch off it is blocked before its own work is considered.

## Checklist

- [x] `receipts/issue-831-clear-four-app-interfaces.md` carries an `## Out of scope` section stating what #831 deliberately left untouched
- [x] `bash .governance/run.sh` is green
- [x] No directive, allowlist, budget or config is loosened

## What changed

One section, in one file. `receipts/issue-831-clear-four-app-interfaces.md`
gains the `## Out of scope` section rule 2 requires, placed above its existing
`## Decisions`. Nothing in it is new: each line is drawn from that receipt's own
`## Decisions` and from the commit message of e40f060e — the untouched
`app.json` / `actions/` / `queries/` / `pending-projection.ts` / `seed.js`
graph, the unchanged `app-inline.tsx` descriptors, the rebuild itself
([#834](https://github.com/srikanth235/centraid/issues/834)), and the fact that
no capability was removed. An HTML comment at the head of the section says who
added it and why, so a reader is never left guessing whether the original
author wrote it.

The directive is not touched. **The receipt is what was incomplete, not the
rule** — softening `receipt-per-issue` to accept three sections, or waiving the
file, would have deleted the only mechanical guarantee that a reviewer can tell
an omission from an oversight.

`receipts/issue-836-unblock-main-831-receipt.md` is this issue's own receipt.

## Out of scope

- **Back-filling `## Audit` on #831's receipt.** That rule is change-set-scoped
  by design, and the constitution is explicit that the historical corpus is
  never retroactively swept. #831's receipt predates this change set for every
  rule but the four always-checked sections.
- **Any code, test or configuration change.** The tree is otherwise untouched.
- **A doc-integrity waiver as a general habit.** The path-scoped waiver in the
  commit body names exactly one file, for exactly this repair.

## Decisions

**The frozen-file rule is honoured by naming the exception, not by working
around it.** `receipts/*.md` is a `frozen-files` rule under `doc-integrity`, so
the commit carries `governance: allow-doc-integrity
receipts/issue-831-clear-four-app-interfaces.md …`. The alternative — leaving
the receipt alone and waiving `receipt-per-issue` instead — would have kept the
system of record incomplete forever in exchange for the same green.

**The section is sourced, not invented.** An agent that never worked #831
writing a fresh account of that change would be putting words in the receipt's
mouth. Every bullet restates something already recorded in the same receipt or
in the commit that introduced it, and the inline comment marks the addition.

## Verification

```sh
bash .governance/run.sh
# ✓ receipt-per-issue — 22 directives pass
bun run format:check
```

Demonstrated red, seeded by the state this issue exists to fix: on `main` at
e40f060e, before this change,

```sh
git checkout main && bash .governance/run.sh
# ✗ receipt-per-issue (1 violation)
#     receipts/issue-831-clear-four-app-interfaces.md — receipt is missing a '## Out of scope' section
```

### Checklist crosswalk

Each checked item verbatim, and where it is realized:

- `receipts/issue-831-clear-four-app-interfaces.md` carries an `## Out of scope` section stating what #831 deliberately left untouched — the added section sits above that receipt's existing `## Decisions`, and its checklist crosswalk was added in the same commit for rule 3.
- `bash .governance/run.sh` is green — the governance run in the block above returns 22 passing directives.
- No directive, allowlist, budget or config is loosened — the diff is confined to `receipts/`; no `.governance/` file, lint config, allowlist or budget is in it.
## Audit

**PASS**, with the same independence caveat this branch's other receipt
records: the adversarial pass was an in-session re-read of the diff against
[#836](https://github.com/srikanth235/centraid/issues/836) and this receipt,
not a fresh-context sub-agent, because agent spawning was disabled for this
session.

- **`## What changed` against the diff.** The diff is two files —
  `receipts/issue-831-clear-four-app-interfaces.md` (one added section) and
  this receipt. Both are named above; nothing else is touched, and no claim is
  made about a file the diff does not contain.
- **Each `- [x]` against the diff.** The section exists and is the one rule 2
  names; the governance run is green; and the diff contains no change to
  `.governance/`, to a lint config, to an allowlist or to a budget — the "no
  loosening" claim is checkable by the diff being confined to `receipts/`.
- **The `## Checklist` against the issue's acceptance criteria.** Three items,
  verbatim and in order.
- **The limit.** Whether the added prose is a *faithful* account of #831's
  intent rests on #831's own receipt and commit message, which is where every
  line came from. It is not independent evidence about that change.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-21 | claude-code | 52ba79df-c11a-5a90-99a8-ae103946d145 |
