# Constitution

This document is the source of truth for the principles, guidelines, and directives that govern development in this repository. Every directive here is enforced by an executable test under `.governance/`. A directive with no enforcing test is not a directive — it is a wish.

> **The cardinal rule:** Amendments to this constitution must land in the same commit as the change to its enforcing test. No exceptions.

## Compliance

Anyone working in this repo — humans, agents, scripted automation — must satisfy every principle, guideline, and directive in this document.

- **Mechanical directives** (the **Directives** section below) are enforced by `.governance/` via the pre-commit hook and CI. A violating commit is blocked locally and re-blocked in CI if the hook is bypassed.
- **Principles and guidelines** (the **Principles** section above the Directives) cannot be checked mechanically. They depend on judgment and reviewer discipline. A change that defies a principle without explanation is grounds to block the PR.

If a specific change cannot satisfy a directive, document the deviation in the PR description and use the directive's stated waiver mechanism if one exists. Drive-by violations without explanation will block the merge.

## Principles

- Changes to this constitution must land with a corresponding change to the enforcing tests.
- Every commit is treated as agent-authored — the audit chain (issue → receipt → commit → token + steering ledger) is mandatory, not opt-in.
- The repo is its own system of record. Decisions, costs, steering events, and quality observations belong in tracked files, not in chat history.
- Docs are load-bearing. Stale docs are bugs; broken internal links are bugs; missing baseline docs (constitution, agents, readme, license, security, architecture) are bugs.
- Escape hatches exist (`SKIP_GOVERNANCE=1`, `git commit --no-verify`) — but every skipped commit is still checked in CI.

## Directives

### required-docs

- **Directive**: The repo ships the baseline set of root-level documents and local-hook scaffolding expected by governance-kit — every sub-check below is enabled:
    - `constitution` — `CONSTITUTION.md` at repo root, non-empty, ≥ 10 lines.
    - `agents` — `AGENTS.md` at repo root, 30–250 lines (configurable via `GOVERNANCE_AGENTS_MD_MIN` / `GOVERNANCE_AGENTS_MD_MAX`), with ≥ 3 links to other repo docs (configurable via `GOVERNANCE_AGENTS_MD_MIN_LINKS`), and a link to `CONSTITUTION.md` so the file functions as a map to the bedrock durable docs rather than a standalone manual.
    - `readme` — `README.md`, `README`, or `README.rst` at repo root with a top-level heading and ≥ 30 words.
    - `license` — `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING`, or `COPYING.md` exists at repo root and is non-empty.
    - `security` — `SECURITY.md` (root, `docs/`, or `.github/`) exists and lists a contact email, URL, or vulnerability-disclosure platform.
    - `architecture` — `ARCHITECTURE.md` (root or `docs/`) exists and is ≥ 20 lines (configurable via `GOVERNANCE_ARCHITECTURE_MIN`).
    - `ci-workflow` — `.github/workflows/` contains at least one non-governance workflow.
    - `env-example` — when a local `.env` exists, every key in it is declared in `.env.example`.
    - `hooks` — when the installed hook strategy is `githooks`, `.githooks/pre-commit` is tracked + executable, `.githooks/commit-msg` likewise if `commit-message-format` is installed, and `core.hooksPath` points at `.githooks`. No-op on `husky` / `pre-commit.com` strategies.
- **Rationale**: Governance without a discoverable source of truth is tribal knowledge, and a fresh clone with zero local enforcement silently trusts CI for everything. Rolling the individual presence checks into one directive cuts preset sprawl — repos that need to carve out a sub-check do so by amending the directive in-tree (where the change is reviewable), not by flipping nine separate directive ids on or off in CI.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/required-docs/check.sh`
- **Exceptions**: To carve out a sub-check for your repo, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive entirely). The `hooks` sub-check is a transparent no-op when the installed manifest declares a non-`githooks` hook strategy.

### secrets-hygiene

- **Directive**: No tracked file violates either of the following sub-checks:
    - `no-secrets` — no tracked file contains a plaintext AWS / GCP / GitHub / Slack / Stripe token, private-key block, or generic `api_key = "..."` literal, per the directive's heuristic pattern set (line-level waiver: `# governance: allow-secrets-hygiene <reason>`).
    - `dotenv` — `.env` (and `.env.*` except `.env.example` / `.env.sample` / `.env.template`) is not tracked, and `.gitignore` exists and covers `.env`.
