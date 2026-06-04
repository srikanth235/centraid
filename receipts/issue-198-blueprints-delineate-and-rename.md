# Issue #198 — blueprints: delineate app vs automation templates, surface automations on home, rename package

Issue: #198

## Checklist
- [x] Split templates into apps/ and automations/ subfolders
- [x] Surface automation templates on the home shelf
- [x] Rename package to @centraid/blueprints

## What changed

### Split templates into apps/ and automations/ subfolders
The bundled-template package kept app templates (`hydrate`, `journal`, `todos`)
and automation templates (`briefing`, `email-triage`, …) as flat sibling
folders at the package root, with only the `kind` field distinguishing them.
Moved each template under a kind-segment directory — `apps/<id>/` for UI apps,
`automations/<id>/` for automations — derived from `kind` via a single
`templateKindDir()` helper shared by the disk resolver (`templateSourceDir`),
the remote fetcher (`downloadTemplate`'s URL + cache paths), and the manifest
build script, so on-disk, cache, and remote (GitHub-raw) layouts stay in
lock-step. `package.json#files` now ships `apps`/`automations` (the latter was
missing before — a latent packaging bug); `.oxlintrc.json` collapses the
13 per-template ignore globs into two; README + `TemplateMeta` docs and the
skills `ui-grounding` exemplar paths updated.

### Surface automation templates on the home shelf
The home discovery shelf only showed app templates (automations were filtered
out, reachable only via a buried Automations → Browse templates surface). Added
**Automations** as a fourth peer tab beside My apps · Starred · Templates. Most
tabs paint the dense 6-col app-tile grid; the Automations tab morphs the grid to
a roomier 3-col card layout (responsive: 2-col ≤1024px, 1-col ≤640px) reusing the
production `renderAutomationTemplateCard` (emoji · trigger glyph · integration
chips). A staggered rise-in plays per cell on every tab switch, and "Browse all"
is now tab-aware (→ Discover for apps, → the automations gallery for automations).
`renderHomeAsync` loads both kinds in parallel.

### Rename package to @centraid/blueprints
With the package now holding both kinds, the `app-` prefix was a misnomer.
Renamed the directory `packages/app-blueprints` → `packages/blueprints` and the
npm package `@centraid/app-blueprints` → `@centraid/blueprints`, updating all
importers (gateway, app-engine, conversation-engine, desktop, skills), their
`package.json` deps, 9 live `docs/*.mdx` files, and the 5 `bun.lock` references.
Historical `receipts/` were left as-is except the moved-file links in issue-64.

## Out of scope
- Unifying the two adoption paths: app templates open a preview first while
  automation cards adopt directly into the builder. Each kind keeps its
  existing behavior (matching the dedicated automations gallery).
- Any change to template content, the clone/publish flow, or the remote
  fetch protocol beyond the path-segment derivation.

## Verification
- `node scripts/build-manifest.mjs` regenerates the manifest cleanly — all
  13 templates resolved under their new `apps/`/`automations/` paths, no
  missing-dir warnings; `files[]` entries stayed template-relative (no
  `apps/` prefix leakage).
- `tsc -p tsconfig.json --noEmit` clean; package test suite 37/37 pass.
- Home shelf verified in a static harness against the real stylesheet + design
  tokens: the Automations tab appears with its count, the grid morphs to 3-col
  cards (emoji, trigger glyph, integration chips), cards reveal fully (animation
  cleanup releases hover), and the 2-col ≤1024px fallback holds; no console
  errors. Desktop renderer typecheck clean.
