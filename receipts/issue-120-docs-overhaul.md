# Issue #120 — Docs: verify and resolve in-text TODOs

Substantial code changes had accumulated since the docs were last touched, so
rather than only resolving the seeded `TODO(#120)` callouts in isolation, this
was a full re-evaluation of every doc against the current implementation. The
docs site, the top-level project docs, and the per-package READMEs were audited
file-by-file against source, with the code treated as the source of truth.

## Checklist

- [x] Re-evaluated every doc against the current code
- [x] Corrected the conversation/turn/item runtime model
- [x] Rewrote README.md and ARCHITECTURE.md to cover the full backend
- [x] Resolved the inline doc TODO(#120) callouts
- [x] Fixed stale centraid_sql_* tool ids in the OpenClaw plugin
- [x] Removed stray tool-call XML artifacts from the generated docs
- [x] Verified the docs build and the lint/format gates pass

## What changed

**Re-evaluated every doc against the current code.** Rather than patch the most
recent diffs, every page in the docs site, every top-level project doc, and the
per-package READMEs were checked against source and corrected where they had
drifted.

**Corrected the conversation/turn/item runtime model.** The docs described the
ledger as `conversation ⊃ run ⊃ turn ⊃ node` with `runs`/`run_nodes` tables.
The code (issue #190) collapsed that to the conversation/turn/item model —
tables `conversations`, `turns`, `items`, `attachments`, `automation_state`,
with `kind ∈ {chat, build, automation}` living on the conversation. Fixed across
the concept, automation, build, deploy, and reference pages plus `ARCHITECTURE.md`.

**Rewrote README.md and ARCHITECTURE.md to cover the full backend.** Both
previously described only desktop + mobile + design-tokens and ignored the
gateway / app-engine / agent-runtime / automation stack. They now describe the
host-agnostic gateway (embedded / `centraid-gateway` daemon / OpenClaw plugin),
the full 9-package + 2-app layout, and the corrected runtime model. `AGENTS.md`
re-checked and its repo map corrected.

**Re-evaluated the docs site end-to-end.** Every `docs/*.mdx` page verified
against source: dead surfaces removed (`/_chat` → `/_turn`, the
`centraid_sql_*` tool family → `centraid_describe`/`read`/`write` with `_sql`
as the escape hatch, `current.json`/`versions/` tarball model → the git store,
retired `ctx.invoke`/automation journal). Reference pages (`cli`,
`error-codes`, `three-tool-dispatcher`, `governance-directives`, `http-api`)
rewritten to match the real implementations. Package READMEs for app-engine,
automation, blueprints, gateway, and openclaw-plugin brought current.

**Resolved the inline doc TODO(#120) callouts.** ~43 of the seeded callouts
were replaced with content verified against the implementation. Three callouts
in `docs/deploy/openclaw-plugin.mdx` (install command, auth model, desktop
remote-gateway URL UI) are genuinely not captured in this repo and remain as
`TODO(#120)` markers — so #120 stays open.

**Fixed stale centraid_sql_* tool ids in the OpenClaw plugin.** The audit
surfaced that `openclaw.plugin.json#contracts.tools` and
`scripts/setup-tools.mjs` advertised `centraid_sql_describe/read/write`, which
the plugin no longer registers (it registers `centraid_describe/read/write` —
`src/lib/tools.ts`), so the host could grant tool ids that do not exist. Both
corrected. Dropped the dead `versionRetention` config key (never read by
`register()`), and fixed the matching stale source comments in
`codex/backend.ts`, `codex/model-list.ts`, `gateway/paths.ts`,
`app-engine/changes/change-bus.ts`, and `app-engine/runtime.ts`.

**Removed stray tool-call XML artifacts from the generated docs.** Four pages
(`templates/index.mdx`, `templates/authoring.mdx`, `templates/cloning.mdx`,
`deploy/openclaw-plugin.mdx`) had trailing `</content>` / `</invoke>` fragments
accidentally left by the generation pass; removed.

## Out of scope

- The three remaining `TODO(#120)` callouts in `docs/deploy/openclaw-plugin.mdx`
  describe behavior not present in this repo (OpenClaw install command, auth
  model details, desktop remote-gateway URL UI); left as issue-anchored markers,
  so #120 is **not** closed by this work.
- The standalone `centraid-gateway` daemon still runs the legacy tarball/version
  backend rather than the git store; documented as current behavior, not changed.
- Governance-kit artifacts (`CONSTITUTION.md`, `STEERING.md`, `COSTS.md`) and the
  `receipts/` history were not in scope. `TESTING.md` / `QUALITY.md` were already
  current and untouched.
- A few stale source-comment references in non-doc code paths (e.g.
  `run-stream-event.ts` run/node naming, a `weekly-encouragement.json` fixture)
  were noted but left for a separate cleanup.

## Verification

Verified the docs build and the lint/format gates pass:

- **Docs build**: `node scripts/docs-site/build.mjs` → built 39 pages, 35/35 og
  cards rendered, no errors.
- **Format**: `oxfmt --check` clean across all 43 changed `.ts`/`.js`/`.mjs`/
  `.json`/`.mdx` files (the stray tool-call XML artifacts that broke oxfmt
  idempotency on the MDX pages were removed).
- **Lint**: `oxlint` → 0 warnings, 0 errors on the changed code files.
- **Typecheck + tests** for the packages whose source comments / manifest
  changed (app-engine, agent-runtime, gateway, openclaw-plugin): `turbo run
  typecheck` 15/15 successful; `turbo run test` all green (gateway 121 pass / 1
  skip, etc.).
- **Tool-id correctness** re-verified: zero remaining `centraid_sql_` references
  in the changed files; `openclaw.plugin.json` is valid JSON; the advertised ids
  now match `src/lib/tools.ts`.
