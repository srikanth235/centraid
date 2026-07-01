# Agent Steering Accounting

Governance directive that gives the repo a durable, auditable ledger of
**human steering events** for agent-authored work — the moments where the
operator interrupted a turn or typed a message that redirected or corrected the
agent mid-task. Tool denials are deliberately **not** tracked: a click on
"deny" is most often "I'll do that myself" / "wrong tool", not an intent
redirect.

Deciding whether a user message is a *correction* is an **LLM judgment**, not a
mechanical test. So (issue #325) the directive folds that judgment into a
**fresh-context sub-agent attestation** — the same shared sub-agent-judgment
infrastructure receipt-per-issue's `## Audit` and the repo-local
`layer-boundaries` use — instead of shelling out to `claude -p` from the
pre-commit hook. See **Why a sub-agent, not an in-hook classifier** below.

This is the human-side counterpart to [`agent-token-accounting`](../agent-token-accounting/README.md).
That directive captures *machine* cost (token consumption, dollars). This one
captures *steering* cost (where the agent's instructions or directives drifted
from operator intent and the operator had to correct it). Both home their rows
in the commit's per-issue receipt — `receipts/issue-<N>.md`, under a
`## Accounting` section (cost rows in `### Costs`, steering rows in
`### Steering`) — instead of a central ledger at repo root. Homing rows in the
receipt keeps the record conflict-free (only the PR branch that owns the issue
writes it) and bounded, and it is naturally sealed once the receipt merges
(frozen on the trunk by `doc-integrity`).

## Why a sub-agent, not an in-hook classifier (issue #325)

The directive used to make the correction judgment inline, by shelling out to
the runtime's headless CLI (`claude -p`) from the pre-commit hook. Two problems:

1. **Transcript pollution → wrong token costs.** The `claude -p` call wrote a
   *throwaway* session transcript into the same `~/.claude/projects/<cwd>/`
   directory at commit time. `agent-token-accounting` selected the active
   session by newest-mtime `.jsonl`, so it grabbed *that classifier transcript*
   instead of the real session — recording a near-zero cost row for a long,
   expensive session (the **$0.37-for-a-20-minute-Opus-session** bug). The token
   directive now resolves the session deterministically from
   `CLAUDE_CODE_SESSION_ID`, and removing the `claude -p` shell-out fixes the
   pollution at its root.
2. **Non-deterministic / online commit hook.** A network model call on the
   commit path makes the hook slow, flaky, and dependent on the CLI being
   reachable and authenticated.

Folding the judgment into a sub-agent attestation removes the shell-out
entirely: **the commit hook now makes no `claude -p` / network call.** The
sub-agent is handed the session transcript, records every steering event as a
row, and renders the verdict — the same fresh-context, author≠auditor split
every attestation gives. Its verdict is independently re-derived at the high
tier by the merge-time sweep lane.

## What the directive enforces

`check.sh` enforces two things, no `claude -p` anywhere:

1. **Ledger shape (`validate-dir`, repo-wide, every mode).** Whatever steering
   rows exist under `## Accounting` → `### Steering` are well-formed: per-row
   shape, type/tier sets, receipt-homed issue, append-only epoch order,
   per-session `ordinal` strict-increase, global `steer-key` uniqueness, and
   cross-receipt `(session, ordinal)` identity.
2. **The `## Steering` attestation (change-set scoped).** For each receipt added
   in the change set, a present, verdict-bearing `## Steering` section — the
   fresh-context sub-agent's `PASS`/`REFUTED` verdict. Gated through the shared
   `subagent_attest` helper in `lib.sh`; pre-existing receipts are grandfathered.

The judgment task is declared once in `directive.yaml`'s `subagent:` block
(`inputs: [transcript, receipt]`, `isolation: shared`, `section: Steering`, plus
the rubric `checks`). At commit time the run-level orchestrator
(`attestation_remediation`, invoked once by `run.sh` / the pre-commit dispatcher)
batches this attestation with any other `isolation: shared` attestation pending
on the same commit — so a newly added receipt that owes `## Audit` *and*
`## Steering` is filled by **one** sub-agent, not one per section.

## Row schema

Steering rows live in the commit's per-issue receipt — `receipts/issue-<N>.md`,
under the `## Accounting` → `### Steering` sub-table. v2 is 9 columns:

```
| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
```

- `steer-key` — `steer-<session-short>-<epoch>-<idx>`. Globally unique across
  all `receipts/*.md`, monotonically non-decreasing in `<epoch>`. An opaque
  join token — do not parse it.
- `session` — runtime session id (e.g. Claude Code's `sessionId`).
- `issue` — `#N` from the receipt's own issue. Required: every accounted event
  resolves to an issue (the row's home receipt).
- `type` ∈ `interrupt` | `correction`.
- `tier` ∈ `structural` | `classifier` | `lexical`. The sub-agent records
  `structural` for interrupts (a runtime-emitted sentinel) and `classifier` for
  corrections (its own judgment). `lexical` remains a valid enum for rows minted
  by older versions.
- `user-reason` — a ≤80-char summary of the redirect intent (corrections), or
  empty (interrupts). Truncated to 240 chars.
- `commit` — short subject of the commit that recorded this row.
- `ordinal` (v2) — the event's 1-based position in the session's deterministic
  event stream. With `session` it forms the event's identity: a `(session,
  ordinal)` pair is recorded once, ever; per-session ordinals are strictly
  increasing; the same `(session, ordinal)` in two receipts is flagged.
- `timestamp` (v2) — the ISO timestamp of the event.

Legacy v1 rows (7 columns, no `ordinal`/`timestamp`) keep parsing and are
validated to the v1 rules.

## How the sub-agent records rows

When a newly added receipt lacks a `## Steering` section, `check.sh` fails and
the run-level orchestrator emits a grouped remediation instruction. The harness
agent spawns a fresh-context sub-agent, handed the **session transcript** for
the active runtime (`CODEX_THREAD_ID` under `~/.codex/sessions/` /
`~/.codex/archived_sessions/` for Codex, `CLAUDE_CODE_SESSION_ID` under
`~/.claude/projects/` for Claude Code, or an explicit `*_TRANSCRIPT_PATH`) and
the receipt. The sub-agent:

1. Walks the transcript and identifies each human-steering event — an
   **interrupt** (a user message beginning `[Request interrupted by user`) or a
   **correction** (a user message that redirects/corrects the agent mid-task;
   tool denials and ordinary task messages are **not** steering).
2. Records each event as a row under `## Accounting` → `### Steering`. The
   reliable way is the ledger helper, which mints a valid `steer-key`, checks the
   existing ordinals, and writes the table:

   ```sh
   python3 .governance/packs/governance-kit/audit/directives/agent-steering-accounting/lib/ledger.py \
     append-row <receipt> <steer-key> <session> <issue> <type> <tier> <user-reason> <commit> <ordinal> <timestamp>
   ```

   (type `interrupt`→tier `structural`, `correction`→tier `classifier`.)
3. Writes its `PASS`/`REFUTED` verdict into the `## Steering` section, with
   evidence for each rubric check. A session with no steering events records no
   rows and a `PASS` verdict ("no human-steering events in this session").

The hook never spawns the sub-agent itself; a bare commit or CI run with no
agent simply hard-fails on the missing `## Steering` section — correct, the
audit step did not run.

## Privacy

`user-reason` is committed to the repo's history (a summary of the redirect
intent). The directive is mandatory (`always_install: true`) — in this kit's
model every commit is agent-authored, so steering-accounting is part of the
audit chain. **Think through what those messages could leak before working in a
public repo.** The sub-agent summarises rather than transcribing verbatim, which
is the lowest-leak path.

## Installing

The directive ships as a self-contained folder under the `governance-kit/audit`
pack. It carries `lib/ledger.py` (row I/O + validation) and `lib/receipt_io.py`
(Markdown table plumbing) — and, since issue #325, **no** classifier, extractor,
populator hook, or runtime transcript-reader. Stdlib-only Python 3; the only
runtime dependency is `python3` on `$PATH`. There is no ledger file to seed —
rows live in per-issue receipts.

Add an `agent-steering-accounting` Directives subsection to `CONSTITUTION.md` via
the `governance directive add` verb.

## How a commit flows

```
git commit -m "feat: x (#13)"
      │
      ▼
pre-commit ──► each pre-commit directive's check.sh runs (no claude -p anywhere):
      │          • agent-steering-accounting/check.sh:
      │              1. validate-dir over receipts/*.md (ledger shape).
      │              2. For each receipt added in the change set: subagent_attest
      │                 gates the `## Steering` section (present + PASS/REFUTED)
      │                 and registers it (isolation: shared) if pending.
      │          • (receipt-per-issue registers `## Audit`, etc.)
      │
      │          After the loop, the dispatcher runs attestation_remediation once:
      │          ONE grouped instruction for all pending shared attestations.
      │
      ▼
missing `## Steering` → commit blocked → harness spawns the fresh-context
sub-agent (handed the transcript), which records the rows + writes the verdict,
re-stages, re-commits → check.sh passes → commit lands.
```

In CI / `bash .governance/run.sh`, the same `check.sh` runs `validate-dir` plus
the `## Steering` attestation gate over the branch's added receipts.

## Escape hatches

- `SKIP_GOVERNANCE=1 git commit ...` / `git commit --no-verify` — local hook
  bypass. CI re-runs the ledger-shape check and the attestation gate.
- `governance: allow-agent-steering-accounting <reason>` — a per-receipt waiver
  (reason required, in the receipt's first 10 lines) for a receipt that
  genuinely cannot carry the attestation (e.g. the transcript is unavailable in
  the commit context) or an irreparable `(session, ordinal)` duplicate. Audit
  trail: `git log --grep='allow-agent-steering-accounting'`.

## Out of scope (deferred follow-ups)

- Wiring the **sweep** consumer to re-derive the `## Steering` verdict at the
  high tier from the same `subagent:` declaration (the schema is designed for it).
- Cross-session aggregation / dashboards.