- **Rationale**: A leaked credential in git history is a credential compromised — rotation is the only recourse. `.env` is where those credentials most commonly live, so closing the door on tracking it complements the pattern scan that catches the ones that slip past into source. Treat the two as one directive: they share a failure mode and both belong on every commit.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/secrets-hygiene/check.sh`
- **Exceptions**: For documented, intentional fixtures, append `# governance: allow-secrets-hygiene <reason>` to the offending line — the waiver is visible in `git blame` and searchable by design. To carve out a sub-check entirely for your repo, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive).

### repo-hygiene

- **Directive**: No tracked file violates any of the following hygiene sub-checks:
    - `merge-markers` — no `<<<<<<<`, `=======`, or `>>>>>>>` at line start in any tracked file.
    - `large-files` — no tracked file exceeds 5 MB (override via `GOVERNANCE_MAX_FILE_SIZE_MB`).
    - `build-artifacts` — no tracked file matches the artefact denylist (`*.pyc`, `__pycache__/`, `*.class`, `*.o`, `node_modules/`, `dist/`, `build/`, `target/`, `out/`, `.DS_Store`, `Thumbs.db`, editor swap files).
    - `debug-statements` — no stray `console.log`, `debugger`, `breakpoint()`, `import pdb`, `dbg!`, or `fmt.Println` in non-test source (line-level waiver: `# governance: allow-repo-hygiene <reason>`).
    - `file-size-limit` — no source file exceeds 500 lines (override via `GOVERNANCE_FILE_SIZE_LIMIT`), excluding vendor / generated / migrations / protobuf / node_modules. File-level waiver: place `governance: allow-repo-hygiene file-size-limit <reason>` in the first 10 lines of the file (any comment syntax).
- **Rationale**: Merge markers, oversized binaries, build output in the tree, leftover debug prints, and god-files all corrupt the history in slightly different ways, but they share one property: they are almost always accidental. Rolling them into a single directive keeps the catalog honest about how much work each check is doing — none of them is a load-bearing axis on its own, so `minimal` / `standard` / `strict` do not need three separate entries to pick from.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/repo-hygiene/check.sh`
- **Exceptions**: The `debug-statements` sub-check supports line-level waivers (`# governance: allow-repo-hygiene <reason>`). The `file-size-limit` sub-check supports file-level waivers (`governance: allow-repo-hygiene file-size-limit <reason>` in the first 10 lines). To carve out a sub-check entirely for your repo, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive). Marked `always_install: true` — the merge-marker sub-check is high-signal and zero-false-positive, and bundling the siblings alongside it keeps hygiene coverage consistent regardless of preset.

### no-broken-internal-doc-links

- **Directive**: Every relative-path markdown link in a tracked `.md` file resolves to an existing file.
- **Rationale**: Broken links rot silently — the doc still renders, just incorrectly. A link that once pointed at a real file and now doesn't signals that the doc has drifted from the code it describes.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/no-broken-internal-doc-links/check.sh`
- **Exceptions**: none.

### doc-freshness

- **Directive**: Docs opted into `.governance/freshness.conf` carry a `<!-- last-verified: YYYY-MM-DD -->` marker dated within the last 90 days (configurable). No-op if the config file is absent.
- **Rationale**: Critical runbooks and onboarding docs decay. A periodic "someone re-read this" checkpoint keeps them honest — if the deadline passes, either the doc still reflects reality (bump the date) or it doesn't (fix it).
- **Enforced by**: `.governance/packs/governance-kit/core/directives/doc-freshness/check.sh`
- **Exceptions**: Remove a doc from `freshness.conf` to opt it out entirely.

### commit-message-format

