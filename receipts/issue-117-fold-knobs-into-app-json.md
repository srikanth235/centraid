# issue-117 — Fold per-app knobs into app.json#knobs[]

GitHub issue: [#117](https://github.com/srikanth235/centraid/issues/117)

## Checklist

- [x] `runtime-core` Manifest type, JSON Schema, and `validateManifest()` accept an optional `knobs[]`
- [x] `app.json` removed from `RESERVED_FILENAMES` so the static server can serve it
- [x] Each curated template carries its knobs inline in `app.json`; the three `app-knobs.json` sidecars are deleted
- [x] `build-manifest.mjs` reads knobs from `app.json` instead of the sidecar; regenerated `manifest.json`
- [x] `scaffoldProject` writes knobs inline in the new project's `app.json` instead of a separate file
- [x] Desktop popover fetches `app.json` from the gateway and extracts `knobs[]`
- [x] Doc comments and type docs reference `app.json#knobs[]` instead of `app-knobs.json`
- [x] `bun run turbo run typecheck` clean across runtime-core, app-templates, builder-harness, desktop
- [x] `bun run turbo run test` for runtime-core + app-templates + builder-harness: 330 tests pass

## What changed

**`runtime-core` Manifest type, JSON Schema, and `validateManifest()` accept an optional `knobs[]`.** `packages/runtime-core/src/manifest.ts` gains `ManifestKnob` / `ManifestKnobOption` interfaces, a top-level `knobs?: readonly ManifestKnob[]` field on `Manifest`, and a matching `knobs` block in `MANIFEST_JSON_SCHEMA` (required keys: `key`, `label`, `type` ∈ `{segmented, swatch}`, `default`, `options`). `validateManifest()` rehydrates the array on the returned object. Existing manifests without `knobs[]` validate unchanged because `additionalProperties: true` was already in force at the root.

**`app.json` removed from `RESERVED_FILENAMES` so the static server can serve it.** `packages/runtime-core/src/security.ts` drops `app.json` from the set so `resolveStaticPath()` returns the file under `/centraid/<id>/app.json`. The manifest is the agent-facing tool contract — action/query schemas are already meant to be enumerable — so exposing it is a non-event security-wise. `data.sqlite` and `_registry.json` stay reserved.

**Each curated template carries its knobs inline in `app.json`; the three `app-knobs.json` sidecars are deleted.** `packages/app-templates/{hydrate,journal,todos}/app.json` each gain a `knobs[]` array (the four standard rows: `appFont`, `appWidth`, `appRadius`, `appColor`, with each template's identity colour as the `appColor` default — Blue for hydrate, Ochre for journal, Violet for todos). The corresponding `app-knobs.json` files are deleted.

**`build-manifest.mjs` reads knobs from `app.json` instead of the sidecar; regenerated `manifest.json`.** `packages/app-templates/scripts/build-manifest.mjs` opens each template's `app.json`, pulls `parsed.knobs` if it is an array, and writes it onto the gallery manifest entry as `appKnobs` (the field name on the gallery side is unchanged, so `resolveTemplates()` consumers don't move). The regenerated `packages/app-templates/manifest.json` no longer lists `app-knobs.json` in any template's `files[]`.

**`scaffoldProject` writes knobs inline in the new project's `app.json` instead of a separate file.** `packages/builder-harness/src/scaffold.ts` now builds `app.json` with `knobs: DEFAULT_APP_KNOBS` inside the same object, then writes one manifest. `DEFAULT_APP_KNOBS` is a typed array literal (not a serialized JSON string) so the runtime sees it as plain data when embedded.

**Desktop popover fetches `app.json` from the gateway and extracts `knobs[]`.** `apps/desktop/src/renderer/app.ts#fetchAppKnobsManifest` now requests `${live.url}app.json`, parses it as `{ manifestVersion, knobs }`, and returns `{ version: manifestVersion ?? 1, knobs }` so downstream popover code keeps the same `AppKnobsManifest` shape. Live-update routing (Color/Accent → CSS var, else → data attr) is unchanged.

**Doc comments and type docs reference `app.json#knobs[]` instead of `app-knobs.json`.** `packages/runtime-core/src/settings-merge.ts`, `packages/app-templates/src/types.ts`, `packages/builder-harness/src/scaffold-defaults.ts`, and the relevant comment blocks in `apps/desktop/src/renderer/app.ts` all now point future readers at the consolidated location. The historical sidecar name is retained only where the comment is explaining why something is the way it is.

## Out of scope

- Hand-editing the existing in-the-wild scaffolded apps that still carry a `app-knobs.json`. The runtime no longer reads it, and the new fetch path falls back to "no knobs" gracefully, but a separate migration could rewrite the file in place if we want to actively clean those up. Per `centraid-v0-status` (pre-release, no backward-compat / migrations) this is intentionally a no-op.
- Builder-harness UI for editing knobs post-scaffold. Authors still edit `app.json` directly.
- Renaming the `appKnobs` field on the gallery `TemplateMeta` — kept as-is to avoid a coordinated rename across the gallery consumers; the change is purely the on-disk location.

## Verification

- `bun run turbo run typecheck` clean across runtime-core, app-templates, builder-harness, desktop (15 tasks, all green).
- `bun run turbo run test` for runtime-core + app-templates + builder-harness: 330 tests pass.
- `bun run build:manifest` regenerates `packages/app-templates/manifest.json` cleanly (13 templates written, no `app-knobs.json` in any `files[]`).
