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

<!-- pack: governance-kit/foundation -->

### required-docs

- **Directive**: The repo ships the baseline set of root-level documents and local-hook scaffolding expected by governance-kit — every sub-check below is enabled:
    - `constitution` — `CONSTITUTION.md` at repo root, non-empty, ≥ 10 lines.
    - `agents` — `AGENTS.md` at repo root, 30–250 lines (configurable via `AGENTS_MD_MIN` / `AGENTS_MD_MAX` keys in `.governance/conf/governance-kit/foundation/required-docs.conf`, or the matching `GOVERNANCE_*` env vars), with ≥ 3 links to other repo docs (configurable via `AGENTS_MD_MIN_LINKS`), and a link to `CONSTITUTION.md` so the file functions as a map to the bedrock durable docs rather than a standalone manual.
    - `readme` — `README.md`, `README`, or `README.rst` at repo root with a top-level heading and ≥ 30 words.
    - `license` — `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING`, or `COPYING.md` exists at repo root and is non-empty.
    - `security` — `SECURITY.md` (root, `docs/`, or `.github/`) exists and lists a contact email, URL, or vulnerability-disclosure platform.
    - `architecture` — `ARCHITECTURE.md` (root or `docs/`) exists and is ≥ 20 lines (configurable via an `ARCHITECTURE_MIN=` line in `.governance/conf/governance-kit/foundation/required-docs.conf`, or the `GOVERNANCE_ARCHITECTURE_MIN` env var).
    - `ci-workflow` — `.github/workflows/` contains at least one non-governance workflow.
    - `env-example` — when a local `.env` exists, every key in it is declared in `.env.example`.
    - `hooks` — when the installed hook strategy is `githooks`, `.githooks/pre-commit` is tracked + executable, `.githooks/commit-msg` likewise if `commit-message-format` is installed, and `core.hooksPath` points at `.githooks`. No-op on `husky` / `pre-commit.com` strategies.
- **Rationale**: Governance without a discoverable source of truth is tribal knowledge, and a fresh clone with zero local enforcement silently trusts CI for everything. Rolling the individual presence checks into one directive cuts preset sprawl — repos that need to carve out a sub-check do so by amending the directive in-tree (where the change is reviewable), not by flipping nine separate directive ids on or off in CI.
- **Enforced by**: `.governance/packs/governance-kit/foundation/directives/required-docs/check.sh`
- **Exceptions**: Per-sub-check waiver — include `<!-- governance: allow-required-docs <sub-check> <reason> -->` in CONSTITUTION.md to exempt a single sub-check (reason required; a bare token does not waive). Valid sub-check names: `constitution`, `agents`, `readme`, `license`, `security`, `architecture`, `ci-workflow`, `env-example`, `hooks`. The `constitution` sub-check is effectively un-waivable because the waiver host is CONSTITUTION.md itself — if that file is missing or empty, there's nowhere to put the marker. To carve out a sub-check more permanently, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive entirely). The `hooks` sub-check is also a transparent no-op when the installed manifest declares a non-`githooks` hook strategy.

### repo-hygiene

- **Directive**: No tracked file violates any of the following hygiene sub-checks:
    - `merge-markers` — no `<<<<<<<`, `=======`, or `>>>>>>>` at line start in any tracked file.
    - `large-files` — no tracked file exceeds 5 MB (override via a `MAX_FILE_SIZE_MB=` line in `.governance/conf/governance-kit/foundation/repo-hygiene.conf`, or the `GOVERNANCE_MAX_FILE_SIZE_MB` env var).
    - `build-artifacts` — no tracked file matches the artefact denylist (`*.pyc`, `__pycache__/`, `*.class`, `*.o`, `node_modules/`, `dist/`, `build/`, `target/`, `out/`, `.DS_Store`, `Thumbs.db`, editor swap files).
    - `debug-statements` — no stray `console.log`, `debugger`, `breakpoint()`, `import pdb`, `dbg!`, or `fmt.Println` in non-test source (line-level waiver: `# governance: allow-repo-hygiene <reason>`).
    - `file-size-limit` — no source file exceeds 500 lines (override via a `FILE_SIZE_LIMIT=` line in `.governance/conf/governance-kit/foundation/repo-hygiene.conf`, or the `GOVERNANCE_FILE_SIZE_LIMIT` env var), excluding vendor / generated / migrations / protobuf / node_modules. File-level waiver: place `governance: allow-repo-hygiene file-size-limit <reason>` in the first 10 lines of the file (any comment syntax).