- **Directive**: Commit messages match `<type>(scope)?!?: subject (#123)` — a Conventional Commits prefix **plus** a trailing GitHub issue reference. Supported types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`, `style`. Extend via `GOVERNANCE_CC_EXTRA_TYPES`.
- **Rationale**: The typed prefix keeps changelogs scannable; the trailing `(#123)` anchors every commit to a durable work item. Together they make `git log` a readable audit trail instead of a stream of "fix stuff". The two halves are enforced as one rule because a Conventional Commits message without the issue anchor is still a hole in the audit trail this kit cares about.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/commit-message-format/check.sh` (also wired into the `.githooks/commit-msg` dispatcher).
- **Exceptions**: Merge and revert commits are skipped automatically.

### no-orphan-todos

- **Directive**: Every `TODO` or `FIXME` comment references either a GitHub issue (`#123`) or a tracker ticket (`ABC-123`).
- **Rationale**: A bare `TODO` is a promise to nobody. An issue-linked TODO is a promise that someone, somewhere, can follow up on — and that survives the author changing teams.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/no-orphan-todos/check.sh`
- **Exceptions**: Append `governance: allow-no-orphan-todos <reason>` to the offending line for rare intentional exceptions.

### agent-steering-accounting

- **Directive**: Every non-merge, non-revert commit stamps the always-on summary triple — `Steer-Count: <N>`, `Steer-Types: <type>=<N>,...` (sorted, or `none` when N=0), `Steer-Tiers: <tier>=<N>,...` (sorted, or `none` when N=0). Each detected human-steering event on this branch since the last commit is additionally recorded as an append-only row in `STEERING.md`. The summary numbers must agree with the rows newly added to `STEERING.md` by this commit: `Steer-Count` equals the number of added rows; the type / tier breakdowns tally those rows' `type` and `tier` columns and total to `Steer-Count`. The row → commit join uses `STEERING.md`'s `commit |` column — at pending-commit time, every newly-added row's `commit |` cell must equal the pending subject. `STEERING.md` rows are well-formed — 7 columns (`steer-key | session | issue | type | tier | user-reason | commit`), `type` is one of `interrupt`/`correction`, `tier` is one of `structural`/`classifier`/`lexical`, and `steer-key` is unique within the file. Row order is monotonically non-decreasing in the embedded epoch — append-only, never reordered. A commit with zero detected events still carries the summary triple as `Steer-Count: 0` / `Steer-Types: none` / `Steer-Tiers: none`. The contract is independent of `agent-token-accounting` — installation is the gate, not the presence of an `Agent:` trailer.
- **Rationale**: Token-accounting captures *machine* cost. Steering-accounting captures *human* steering cost — the moments where the operator interrupted a turn or redirected the agent. These events are the highest-signal record of where the agent's instructions or directives are misaligned with intent, and today they're invisible: the commit history shows the result of a redirect, never the redirect itself. A durable ledger plus a stamped summary trailer turns each steering event into a citable record that survives squash merges. Two-tier detection: tier 1 (structural — interrupts) reads runtime sentinels with near-zero false positives; tier 2 (corrections) shells out to the active runtime's headless CLI for semantic classification, falling back to a regex pre-filter only when the CLI is unreachable. The runtime CLI is by definition installed in any session that wrote the transcript, so it's a free dependency. **Tool denials are excluded by design**: a user clicking "deny" on a tool call is most often "I'll do that myself" / "wrong tool", not an intent redirect, and the substring sentinel for the denial phrase produced false positives any time a tool result contained the canonical text (e.g. when an agent read this directive's own source). Interrupts and classifier-confirmed corrections are the real steering signal. **Always-on summary**: zero events still emits `Steer-Count: 0`. The alternative — silence on no-event commits — makes "directive ran and saw nothing" indistinguishable from "directive crashed mid-flight" or "directive wasn't installed at this commit". A positive zero-assertion costs three lines of trailer; the consequent `git log`-skimmable steering footprint is worth more. **Summary-only contract**: per-event `Steer-Key:` trailers were retired in #66 — the headline reviewers want is the count and breakdown, and `STEERING.md`'s `commit |` column already lets `git log` ↔ row joins go through without a per-event trailer. Dropping the per-event trailer also fixes the retry-after-failed-commit-msg bug where the second `git commit` invocation re-stamped zero `Steer-Key:` trailers because the appended rows looked like "already-recorded" events. Privacy is the directive's single load-bearing tradeoff: `user-reason` is committed verbatim (now in `STEERING.md` only — no longer duplicated in commit trailers). The directive is now mandatory (`always_install: true`, on a par with `repo-hygiene`) — in this kit's model every commit is agent-authored, so steering-accounting is part of the audit chain, not an extra. Public-repo operators handle the privacy tradeoff by layering redaction inside the classifier hook (the verbatim text only enters `STEERING.md` after `lib/extract.py` writes the row), not by skipping the directive — skipping it would leave a documented hole in the audit chain.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/agent-steering-accounting/check.sh`, plus sibling helpers in the agent-steering-accounting directive folder — `hooks/pre-commit.sh` extracts events from the active session JSONL (via `runtimes/<runtime>.sh`), appends rows, and writes a handoff file; `hooks/prepare-commit-msg.sh` reads the handoff and stamps the summary triple. `lib/extract.py` houses the two-tier detection, `lib/ledger.py` the row I/O, `lib/trailers.py` the trailer parser. The bootstrap hook generator wires the three hooks into `.githooks/pre-commit`, `.githooks/commit-msg`, and `.githooks/prepare-commit-msg`.
- **Exceptions**: Merge commits and revert commits are exempt (merges detected via `git log --format=%P` showing >1 parent, reverts via subject starting with `Revert "`). Commits authored outside a recognised agent runtime (no session JSONL discoverable) still receive the summary triple — `prepare-commit-msg.sh` stamps `Steer-Count: 0` / `Steer-Types: none` / `Steer-Tiers: none` when no handoff is written, so the contract holds even when the extractor saw no transcript. Mode B's self-bootstrapping exemption skips commits whose first parent did not yet carry the directive. Historical commits in the repo's log that pre-date #66 may carry `Steer-Key:` trailers; the new check ignores them. `SKIP_GOVERNANCE=1 git commit ...` and `git commit --no-verify` skip the local hooks; CI re-enforces the summary contract.

> **Privacy note.** `user-reason` cells preserve text from interrupt-with-reason events and tier-2 correction messages. Interrupts on Claude Code today carry no typed reason (the field is empty); future runtimes that capture an interrupt reason will record it verbatim. Tier-2 (`tier: classifier`) records the LLM-summarised redirect intent rather than the verbatim user message; tier-2 (`tier: lexical`) records verbatim user text only when the runtime CLI is unreachable and the regex fallback runs. In all cases the recorded text becomes part of the repo's public history. The directive's install step is the only gate — installing it commits to recording every tier from the moment a session sends an interrupt or correction-classified message. **Do not install on a public repo without thinking through what those messages could leak.**

> **Installation note.** The directive folder is self-contained — `lib/` (extract, ledger, trailers), `hooks/` (pre-commit extractor + prepare-commit-msg stamping), and `runtimes/` (per-runtime transcript readers) all live inside the directive folder and are installed as a unit. See `governance/references/AGENT_STEERING_ACCOUNTING.md` for runtime wiring and the extractor's two-tier model.

### agent-token-accounting

- **Directive**: Every non-merge, non-revert commit carries the full trailer set (`Agent`, `Issue`, `Session`, `Token-Input`, `Token-Output`, `Token-Total`, `Cost-Key`, `Cost-USD`), satisfies `Token-Total = Token-Input + Token-Output`, and has exactly one matching append-only row in `COSTS.md` whose numbers agree with the trailers (`Token-Input == row.input + row.cache_create`, `Token-Output == row.output`, `Token-Total == row.new_work`, `Cost-USD == row.cost_usd`). `COSTS.md` rows are well-formed — 12 columns (`cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | note`) with `new-work == input + cache_create + output` (cache_read is tracked but deliberately excluded from new-work) and `cost-usd` a non-negative float on every row that names a model — and `Cost-Key` is unique within the file. Legacy rows are accepted: v2 (10 cols, pre-model/cost-usd) and v1 (8 cols, pre-cache-split), plus v3 rows predating this mandate whose `model` cell is empty — all validated under the same `new-work` invariant with `cost-usd` exempt.
- **Rationale**: A repo that opts into agent-governance is committing to "every change to the tree is produced through an agent runtime", so an untrailered commit is a bug, not an allowed mode. Mandatory trailers turn `COSTS.md` from a best-effort opt-in into the single system-of-record for agent cost and provenance. Token trailers give branch-time provenance reviewers can read; `COSTS.md` is the durable ledger that survives squash merges. Splitting cache traffic into its own columns keeps the ledger lossless; `new-work` deliberately excludes `cache_read` so the token headline represents new work, not cache rent. The `cost-usd` column (computed from the sibling `lib/rates.py`) is the only single-number headline that compares across commits with different cache mixes, and the family-prefix fallback in the rate table means a new minor model release resolves to its family's schedule rather than dropping a blank — so every priced row has a cost and a truly unpriced model is a bug that blocks the commit, not a silent skip.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/agent-token-accounting/check.sh`, plus sibling helpers in the agent-token-accounting directive folder — `hooks/pre-commit.sh` writes the matching ledger row (using `runtimes/<runtime>.sh` to read the agent's transcript), and `hooks/prepare-commit-msg.sh` stamps matching trailers from the pre-commit handoff. The bootstrap hook generator wires all three into `.githooks/pre-commit`, `.githooks/commit-msg`, and `.githooks/prepare-commit-msg` respectively.
- **Exceptions**: Merge commits and revert commits are exempt (merges detected via `git log --format=%P` showing >1 parent, reverts via subject starting with `Revert "`).

