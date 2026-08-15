# Trap: blueprint manifest regeneration

## What goes wrong

Agents add or edit files under `packages/blueprints/apps/` or `automations/`, update `index.json`, and forget to regenerate **`manifest.json`**. The install/clone catalog then omits files, serves stale `files[]`, or disagrees with disk. CI or another machine building from manifest looks "randomly" broken.

## Source of truth chain

```
index.json  (+ template folders on disk)
    →  scripts/build-manifest.mjs
    →  manifest.json  (checked in; shipped in the published package)
```

`index.json` is the **build-time source** and `manifest.json` the **runtime catalog** — for all 36 templates, the 8 bundled apps as well as the 28 automations. The two must not drift: `packages/blueprints/src/app-manifests.test.ts` asserts the index and the template dirs agree.

Commands (from `packages/blueprints` or via turbo build):

```sh
bun run build:manifest   # or package-equivalent; also part of bun run build
```

See `packages/blueprints/README.md`.

## How agents get it wrong

1. **Editing only disk files** — `manifest.json` `files[]` never picks up new paths.
2. **Editing only `manifest.json`** — next build overwrites from `index.json` + walk.
3. **Bumping template `version` in one place** — keep index/manifest/app.json coherent per package conventions. `manifest.json` takes `version` from **`index.json`**, never from the template's own `app.json`, so bumping `app.json` alone leaves the catalog advertising the old number with nothing red. Checked by hand, not by a gate: as of #712 four templates had drifted this way (`agenda`, `notes`, `docs`, and `photos`, the one that pass fixed). If you bump an app, bump its `index.json` row in the same change.
4. **Adding a new generated artifact without documenting its source and regeneration path.**
5. **Assuming install-in-place apps pick up uncommitted folder state on a remote gateway** — remote uses published/bundled tree.

## Checklist

- [ ] `index.json` entry present for new templates
- [ ] `build:manifest` run; `manifest.json` diff reviewed
- [ ] Handlers committed as **source**, with no compile step on clone/install — `.js` for a builder-generated app, `.ts` for a TS-authored one. Both are first-class: `resolveHandlerFile` (packages/app-engine/src/handlers/dispatcher.ts) probes `.ts` first and falls through to `.js`, and the worker registers an esbuild loader hook for the `.ts` graph. What is still banned is a **built artifact** — nothing under `dist/` may appear in a template's `files[]`.
- [ ] CI build path exercised if you touched vendor scripts

## Related

- `packages/blueprints/scripts/build-manifest.mjs`
