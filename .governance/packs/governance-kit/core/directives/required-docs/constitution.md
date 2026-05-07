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