- **Rationale**: Merge markers, oversized binaries, build output in the tree, leftover debug prints, and god-files all corrupt the history in slightly different ways, but they share one property: they are almost always accidental. Rolling them into a single directive keeps the catalog honest about how much work each check is doing — none of them is a load-bearing axis on its own, so `minimal` / `standard` / `strict` do not need three separate entries to pick from.
- **Enforced by**: `.governance/packs/governance-kit/foundation/directives/repo-hygiene/check.sh`
- **Exceptions**: The `debug-statements` sub-check supports line-level waivers (`# governance: allow-repo-hygiene <reason>`). The `file-size-limit` sub-check supports file-level waivers (`governance: allow-repo-hygiene file-size-limit <reason>` in the first 10 lines). To carve out a sub-check entirely for your repo, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive). Marked `always_install: true` — the merge-marker sub-check is high-signal and zero-false-positive, and bundling the siblings alongside it keeps hygiene coverage consistent regardless of preset.

### kit-version-sync

- **Directive**: An installed repo carries one kit (framework) version, stamped in exactly one place — `.governance/install.yaml`'s `kit_version` — and re-stamped into every managed runtime file as a `# governance-kit:managed kit-version=<v>` marker. This directive asserts they all agree: each managed file's marker must equal the manifest's `kit_version`. The managed set is derived from the manifest (`tests_dir`'s `run.sh` / `lib.sh`, `ci_workflow`, `enable_governance_script`, and the `.githooks/*` dispatchers when `hook_strategy: githooks`), so the directive checks exactly what `init` wrote and never guesses at marker-bearing files. It is a no-op when `.governance/install.yaml` is absent or carries no `kit_version`.
- **Rationale**: The kit version is duplicated by necessity — it lives in the manifest, in the skill frontmatter, and in a per-file marker on every runtime file (so `kit update` can detect per-file drift and reconstruct the manifest if it is lost). Duplication that is enforced only by discipline rots: a hand edit, a half-finished `kit update`, or a bad merge can leave the repo straddling two kit versions, and `kit update`'s own drift detection trusts those markers. For a kit whose entire thesis is "every rule has an executable test," the kit's own version invariant must itself be a test rather than an honour-system field. This directive closes that gap with a cheap repo-state check that fails fast the moment the stamps diverge.
- **Enforced by**: `.governance/packs/governance-kit/foundation/directives/kit-version-sync/check.sh` (Mode B — CI/run.sh inspects repo state) and `.githooks/pre-commit`. Reads `.governance/install.yaml`.
- **Exceptions**: None beyond the no-op when the manifest or its `kit_version` is absent. The repair path is `governance kit update` (or re-running the release tooling), which re-stamps every managed file from the single source of truth. See `kit/references/VERSIONING.md`.

<!-- pack: governance-kit/security -->

### secrets-hygiene

- **Directive**: No tracked file violates either of the following sub-checks:
    - `hardcoded-credentials` (CWE-798) — no tracked file contains a plaintext AWS / GCP / GitHub / Slack / Stripe token, private-key block, or generic `api_key = "..."` literal, per the directive's heuristic pattern set (line-level waiver: `# governance: allow-secrets-hygiene <reason>`).
    - `dotenv` — `.env` (and `.env.*` except `.env.example` / `.env.sample` / `.env.template`) is not tracked, and `.gitignore` exists and covers `.env`.
- **Rationale**: A leaked credential in git history is a credential compromised — rotation is the only recourse. `.env` is where those credentials most commonly live, so closing the door on tracking it complements the pattern scan that catches the ones that slip past into source. Treat the two as one directive: they share a failure mode and both belong on every commit.
- **Enforced by**: `.governance/packs/governance-kit/security/directives/secrets-hygiene/check.sh`
- **Exceptions**: For documented, intentional fixtures, append `# governance: allow-secrets-hygiene <reason>` to the offending line — the waiver is visible in `git blame` and searchable by design. To carve out a sub-check entirely for your repo, use `governance directive modify` to amend the script (or `governance directive remove` to drop the directive).

### pinned-dependencies

- **Directive**: Every third-party GitHub Action (anything outside the `actions/*` and `github/*` namespaces) used in `.github/workflows/*.yml` (or `*.yaml`) is pinned to a full 40-character commit SHA, not a moving tag. This is the OpenSSF Scorecard *Pinned-Dependencies* check. It is the future home for the rest of the pinning family — container-image digests, install-command pinning, and manifest/lockfile sync.
- **Rationale**: Tag pins are mutable; SHA pins are not. A compromised third-party action with write access is a supply-chain vulnerability, and tag-pinning is precisely the gap the tj-actions/changed-files compromise exploited in 2025 — a moved tag silently swapped trusted code for an attacker's.
- **Enforced by**: `.governance/packs/governance-kit/security/directives/pinned-dependencies/check.sh`
- **Exceptions**: For a deliberately tag-pinned action, append `# governance: allow-pinned-dependencies <reason>` to the offending `uses:` line — the waiver is visible in `git blame` and searchable by design.

