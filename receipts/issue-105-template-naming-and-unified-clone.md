# issue-105 — Template + app naming: collision handling + unified clone path

GitHub issue: [#105](https://github.com/srikanth235/centraid/issues/105)

Three interlocking naming issues across the home shelf, rename flow, and
clone paths get resolved together. The mental model the user pushed
for — "an automation is just an app with no UI assets" — drives a final
refactor that routes both kinds of templates through the same
`cloneTemplate` IPC, eliminating the divergent `createAutomation` /
`scaffoldAutomationProject` path for template adoption.

## Checklist

- [x] Commit 1 — hide `auto.*` automation apps from home My apps
- [x] Commit 2 — reject rename to a display name already in use
- [x] Commit 3 — collision-safe template clone — paired id+name suffix + index.html title rewrite
- [x] Commit 4 — unify automation + app template paths

## What changed

### Commit 1 — hide `auto.*` automation apps from home My apps

`hydrateDrafts()` was sourcing the home draft grid from
`listProjects(appsDir)`, which returns every directory under `appsDir`
including `auto.*` automation app folders. The fix is one filter at the
source — all downstream consumers (home shelf "My apps" tab, sidebar
drafts list, Discover all-apps view) read from the same `drafts` array,
so one filter covers them.

### Commit 2 — reject rename to a display name already in use

`updateProjectMeta` previously validated only the directory id, never
the new `app.json#name`, so two apps could end up with the exact same
tile title (only distinguishable by hovering). A new
`assertDisplayNameUnique(projectsDir, selfId, name)` scans sibling
projects and throws `HarnessError('already_exists')` on a
case-insensitive, whitespace-trimmed match. The existing renderer
try/catch paths surface the error verbatim as a toast.

Globally unique across `appsDir` — including `auto.*` automation apps —
matching the user's explicit "hard reject" choice. Description-only
patches bypass the check so legacy duplicate names don't block
description edits.

### Commit 3 — collision-safe template clone — paired id+name suffix + index.html title rewrite

Two prior gaps:

- **Display name was verbatim**, regardless of the suffix on the id.
  Cloning "Hydrate" three times produced `hydrate-2/3/4` but every tile
  read "Hydrate".
- **`index.html` `<title>`** was copied unchanged from the template's
  hardcoded brand.

Fixes:

- New `suggestCloneIdentity(projectsDir, baseId, baseName)` in
  `clone.ts` advances both `id` and `name` in lockstep — `N=2,3,4,…` —
  until both `<baseId>-N` is free as a directory AND `<baseName> N` is
  free as a display name. The template's bare id/name is never consumed
  (`N >= 2`), and a sibling app the user previously renamed to e.g.
  "Hydrate 2" forces the next clone to skip to `N=3`.
- New `rewriteIndexHtmlTitle(destDir, newName)` replaces the first
  `<title>...</title>` in the cloned `index.html` with the HTML-escaped
  new name. No-op when no `index.html` ships (automation templates), so
  the same call site serves both kinds.
- The `TEMPLATES_CLONE` IPC default branch uses `suggestCloneIdentity`;
  the caller-specified-id branch keeps the old `suggestAppId` behavior.

### Commit 4 — unify automation + app template paths

Automation templates were a hardcoded `AUTOMATION_TEMPLATES` array in
the renderer that drove `adoptTemplate(...)` → `createAutomation` IPC →
`scaffoldAutomationProject`. That code path bypassed
`suggestCloneIdentity` and produced three identical-looking "Briefing"
rows on the Automations page when the user clicked the template thrice.

The user's framing: "automations are just apps without UI assets — they
should share the code path." This commit makes that true.

- `TemplateMeta` (in `@centraid/app-templates`) gains an optional
  `kind: 'app' | 'automation'` plus automation-only display fields
  (`emoji`, `category`, `triggerKind`, `triggerLabel`, `integrations`).
  `build-manifest.mjs` auto-derives `kind` from the `auto.` id prefix
  when not set explicitly in `index.json`.
- Ten new filesystem templates land under
  `packages/app-templates/auto.<slug>/`, mirroring the
  `scaffoldAutomationProject` layout: `app.json` plus
  `automations/<slug>/{automation.json, handler.js}` — no UI assets.
  These replace the deleted in-renderer `AUTOMATION_TEMPLATES` array.
- `cloneTemplate` gains `rewriteAutomationManifestNames(destDir,
  newName)` — for each `automations/<id>/automation.json`, the top-level
  `name` becomes `newName` and `generated` is stamped to
  `{by:'centraid-builder', at:<now>}` so the Automations page and the
  manifest stay in sync with the wrapping `app.json#name`. No-op for
  app templates with no `automations/` subdir.
- `TEMPLATES_CLONE` IPC post-clones with
  `provisionAppPendingWebhooks(project.dir)` to mint webhook secrets
  for templates that ship `{kind:'webhook',pending:true}` triggers
  (e.g. `auto.release-notes-drafter`). Plaintext secret returns to the
  renderer exactly once. Also registers the cloned automation with the
  local host so cron triggers fire without waiting for the next app
  start.
- Renderer: `loadAvailableTemplates()` filters `listTemplates` to
  `kind === 'app'` (home Templates tab); sibling
  `loadAutomationTemplates()` returns the automation half for the
  Automations gallery. `adoptTemplate(template: TemplateEntry)` now
  calls `cloneTemplate` IPC and enters the automation builder on the
  resulting `auto.<slug>-N` project. The hardcoded
  `AUTOMATION_TEMPLATES` array and `AutomationTemplate` interface are
  deleted (~160 lines net).
- `CentraidTemplateMeta` mirrors the new fields; a new
  `CentraidMintedWebhook` interface and the extended
  `CentraidCloneTemplateResult` carry the webhook plaintext to the
  renderer.

The "New automation" button (manual creation, not template-based) still
calls `createAutomation` → `scaffoldAutomationProject`. That path stays
because no template is involved.

## Tests

- `packages/builder-harness/src/update-project-meta.test.ts` — 6 tests
  covering rename happy path, collision, case-insensitive comparison,
  self-rename allowed, empty-name rejection, description-only bypass.
- `packages/builder-harness/src/clone.test.ts` — 11 tests covering
  `suggestCloneIdentity` (5), `suggestAppId` sanity (2),
  `cloneTemplate` `<title>` rewrite (4), and the automation manifest
  rewrite + `generated` stamp.

Full repo: 16/16 typecheck, 12/12 test suites, format clean.

## Out of scope

- The "New automation" button on the Automations overview (manual,
  non-template creation) keeps using `createAutomation` →
  `scaffoldAutomationProject`. No template is involved, so the unified
  clone path doesn't apply.
- Webhook-secret presentation UX: the minted plaintext currently
  surfaces via a toast + console line. A proper "copy this URL +
  secret" sheet is a follow-up.
- Automation-template `index.json` entries hardcode `iconKey: 'Sparkle'`
  for v1; per-template icon variety can land later without touching
  the clone path.

## Verification

- `bun run typecheck` — 16/16 packages green (force-rebuilt, no cache).
- `bun run test` — all 12 packages green; 28/28 in
  `@centraid/builder-harness` including the 17 new tests added in this
  receipt's scope.
- `bun run format:check` — clean.
- End-to-end demo (one-shot node script against the real bundled
  templates) confirms: three back-to-back clones of `hydrate` produce
  `hydrate-2/3/4` with display names `Hydrate 2/3/4`; three back-to-back
  clones of `auto.briefing` produce `auto.briefing-2/3/4` with names
  `Briefing 2/3/4` and matching `automations/briefing/automation.json#name`;
  cloning `auto.release-notes-drafter` mints a webhook secret and
  rewrites the manifest's `{pending:true}` trigger to a provisioned
  `{id, secretHash}` form.

