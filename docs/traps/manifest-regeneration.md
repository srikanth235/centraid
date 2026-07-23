# Trap: blueprint manifest regeneration

## What goes wrong

Agents add or edit files under `packages/blueprints/apps/` or `automations/`, update `index.json`, and forget to regenerate **`manifest.json`**. Gallery / install catalog then omits files, serves stale `files[]`, or disagrees with disk. CI or another machine building from manifest looks "randomly" broken.

## Source of truth chain

```
index.json  (+ template folders on disk)
    →  scripts/build-manifest.mjs
    →  manifest.json  (checked in; also remote GitHub-raw surface)
```

Commands (from `packages/blueprints` or via turbo build):

```sh
bun run build:manifest   # or package-equivalent; also part of bun run build
```

See `packages/blueprints/README.md`.

## How agents get it wrong

1. **Editing only disk files** — `manifest.json` `files[]` never picks up new paths.
2. **Editing only `manifest.json`** — next build overwrites from `index.json` + walk.
3. **Bumping template `version` in one place** — keep index/manifest/app.json coherent per package conventions.
4. **Adding a new generated artifact without documenting its source and regeneration path.**
5. **Assuming install-in-place apps pick up uncommitted folder state on a remote gateway** — remote uses published/bundled tree.

## Checklist

- [ ] `index.json` entry present for new templates
- [ ] `build:manifest` run; `manifest.json` diff reviewed
- [ ] Handlers committed as **`.js`** (no compile step on clone/install)
- [ ] CI build path exercised if you touched vendor scripts

## Related

- `packages/blueprints/scripts/build-manifest.mjs`
- [blueprint-csp.md](blueprint-csp.md)