### token-permissions

- **Directive**: Every `.github/workflows/*.yml` (or `*.yaml`) declares a `permissions:` block — top-level or per-job — so the workflow runs with a least-privilege token rather than the repository's broad default. This is the OpenSSF Scorecard *Token-Permissions* check.
- **Rationale**: A missing `permissions:` block inherits a default that most jobs do not actually need. A compromised step or action then holds write access it should never have had. Declaring permissions explicitly is the cheapest blast-radius reduction available to a workflow.
- **Enforced by**: `.governance/packs/governance-kit/security/directives/token-permissions/check.sh`
- **Exceptions**: For a workflow that legitimately needs no explicit block, add `# governance: allow-token-permissions <reason>` within the first ten lines of the workflow file — the waiver is visible in `git blame` and searchable by design.

<!-- pack: governance-kit/docs -->

### doc-freshness

- **Directive**: Docs opted into `.governance/conf/governance-kit/docs/doc-freshness.conf` carry a `<!-- last-verified: YYYY-MM-DD -->` marker dated within the last 90 days (configurable via a `FRESHNESS_DAYS=` line in that file, or the `GOVERNANCE_FRESHNESS_DAYS` env var). No-op if the config file is absent.
- **Rationale**: Critical runbooks and onboarding docs decay. A periodic "someone re-read this" checkpoint keeps them honest — if the deadline passes, either the doc still reflects reality (bump the date) or it doesn't (fix it).
- **Enforced by**: `.governance/packs/governance-kit/docs/directives/doc-freshness/check.sh`
- **Exceptions**: Remove a doc from `.governance/conf/governance-kit/docs/doc-freshness.conf` to opt it out entirely. Per-file waiver — include `governance: allow-doc-freshness <reason>` anywhere in the doc (typically as an HTML comment alongside the `last-verified` marker) to keep the doc in the config but exempt it from the staleness check (reason required; a bare token does not waive). The waiver is visible in `git blame` and searchable; use it for docs awaiting a known rewrite rather than as a long-term escape hatch.

### internal-doc-links

- **Directive**: The internal markdown link graph across tracked `.md` files is healthy. Two sub-checks over the same set of relative markdown links:
    1. **resolve** *(always on)* — every relative-path link target resolves to an existing file. Targets of every kind are checked (other docs, images, scripts, directories), not just `.md`.
    2. **reachable** *(opt-in)* — every tracked `.md` is reachable by following internal links from one of the entry-point ("root") docs declared in `.governance/conf/governance-kit/docs/internal-doc-links.conf` (`root <path>` / `exclude <glob>` lines). **No-op when the config file is absent or names no roots.** Directive folders, skill asset templates, and eval fixtures are always excluded.
- **Rationale**: `resolve` proves the links you have point somewhere real — a broken link rots silently, the doc still renders but lies, and an agent that follows it bails. `reachable` proves the docs you wrote are on the map — from an agent's point of view a doc no path of links leads to is as invisible as a Slack thread. Together they keep the repo a connected graph rooted at the entry points an agent actually starts from (`AGENTS.md`, `README.md`), not a pile of files only `grep` can find. They share one directive because they parse the same link graph; `resolve` is the always-on minimum while `reachable` is opt-in, because "every doc must be linked" is a policy only some repos want and would otherwise false-positive on receipts, changelogs, and generated docs.
- **Enforced by**: `.governance/packs/governance-kit/docs/directives/internal-doc-links/check.sh`
- **Exceptions**:
    - *resolve*: line-level waiver — append `<!-- governance: allow-internal-doc-links <reason> -->` (or any comment syntax `grep` sees on the line) to the line with the broken link. Use it for template placeholders or syntax-demonstrating prose, not as long-term cover for rot.
    - *reachable*: a configured `exclude <glob>` line, or a head-of-file comment `governance: allow-internal-doc-links reachable <reason>` in the orphan's first 10 lines (e.g. an intentionally unlinked changelog or generated doc).

    Both are visible in `git blame` and discoverable via `grep -r 'allow-internal-doc-links'`.

<!-- pack: governance-kit/commits -->

### commit-message-format

