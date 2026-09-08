# Trap: the blueprint manifest generator lists untracked build output

`packages/blueprints/scripts/build-manifest.mjs` enumerates each app's files from **the directory**, not from the tracked file list. A container that has compiled a blueprint's TypeScript beside its sources therefore has `.js` files on disk that no one committed, and the generator writes them into `packages/blueprints/manifest.json` as if they were source.

## What it looks like

The manifest lists a file that does not exist in the tree. Nothing fails where the manifest was generated — the files were really there — so the bad lines are committed and travel. The failure appears later and somewhere else: on a clean clone the push gate regenerates the manifest, the phantom entries disappear, and the working tree is dirty for a reason nothing in the diff explains.

Two such lines lived in the manifest for a while: `actions/toggle-task.js` under people and `queries/auth.js` under locker.

## What to do

- Never hand-edit `manifest.json`. Regenerate it: `bun run --cwd packages/blueprints build:manifest`.
- Regenerate it from a **clean** tree — `git status --porcelain packages/blueprints` empty of untracked files — or the same phantom entries come back.
- If a regeneration deletes entries you did not expect, that is this trap, and the deletion is the fix.

## Related

- [README.md](README.md)
- [../dev-environment.md](../dev-environment.md)
