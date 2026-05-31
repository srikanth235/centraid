# issue-145 — rename apps-store→code-store and gateway-runtime→gateway

GitHub issue: [#145](https://github.com/srikanth235/centraid/issues/145)

Follow-on to #142 (app terminology). Two package names still didn't describe
what they do after the architecture moved to "gateway owns the runtime + git
store" (#137). A mechanical, behavior-preserving rename.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Rename `@centraid/apps-store` to `@centraid/code-store`
- [x] Rename `@centraid/gateway-runtime` to `@centraid/gateway`
- [x] Repoint dependents to the new package names
- [x] Dissolve `@centraid/agent-harness` into `@centraid/skills` and `@centraid/app-engine`

## What changed

- **Rename `@centraid/apps-store` to `@centraid/code-store`.** The package
  stores versioned app *code* (git-backed), not "apps". `git mv` of
  `packages/apps-store` → `packages/code-store` with `package.json#name`,
  workspace deps, `tsconfig.json` paths, and importers repointed. No source
  behavior changed.
- **Rename `@centraid/gateway-runtime` to `@centraid/gateway`.** The package
  *is* the gateway (standalone daemon + Electron embed), not a "runtime" layer.
  `git mv` of `packages/gateway-runtime` → `packages/gateway` with the same
  metadata/dep/import repointing.
- **Repoint dependents to the new package names.** `apps/desktop` (package.json
  + `main/local-runtime.ts`), the moved packages' READMEs, `@centraid/app-engine`
  / `@centraid/app-templates` READMEs, and `bun.lock` were updated to the new
  names.
- **Dissolve `@centraid/agent-harness` into `@centraid/skills` and
  `@centraid/app-engine`.** The package mixed three unrelated concerns under a
  misleading name (there is no in-process "agent"/"session" since #141). It is
  now deleted entirely:
  - **Grounding → new `@centraid/skills`.** The two authoring contracts
    (`CENTRAID_APPEND_PROMPT` / `AUTOMATION_APPEND_PROMPT`) become editable
    `SKILL.md` units under `skills/authoring-centraid-apps/` and
    `skills/automation-authoring/` (YAML frontmatter + markdown body, the
    Anthropic Agent Skill format, discoverable by both backends). `composeSkills()`
    concatenates their bodies — byte-equivalent to the old constants. The
    per-turn dynamic grounding that can't be static — live design tokens + icon
    set (`buildUiGroundingBlocks`) and the host-tool list
    (`buildToolsGroundingBlock`) — ships as render functions in the same package.
  - **App file generators → `@centraid/app-engine`.** `scaffold-files`,
    `scaffold`, `scaffold-automation`, `clone`, `app-rewrites`, and
    `scaffold-defaults` moved in (app-engine already parses/validates the app
    format; now it generates too). `HarnessError` was renamed `AppScaffoldError`
    in a new `scaffold-types.ts`; app-engine gained a `@centraid/design-tokens`
    dependency for the scaffold's `tokens.css` snapshot.
  - **Dead gateway HTTP client → deleted.** `gateway-client`, `publish`,
    `app-files`, `config` (and the `tar` dependency) had no consumers and were
    removed.
  - **Gateway rewired.** `unified-chat-runner` composes grounding from
    `@centraid/skills`; the lifecycle routes import the scaffolders +
    `AppScaffoldError` from `@centraid/app-engine`.

## Out of scope

- **Native skill progressive disclosure.** Phase 1 composes the `SKILL.md`
  bodies into the turn instructions (behavior-identical to the old constants);
  wiring each backend's native skill discovery (Claude `settingSources`/`skills`,
  codex `skills/list`) is a follow-up that needs a live spike.
- The dead disk-only scaffold wrappers (`scaffoldApp`, `listAppsOnDisk`,
  `deleteApp`, `updateAppMeta`, `cloneTemplate`) moved with their module rather
  than being stripped; trimming them is deferred cleanup.
- Historical commit-message strings in `receipts/`, `COSTS.md`, and `STEERING.md`
  were left untouched.

## Verification

- `turbo run typecheck` green across all 17 tasks (rename + dissolution).
- `turbo run test` green.
- No stray `apps-store` / `gateway-runtime` / `@centraid/agent-harness`
  references remain outside intentionally-excluded historical files; the new
  package names resolve across the workspace.