> **Installation note.** The directive folder is self-contained — `lib/` (ledger, trailers, rates), `hooks/` (pre-commit side effects, prepare-commit-msg stamping), and `runtimes/` (per-runtime transcript readers) all live inside the directive folder and are installed as a unit. See `governance/references/AGENT_TOKEN_ACCOUNTING.md` for runtime wiring.

### commit-issue-receipt-match

- **Directive**: For every non-merge, non-revert commit in scope, some issue the commit anchors — either the trailing `(#N)` in the subject or any `Issue: #N` trailer in the body — matches an `issue-<N>` token on at least one `receipts/*.md` file the commit adds or modifies. A commit that touches no `receipts/*.md` fails this directive. Accepting body `Issue:` trailers keeps post-squash-merge history valid: the subject carries the PR id while the folded sub-commits preserve their original `Issue:` anchors (stamped by `agent-token-accounting`).
- **Rationale**: `commit-message-format` pins each commit to an issue and `receipt-per-issue` pins each receipt to an issue, but nothing cross-checks the two — a commit claiming `(#15)` while touching only issue #42's receipt passes both directives in isolation. This directive closes that hole, so the receipt the agent updates must be the *right* one for the commit's issue. It also subsumes the "every substantive commit must touch the receipt" obligation, which is what makes the receipt a live audit artifact rather than an end-of-work afterthought.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/commit-issue-receipt-match/check.sh` (Mode B — CI walks merge-base → HEAD) and `.githooks/commit-msg` (Mode A — validates the pending commit against its staged diff).
- **Exceptions**: Merge commits and revert commits are exempt (mirrors `commit-message-format`). Per-commit waiver — a line `governance: allow-commit-issue-receipt-match <reason>` in the commit body exempts that commit (reason required; a bare token does not waive).