- **Directive**: Commit messages match `<type>(scope)?!?: subject (#123)` — a Conventional Commits prefix **plus** a trailing GitHub issue reference. The default types ship in the directive's `defaults.conf` (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`, `style`). Customize via the overlay `.governance/conf/governance-kit/commits/commit-message-format.conf`: a bare line adds a type, `!<type>` removes a default.
- **Rationale**: The typed prefix keeps changelogs scannable; the trailing `(#123)` anchors every commit to a durable work item. Together they make `git log` a readable audit trail instead of a stream of "fix stuff". The two halves are enforced as one rule because a Conventional Commits message without the issue anchor is still a hole in the audit trail this kit cares about.
- **Enforced by**: `.governance/packs/governance-kit/commits/directives/commit-message-format/check.sh` (also wired into the `.githooks/commit-msg` dispatcher).
- **Exceptions**: Merge and revert commits are skipped automatically. Per-commit waiver — a line `governance: allow-commit-message-format <reason>` in the commit body exempts that commit from the subject-format check (reason required; a bare token does not waive). The waiver lives in the body since the subject itself is what the check inspects; the audit trail is `git log --grep='allow-commit-message-format'`.

### no-orphan-todos

- **Directive**: Every `TODO` or `FIXME` comment references either a GitHub issue (`#123`) or a tracker ticket (`ABC-123`).
- **Rationale**: A bare `TODO` is a promise to nobody. An issue-linked TODO is a promise that someone, somewhere, can follow up on — and that survives the author changing teams.
- **Enforced by**: `.governance/packs/governance-kit/commits/directives/no-orphan-todos/check.sh`
- **Exceptions**: Append `governance: allow-no-orphan-todos <reason>` to the offending line for rare intentional exceptions.

<!-- pack: governance-kit/audit -->

### commit-issue-receipt-match

- **Directive**: For every non-merge, non-revert commit in scope, some issue the commit anchors — either the trailing `(#N)` in the subject or any `Issue: #N` trailer in the body — matches an `issue-<N>` token on at least one `receipts/*.md` file the commit adds or modifies. A commit that touches no `receipts/*.md` fails this directive. Accepting body `Issue:` trailers keeps post-squash-merge history valid: the subject carries the PR id while the folded sub-commits preserve their original `Issue:` anchors (stamped by `agent-token-accounting`).
- **Rationale**: `commit-message-format` pins each commit to an issue and `receipt-per-issue` pins each receipt to an issue, but nothing cross-checks the two — a commit claiming `(#15)` while touching only issue #42's receipt passes both directives in isolation. This directive closes that hole, so the receipt the agent updates must be the *right* one for the commit's issue. It also subsumes the "every substantive commit must touch the receipt" obligation, which is what makes the receipt a live audit artifact rather than an end-of-work afterthought.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/commit-issue-receipt-match/check.sh` (Mode B — CI walks merge-base → HEAD) and `.githooks/commit-msg` (Mode A — validates the pending commit against its staged diff).
- **Exceptions**: Merge commits and revert commits are exempt (mirrors `commit-message-format`). Per-commit waiver — a line `governance: allow-commit-issue-receipt-match <reason>` in the commit body exempts that commit (reason required; a bare token does not waive).

### doc-integrity

- **Directive**: System-of-record documents are append-only relative to the change set's baseline — the default-branch merge-base. The protected set ships as standard rules in the directive's `defaults.conf`, customized per repo via the overlay `.governance/conf/governance-kit/audit/doc-integrity.conf` (a bare rule line adds a rule, `!<rule>` drops a default). Each rule is `<mode> <path> [arg]`; if the effective rule set is empty the directive is a no-op. Three modes:
    - `frozen-files <glob>` — every file matching `<glob>` that exists at the baseline is byte-immutable; it may not be modified, renamed, or deleted, but new files may be added. (e.g. `receipts/*.md` — which now also carry the per-issue accounting rows — and the sealed legacy `COSTS.md` / `STEERING.md` ledgers.)
    - `append-only <file>` — the baseline version of `<file>` must be an exact byte-prefix of the current version. Existing content may not change and the file may not shrink or be deleted; only appended lines are allowed. (Available for any opt-in growth-only log, e.g. a `docs/DECISIONS.md`.)
    - `frozen-section <file> <heading>` — every line present under `## <heading>` (any heading level) at the baseline must still appear, verbatim, under that heading now. The rest of the file is free, and reordering or inserting lines is fine; editing or deleting a baseline line is not. (e.g. `QUALITY.md`'s `Resolved` section, `CONSTITUTION.md`'s `Evolution Log`.)
  Content authored within the current branch is absent at the baseline, so it stays editable until it merges — only what is already on the default branch is frozen. When no default branch resolves (a commit made directly on the trunk), the baseline falls back to HEAD.
