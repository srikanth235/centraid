# Receipt — issue-1: bootstrap repo docs to satisfy required-docs

Closes [#1](https://github.com/srikanth235/centraid/issues/1).

## Checklist

- [x] README.md
- [x] LICENSE (MIT)
- [x] SECURITY.md
- [x] ARCHITECTURE.md
- [x] .github/workflows/ci.yml
- [x] Replaced the *What this repo is* placeholder in `AGENTS.md`
- [x] receipts/issue-1.md

## What changed

- New `README.md` at repo root summarises the monorepo: Electron desktop app, Expo mobile app, shared design tokens, build orchestration via turbo + bun, and the governance overlay. Lists develop / build / check commands.
- New `LICENSE` (MIT) covers the repository under standard MIT terms.
- New `SECURITY.md` documents the vulnerability disclosure contact (`srikanth@crowdshakti.com`), the supported-versions policy (only `main`), and what is in / out of scope.
- New `ARCHITECTURE.md` covers the workspace layout (`apps/desktop`, `apps/mobile`, `packages/design-tokens`, `packages/tsconfig`), the cross-surface design-token model, the four turbo tasks (build / dev / typecheck / lint), and the governance overlay.
- New `.github/workflows/ci.yml` runs `bun install --frozen-lockfile`, `bun run check`, and `bun run typecheck` on `push` to `main` and on every `pull_request`. Third-party actions are pinned to a SHA per the `workflows-hardened` template; explicit `permissions: contents: read` is declared.
- Replaced the *What this repo is* placeholder in `AGENTS.md` with a real summary of the surfaces, runtime stack, and the conventions agents need to know (issue → receipt flow, Conventional Commits + issue ref, auto-stamped token / steering trailers, QUALITY.md ledger).
- Added `receipts/issue-1.md` (this file) so `commit-issue-receipt-match` has a receipt to bind the commit to issue #1.

## Out of scope

- Real product documentation beyond a minimal map of where things live. Per-app READMEs and per-package design docs come later.
- License selection beyond defaulting to MIT. Open follow-up if a different license is wanted.
- Hardening the CI workflow beyond a basic typecheck + lint gate. No test runner is wired up because no tests exist yet.
- Changes to `apps/`, `packages/`, or root config (`turbo.json`, `package.json`, `bunfig.toml`, etc.) — none of those need to move for `required-docs` to pass.

## Verification

- `bash .governance/run.sh` exits 0 — all 12 directives pass, including `required-docs` (README.md, LICENSE, SECURITY.md, ARCHITECTURE.md, ci.yml as a non-governance workflow, AGENTS.md fleshed out, .githooks tracked) and `secrets-hygiene` (`.env` was added to `.gitignore` in the bootstrap commit).
- The commit message is `docs: bootstrap repo baseline docs (#1)` — matches `commit-message-format` (Conventional Commits prefix + trailing issue reference).
- `receipts/issue-1.md` carries the four required sections (Checklist / What changed / Out of scope / Verification); each checked item above appears as a substring in *What changed* or *Verification*.
- `COSTS.md` and `STEERING.md` will receive auto-stamped rows from the agent-token-accounting and agent-steering-accounting hooks during the commit.
- The new CI workflow appears under Actions on the PR (governance.yml + ci.yml both run).