### issue-templates

- **Directive**: `.github/ISSUE_TEMPLATE/config.yml`, `proposal.yml`, and `bug.yml` exist; blank issues are disabled; the proposal form requires Context, Decision, Scope, Acceptance criteria, Validation, and Open questions; and the bug form requires the core defect-report fields.
- **Rationale**: Agent-created GitHub issues are the durable output of brainstorming sessions. Requiring the settled decision, scope, acceptance criteria, validation, and open questions in the issue form keeps a future implementing agent from re-deriving intent from chat history.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/issue-templates/check.sh`
- **Exceptions**: none.

### issues-tracked

- **Directive**: `QUALITY.md` exists at the repo root with a top-level `# ` heading and contains `## Open` and `## Resolved` sections.
- **Rationale**: Bugs and quality observations discovered between releases rot in Slack and memory. Tracking them in a file keeps them in the system of record, diff-auditable, and greppable by agents and humans alike.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/issues-tracked/check.sh`
- **Exceptions**: none. Empty sections are allowed; the file itself is the contract.

### receipt-per-issue

- **Directive**: Every tracked `receipts/*.md` file satisfies four shape rules:
    1. The filename matches `issue-<N>-<slug>.md` where `<N>` is the GitHub issue number and `<slug>` is one or more kebab-case tokens (lowercase letters, digits, hyphens). No two receipts share the same issue number.
    2. The body contains four Markdown sections — `## Checklist`, `## What changed`, `## Out of scope`, and `## Verification` — naming the work plan, the surface area touched, the deferred work, and the criteria a reviewer uses to judge completion.
    3. The `## Checklist` mirrors the linked GitHub issue's checklist. Each completed item (`- [x] …`) must have its item text appear — as a case-insensitive substring — somewhere in the receipt's `## What changed` or `## Verification` section. Unchecked items (`- [ ] …`) are unconstrained; they represent remaining work and need no crosswalk.
- **Rationale**: Receipts are the durable post-implementation audit trace for work an agent did against a GitHub issue. The one-receipt-per-issue binding keeps the system of record unambiguous: a reviewer jumps from an issue to its single receipt, and an agent can detect whether an issue already has a receipt before drafting a duplicate. The four required sections force the agent to write the parts a reviewer actually needs — `Checklist` (the agent's mechanical "I am done" signal, mirroring the issue), `What changed` (the surface area), `Out of scope` (so omissions are not mistaken for oversights), and `Verification` (how completion is judged). The checklist crosswalk is the local trust boundary: without it, the agent could silently flip boxes from `[ ]` to `[x]` without writing evidence; with it, every checked item must appear in the receipt's prose, so a reviewer confirms claimed-done items map to described work without leaving the diff. Substring matching (rather than a strict anchor syntax) keeps the discipline cheap to satisfy — paraphrasing the item into a What-changed bullet is enough. In this repo's mental model, all code is authored by coding agents, so the receipt is the agent's attestation to the human reviewer. Receipts are distinct from the pre-implementation plans Claude Code / Codex produce in plan-mode — those are an agent-runtime concept, out of governance scope.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/receipt-per-issue/check.sh`
- **Exceptions**: None. Receipts are a fresh discipline; there is no legacy receipt corpus to grandfather.

### query-handlers-read-only

- **Directive**: centraid query handlers (`*/queries/*.js`) must not mutate the database — no `stmt.run()`, no `db.exec()`. Use `actions/*.js` (dispatched via `centraid_write` / `POST /centraid/_tool/centraid_write`) for any writes.
- **Rationale**: the runtime's handler-runner skips SQLite session tracking for `handlerKind === 'query'` as a perf optimization on the read path (`packages/runtime-core/src/handler-runner.ts`). Writes from a query handler succeed but are invisible to the change-notification SSE feed at `/centraid/<id>/_changes`, so subscribed iframes never re-fetch — UI goes silently stale with no error anywhere. Mutations must live where the bus actually observes them.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/query-handlers-read-only/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-query-handlers-read-only <reason>` for the rare opt-in case (e.g. lazy view materialization on first access).

### handler-uses-ctx-primitives

- **Directive**: centraid handlers (`**/queries/*.js`, `**/actions/*.js`) must not import provider SDKs directly (`@anthropic-ai/sdk`, `openai`, `groq-sdk`, `@google/generative-ai`, `cohere-ai`, `@mistralai/mistralai`, `replicate`, `together-ai`). Inference and other gateway-managed capabilities flow through `ctx.infer.*` and related primitives supplied by the handler-runner.
- **Rationale**: handler-as-source-of-truth. Extending `ctx.*` is the supported way to grow capabilities. Reaching past it (a) defeats per-profile model routing, (b) bypasses run-ledger cost accounting in `runtime.sqlite`, and (c) couples the handler to a specific provider — breaking the embedded ↔ OpenClaw gateway portability that the architecture's "same code, two modes" property depends on.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-handler-uses-ctx-primitives <reason>` for the rare opt-in case (e.g. an action that legitimately needs to call a provider directly during a controlled experiment).

### no-hardcoded-model-ids

- **Directive**: production source under `packages/` and `apps/` must not reference concrete provider model ids (`claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5`, `o1-mini`, `gemini-2.0-flash`, etc.) inside string literals. Model selection flows through capability tiers resolved at runtime. The single allowlisted file is `packages/runtime-core/src/model-pricing.ts` (the price table is by definition a model-id-to-price map). Test files (`**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`) are excluded since they exercise the pricing and storage layers and need real ids.
- **Rationale**: provider-agnostic inference. The model lineup churns - Anthropic, OpenAI, Google, and Meta ship new flagship models every few months and retire old ones on a similar cadence. Code that references `claude-sonnet-4-5` directly is a maintenance liability the moment the next minor version ships. Capability tiers (`tier:fast`, `tier:smart`) abstract that churn behind a runtime resolver and let model selection move with operator preferences and per-profile routing without code edits.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/no-hardcoded-model-ids/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-no-hardcoded-model-ids <reason>` for the rare opt-in case (e.g. a controlled experiment that pins a specific model intentionally).

### actions-declare-table-writes

- **Directive**: every entry in a centraid `app.json#actions[]` array must include a `writes:` field whose value is an array of table names. Empty arrays (`writes: []`) are allowed and signal "this action performs no database writes" (e.g. a webhook-only action). Missing or non-array `writes` is rejected. Applies to all tracked `**/app.json` files whose top-level `manifestVersion` is set (distinguishing Centraid manifests from `apps/mobile/app.json`, which is an Expo config).
- **Rationale**: same foot-gun shape as `query-handlers-read-only`. The change-stream SSE feed at `/centraid/<id>/_changes` uses each action's declared `writes:` tables to invalidate per-table query subscriptions. A missing or wrong `writes` field is silently broken: the mutation succeeds, the bus stays quiet, subscribed iframes never re-fetch, UI goes stale with no error. Making the declaration mandatory turns "I forgot to list the table" into a commit-time failure instead of a runtime mystery.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/actions-declare-table-writes/check.sh`
- **Exceptions**: none. JSON has no comment syntax, and the check is file-level; the right opt-out for a no-DB-write action is the explicit empty array.