- **Rationale**: The receipts (which now carry the per-issue cost and steering accounting under `## Accounting`), the sealed legacy ledgers, the resolved-issues log, and the constitution's own evolution log are the repo's durable record of *what happened*. They are only trustworthy as evidence if their history can't be quietly rewritten — a record edited after the fact (to soften an admitted tradeoff, drop a resolved bug, alter a past cost row, or rewrite an amendment's history) is no longer evidence of what was true when it landed. The kit already preaches "ledgers over transcripts" and the evolution log literally says "append, do not rewrite history," but nothing mechanically froze the *historical* portion of any of these documents — the accounting directives only validate that *new* rows are well-formed, not that old ones survive. This directive is the single integrity engine that closes that gap across every system-of-record document, with the granularity each one needs. Accounting moved into per-issue receipts (issue #201), so `frozen-files receipts/*.md` now covers all go-forward accounting history once a receipt merges; the old central `COSTS.md` / `STEERING.md` stop receiving rows and are sealed in place (`frozen-files`, flipped from `append-only`) as immutable history. Scoping immutability to the default-branch baseline (rather than HEAD) keeps it compatible with the live-build workflow `commit-issue-receipt-match` mandates: an agent still iterates its in-flight receipt — appending accounting rows across the multi-commit cycle — because that content is absent at the baseline; only the trunk's history is frozen.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/doc-integrity/check.sh` (Mode B — CI walks merge-base → HEAD) and `.githooks/commit-msg` (Mode A — validates the pending commit against its staged diff). Protected documents come from the directive's `defaults.conf`, layered with the repo's `.governance/conf/governance-kit/audit/doc-integrity.conf` overlay.
- **Exceptions**: Path-scoped per-change-set waiver — a line `governance: allow-doc-integrity <path> <reason>` in a commit body (Mode B: any commit in `base..HEAD`; Mode A: the pending body) exempts `<path>` from the check (reason required; a bare token does not waive). For `frozen-files`, `<path>` is the specific file being rewritten. Reserve it for a coordinated, reviewed rewrite — e.g. a file rename that breaks an internal link inside an old receipt, or a one-time ledger migration — not as routine cover. Audit trail: `git log --grep=allow-doc-integrity`. A document covered by no effective rule is unconstrained. Marked `always_install: true` — like `repo-hygiene` and `agent-steering-accounting`, it bypasses preset selection and installs in every repo; the standard rules ship active in `defaults.conf` (each a no-op until its document exists, so the default costs nothing on repos that don't use a given file), and a repo drops any default with a `!<rule>` line in its overlay.

### issue-templates

- **Directive**: `.github/ISSUE_TEMPLATE/config.yml`, `proposal.yml`, and `bug.yml` exist; blank issues are disabled; the proposal form requires Context, Decision, Scope, Acceptance criteria, Validation, and Open questions; and the bug form requires the core defect-report fields.
- **Rationale**: Agent-created GitHub issues are the durable output of brainstorming sessions. Requiring the settled decision, scope, acceptance criteria, validation, and open questions in the issue form keeps a future implementing agent from re-deriving intent from chat history.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/issue-templates/check.sh`
- **Exceptions**: Whole-directive waiver — include `<!-- governance: allow-issue-templates <reason> -->` in CONSTITUTION.md to skip the directive entirely (reason required; a bare token does not waive). Use when the repo intentionally does not use GitHub Issues — tracking lives in Linear / Jira / GitLab and the templates would be dead code. The waiver is discoverable in CONSTITUTION.md (the source-of-truth for repo-level deviations) and auditable via grep.

### issues-tracked

- **Directive**: `QUALITY.md` exists at the repo root with a top-level `# ` heading and contains `## Open` and `## Resolved` sections.
- **Rationale**: Bugs and quality observations discovered between releases rot in Slack and memory. Tracking them in a file keeps them in the system of record, diff-auditable, and greppable by agents and humans alike.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/issues-tracked/check.sh`
- **Exceptions**: Empty sections are allowed; the file itself is the contract. Whole-directive waiver — include `<!-- governance: allow-issues-tracked <reason> -->` in CONSTITUTION.md to skip the directive entirely (reason required; a bare token does not waive). Use when the repo tracks bugs elsewhere (Linear / Jira / GitHub Issues only) and QUALITY.md would be dead state.

### receipt-per-issue

- **Directive**: Every tracked `receipts/*.md` file satisfies the following shape rules:
    1. The filename matches `issue-<N>.md` or `issue-<N>-<slug>.md` where `<N>` is the GitHub issue number and the optional `<slug>` is one or more kebab-case tokens (lowercase letters, digits, hyphens). The slug is optional because the accounting hooks (issue #201) create slugless `issue-<N>.md` receipts on demand; an agent may add a slug by renaming. No two receipts share the same issue number.
    2. The body contains four Markdown sections — `## Checklist`, `## What changed`, `## Out of scope`, and `## Verification` — naming the work plan, the surface area touched, the deferred work, and the criteria a reviewer uses to judge completion. These four are checked on every tracked receipt.
    3. The `## Checklist` mirrors the linked GitHub issue's checklist. Each completed item (`- [x] …`) must have its item text appear — as a case-insensitive substring — somewhere in the receipt's `## What changed` or `## Verification` section. Unchecked items (`- [ ] …`) are unconstrained; they represent remaining work and need no crosswalk.
    4. A fifth section, `## Decisions`, is required only on receipts **added in the current change set** (staged additions at pre-commit; `base..HEAD` additions in CI). It records the off-spec decisions, forced changes, and tradeoffs a reviewer should know about; a receipt whose work followed the spec exactly writes "None". Receipts that predate the change set are grandfathered — the section is forward-looking and the historical corpus is never retroactively swept.
    5. On receipts **added in the current change set**, the `## Verification` section must contain at least one fenced code block. "Ran the tests" is a claim a reviewer cannot replay; a fenced command (e.g. ```` ```sh\nbash .governance/run.sh\n``` ````) is one they can. Same forward-looking change-set scope as rule 4 — pre-existing receipts are grandfathered.
  - **Accounting-only stub exemption (issue #201):** a receipt whose only `## ` heading is `## Accounting` is an accounting-only stub — what the `agent-token-accounting` / `agent-steering-accounting` pre-commit hooks create when a commit's first accounted event fires before the agent has written the narrative. A stub is exempt from rules 2–5 (the four-section shape, the crosswalk, and the change-set `## Decisions` / runnable-`## Verification` requirements) until the agent adds any narrative section. Its `### Costs` / `### Steering` tables are validated by the accounting directives, and rule 1 (filename + uniqueness) still applies. Once the agent adds a narrative `## ` section the receipt is no longer a stub and the full shape is enforced — the implementer chose stub-exemption over hook-stubbing the four sections so the hook never writes placeholder prose it cannot truthfully fill.
- **Rationale**: Receipts are the durable post-implementation audit trace for work an agent did against a GitHub issue. The one-receipt-per-issue binding keeps the system of record unambiguous: a reviewer jumps from an issue to its single receipt, and an agent can detect whether an issue already has a receipt before drafting a duplicate. The four always-checked sections force the agent to write the parts a reviewer actually needs — `Checklist` (the agent's mechanical "I am done" signal, mirroring the issue), `What changed` (the surface area), `Out of scope` (so omissions are not mistaken for oversights), and `Verification` (how completion is judged). The checklist crosswalk is the local trust boundary: without it, the agent could silently flip boxes from `[ ]` to `[x]` without writing evidence; with it, every checked item must appear in the receipt's prose, so a reviewer confirms claimed-done items map to described work without leaving the diff. Substring matching (rather than a strict anchor syntax) keeps the discipline cheap to satisfy — paraphrasing the item into a What-changed bullet is enough. The `Decisions` section captures the judgment calls the diff cannot show — why the agent diverged from the spec, what it had to change, and what it traded off; it is presence-only with no crosswalk, so a receipt whose work followed the spec exactly writes "None", which is itself a signal (the agent actively confirmed there were no surprises) rather than an empty omission. Scoping `Decisions` to newly added receipts keeps the rule forward-looking: new work owes the new discipline, the historical corpus stays an honest record of what was true when it was written, and no blanket waiver or backfill is needed to grandfather it. The `## Verification` fenced-command rule, scoped the same way, closes the gap where an agent writes a plausible-sounding "verified by …" prose line that no one can replay; a copy-pasteable command turns the verification claim into a reproducible receipt. In this repo's mental model, all code is authored by coding agents, so the receipt is the agent's attestation to the human reviewer. Receipts are distinct from the pre-implementation plans Claude Code / Codex produce in plan-mode — those are an agent-runtime concept, out of governance scope.
- **Enforced by**: `.governance/packs/governance-kit/audit/directives/receipt-per-issue/check.sh`
- **Exceptions**: Per-receipt waiver — include `governance: allow-receipt-per-issue <reason>` (typically as an HTML comment) in the first 10 lines of a receipt to exempt it from all shape rules (filename, sections, crosswalk, and the change-set `## Decisions` requirement). Reason required; a bare token does not waive. Use sparingly — receipts are a fresh discipline, the waiver is meant for stub / WIP / handoff receipts that legitimately cannot meet the shape yet, not as long-term cover. Pre-existing receipts need no waiver for the `## Decisions` rule — they are grandfathered by the change-set scope. Audit trail: `grep -r 'allow-receipt-per-issue' receipts/`.

<!-- pack: srikanth235/centraid -->

### query-handlers-read-only

- **Directive**: centraid query handlers (`*/queries/*.js`) must not mutate the database — no `stmt.run()`, no `db.exec()`. Use `actions/*.js` (dispatched via `centraid_write` / `POST /centraid/_tool/centraid_write`) for any writes.
- **Rationale**: the runtime's handler-runner skips SQLite session tracking for `handlerKind === 'query'` as a perf optimization on the read path (`packages/app-engine/src/handler-runner.ts`). Writes from a query handler succeed but are invisible to the change-notification SSE feed at `/centraid/<id>/_changes`, so subscribed iframes never re-fetch — UI goes silently stale with no error anywhere. Mutations must live where the bus actually observes them.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/query-handlers-read-only/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-query-handlers-read-only <reason>` for the rare opt-in case (e.g. lazy view materialization on first access).

### handler-uses-ctx-primitives

- **Directive**: centraid handlers (`**/queries/*.js`, `**/actions/*.js`) must not import provider SDKs directly (`@anthropic-ai/sdk`, `openai`, `groq-sdk`, `@google/generative-ai`, `cohere-ai`, `@mistralai/mistralai`, `replicate`, `together-ai`). Inference and other gateway-managed capabilities flow through `ctx.infer.*` and related primitives supplied by the handler-runner.
- **Rationale**: handler-as-source-of-truth. Extending `ctx.*` is the supported way to grow capabilities. Reaching past it (a) defeats per-profile model routing, (b) bypasses run-ledger cost accounting in `runtime.sqlite`, and (c) couples the handler to a specific provider — breaking the embedded ↔ OpenClaw gateway portability that the architecture's "same code, two modes" property depends on.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-handler-uses-ctx-primitives <reason>` for the rare opt-in case (e.g. an action that legitimately needs to call a provider directly during a controlled experiment).

### no-hardcoded-model-ids

- **Directive**: production source under `packages/` and `apps/` must not reference concrete provider model ids (`claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5`, `o1-mini`, `gemini-2.0-flash`, etc.) inside string literals. Model selection flows through capability tiers resolved at runtime. The single allowlisted file is `packages/app-engine/src/model-pricing.ts` (the price table is by definition a model-id-to-price map). Test files (`**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`) are excluded since they exercise the pricing and storage layers and need real ids.
- **Rationale**: provider-agnostic inference. The model lineup churns - Anthropic, OpenAI, Google, and Meta ship new flagship models every few months and retire old ones on a similar cadence. Code that references `claude-sonnet-4-5` directly is a maintenance liability the moment the next minor version ships. Capability tiers (`tier:fast`, `tier:smart`) abstract that churn behind a runtime resolver and let model selection move with operator preferences and per-profile routing without code edits.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/no-hardcoded-model-ids/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-no-hardcoded-model-ids <reason>` for the rare opt-in case (e.g. a controlled experiment that pins a specific model intentionally).

### actions-declare-table-writes

- **Directive**: every entry in a centraid `app.json#actions[]` array must include a `writes:` field whose value is an array of table names. Empty arrays (`writes: []`) are allowed and signal "this action performs no database writes" (e.g. a webhook-only action). Missing or non-array `writes` is rejected. Applies to all tracked `**/app.json` files whose top-level `manifestVersion` is set (distinguishing Centraid manifests from `apps/mobile/app.json`, which is an Expo config).
- **Rationale**: same foot-gun shape as [[query-handlers-read-only]]. The change-stream SSE feed at `/centraid/<id>/_changes` uses each action's declared `writes:` tables to invalidate per-table query subscriptions. A missing or wrong `writes` field is silently broken: the mutation succeeds, the bus stays quiet, subscribed iframes never re-fetch, UI goes stale with no error. Making the declaration mandatory turns "I forgot to list the table" into a commit-time failure instead of a runtime mystery.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/actions-declare-table-writes/check.sh`
- **Exceptions**: none. JSON has no comment syntax, and the check is file-level; the right opt-out for a no-DB-write action is the explicit empty array.

### gateway-engine-mode-agnostic

- **Directive**: code under `packages/app-engine/` may not branch on which gateway mode it is running under. Specifically, gateway-mode-discrimination identifiers (`gatewayMode`, `gatewayKind`, `gateway_mode`, `gateway_kind`, `isEmbeddedGateway`, `isOpenClawGateway`, `isLocalGateway`, `isRemoteGateway`, `deploymentMode`, `hostingMode`) are forbidden in tracked source files. Mode-specific behavior belongs at the entrypoints: `apps/desktop/src/main/` for the embedded gateway, `packages/openclaw-plugin/src/` for the OpenClaw gateway.
- **Rationale**: the architecture's "same code, two modes" property is what makes "local-first with optional remote" cheap rather than expensive. Once `app-engine` starts checking which host it lives inside, dev and prod paths diverge and "works on my machine" becomes a class of bug again. Centraid's docs frame this explicitly: "the split exists only at the chat backend and the reachable-from surface; the rest of the gateway is byte-identical." Encoding that promise as a check stops it from rotting silently the next time someone is tempted to add a one-liner branch.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/gateway-engine-mode-agnostic/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-gateway-engine-mode-agnostic <reason>` for the rare case where app-engine genuinely needs to inspect its host (none today; the architecture promise is that no such case should exist).

### data-runtime-sqlite-separation

- **Directive**: centraid handler files (`**/queries/*.js`, `**/actions/*.js`) may not reference `runtime.sqlite` in any form (no path strings, no `path.join(..., 'runtime.sqlite')`, no `new Database('.../runtime.sqlite')`). Handlers see only the app's `data.sqlite` via the `ctx.db` proxy.
- **Rationale**: each app has two SQLite files with distinct owners. `data.sqlite` is app-owned and is what `ctx.db` proxies onto. `runtime.sqlite` is gateway-owned and holds chat sessions, the agent run ledger, and automation state. A handler that opens or names `runtime.sqlite` is a layering violation: it reads/writes state the gateway treats as its own and the change-stream would never invalidate. The matching reverse direction - gateway core staying out of `data.sqlite` outside the handler-runner / three-tool dispatcher path - is harder to specify statically (there are multiple legitimate openers and an allowlist would be brittle). Left to code review for now; this directive enforces the easy half.
- **Enforced by**: `.governance/packs/srikanth235/centraid/directives/data-runtime-sqlite-separation/check.sh`
- **Exceptions**: per-line waiver `// governance: allow-data-runtime-sqlite-separation <reason>` on the offending line. No legitimate case is anticipated today.

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
- 2026-05-26 — @srikanth235 — Add `gateway-engine-mode-agnostic`: `packages/app-engine/` may not branch on gateway mode so the "same code, two modes" architecture property holds (#127).
- 2026-05-26 — @srikanth235 — Add `data-runtime-sqlite-separation`: handler files may not reference `runtime.sqlite` (gateway-owned chat/run/automation state); enforces the easy half of the data-vs-runtime SQLite ownership boundary (#127).
- 2026-06-10 — @srikanth235 — Kit update 0.3 → 0.3.5 + core pack 0.3.2 → 0.4.0. Adds `doc-integrity` (system-of-record documents declared in `.governance/integrity.conf` are append-only relative to the default-branch baseline) and `version-consistency` (every managed-file `kit-version=` marker must agree with `install.yaml`); updates `receipt-per-issue` to require a `## Decisions` section on newly added receipts (#232).
- 2026-06-12 — @srikanth235 — Migrate off the retired monolithic `governance-kit/core` pack onto the 0.6.0 concern-scoped packs (foundation, security, docs, commits, audit) (#241). Renames `version-consistency`→`kit-version-sync` and `no-broken-internal-doc-links`→`internal-doc-links`; splits `workflows-hardened`→`pinned-dependencies`+`token-permissions`. Held back the 0.6.0 net-new / changed-model directives (`toolchain-config-protection`, `no-unjustified-suppressions`, and the receipts-based `agent-token-accounting`/`agent-steering-accounting`) for deliberate adoption; `COSTS.md`/`STEERING.md` kept append-only via the doc-integrity overlay.

## Escape hatches

Governance is enforced at two layers:

1. **Pre-commit hook** — runs `.governance/run.sh` before each commit. Skip with `SKIP_GOVERNANCE=1 git commit ...` or `git commit --no-verify` when a hotfix cannot wait.
2. **CI workflow** — `.github/workflows/governance.yml` runs the same tests on every PR and push to the default branch. CI cannot be skipped from a developer machine.

The hook is for speed; CI is for enforcement. If a commit lands with the hook skipped, CI will catch it.
