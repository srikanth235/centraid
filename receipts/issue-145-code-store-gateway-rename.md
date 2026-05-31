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

## Out of scope

- The **agent-harness dissolution** (move scaffolders into `@centraid/app-engine`,
  extract grounding into `@centraid/skills`, delete the dead HTTP client) — a
  separate change tracked under this same issue, landing in its own commits.
- Historical commit-message strings in `receipts/`, `COSTS.md`, and `STEERING.md`
  were left untouched.

## Verification

- `turbo run typecheck` green across all 18 tasks after the rename.
- No stray `apps-store` / `gateway-runtime` references remain outside
  intentionally-excluded historical files; the new package names resolve across
  the workspace.