### gateway-core-mode-agnostic

- **Directive**: code under `packages/runtime-core/` may not branch on which gateway mode it is running under. Specifically, gateway-mode-discrimination identifiers (`gatewayMode`, `gatewayKind`, `gateway_mode`, `gateway_kind`, `isEmbeddedGateway`, `isOpenClawGateway`, `isLocalGateway`, `isRemoteGateway`, `deploymentMode`, `hostingMode`) are forbidden in tracked source files. Mode-specific behavior belongs at the entrypoints: `apps/desktop/src/main/` for the embedded gateway, `packages/openclaw-plugin/src/` for the OpenClaw gateway.
- **Rationale**: the architecture's "same code, two modes" property is what makes "local-first with optional remote" cheap rather than expensive. Once `runtime-core` starts checking which host it lives inside, dev and prod paths diverge and "works on my machine" becomes a class of bug again. Centraid's docs frame this explicitly: "the split exists only at the chat backend and the reachable-from surface; the rest of the gateway is byte-identical." Encoding that promise as a check stops it from rotting silently the next time someone is tempted to add a one-liner branch.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/gateway-core-mode-agnostic/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-gateway-core-mode-agnostic <reason>` for the rare case where runtime-core genuinely needs to inspect its host (none today; the architecture promise is that no such case should exist).

## Amendment process

1. Open a PR that modifies this file **and** the directive folder under `.governance/packs/<owner>/<repo>/directives/` in the same commit.
2. The PR description states *what* changed and *why* — link the incident, RFC, or discussion that motivated it.
3. Add an entry to the **Evolution Log** below.
4. At least one reviewer with governance authority approves.

## Evolution Log

- 2026-05-12 — @srikanth235 — Initial constitution bootstrapped via governance-kit with `governance-kit/core` (standard preset + no-orphan-todos; workflows-hardened deferred).
- 2026-05-15 — @srikanth235 — Add `query-handlers-read-only`: forbid `stmt.run()` and `db.exec()` inside `queries/*.js` so writes are never invisible to the `/_changes` SSE feed.
- 2026-05-26 — @srikanth235 — Add `handler-uses-ctx-primitives`: forbid direct provider-SDK imports in `queries/*.js`/`actions/*.js` so handlers stay portable and run-ledger cost accounting cannot be bypassed (#127).
- 2026-05-26 — @srikanth235 — Add `no-hardcoded-model-ids`: forbid concrete provider model ids in production source so model selection moves with capability-tier indirection rather than code edits (#127).
- 2026-05-26 — @srikanth235 — Add `actions-declare-table-writes`: every `app.json#actions[]` entry must declare a `writes:` array so change-stream invalidation cannot silently drop subscribers (#127).
- 2026-05-26 — @srikanth235 — Add `gateway-core-mode-agnostic`: `packages/runtime-core/` may not branch on gateway mode so the "same code, two modes" architecture property holds (#127).

## Escape hatches

Governance is enforced at two layers:

1. **Pre-commit hook** — runs `.governance/run.sh` before each commit. Skip with `SKIP_GOVERNANCE=1 git commit ...` or `git commit --no-verify` when a hotfix cannot wait.
2. **CI workflow** — `.github/workflows/governance.yml` runs the same tests on every PR and push to the default branch. CI cannot be skipped from a developer machine.

The hook is for speed; CI is for enforcement. If a commit lands with the hook skipped, CI will catch it.
