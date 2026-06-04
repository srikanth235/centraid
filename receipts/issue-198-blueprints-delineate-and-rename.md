# Issue #198 — blueprints: delineate app vs automation templates, surface automations on home, rename package

Issue: #198

## Checklist
- [x] Split templates into apps/ and automations/ subfolders
- [ ] Surface automation templates on the home shelf
- [ ] Rename package to @centraid/blueprints

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

## Out of scope
- Renaming the package itself and surfacing automations on the home page —
  tracked as the other two checklist items in this same issue/PR.
- Any change to template content, the clone/publish flow, or the remote
  fetch protocol beyond the path-segment derivation.

## Verification
- `node scripts/build-manifest.mjs` regenerates the manifest cleanly — all
  13 templates resolved under their new `apps/`/`automations/` paths, no
  missing-dir warnings; `files[]` entries stayed template-relative (no
  `apps/` prefix leakage).
- `tsc -p tsconfig.json --noEmit` clean; package test suite 37/37 pass.
