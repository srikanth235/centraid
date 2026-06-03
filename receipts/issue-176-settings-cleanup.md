# issue-176 — Remove dead settings pages, wire chat model picker to gateway

GitHub issue: [#176](https://github.com/srikanth235/centraid/issues/176)

Several desktop **Settings** options had drifted out of sync with the
backend after the [#109](https://github.com/srikanth235/centraid/issues/109)
gateway refactor and the thin-client pivot: a runtime page that rendered
blank, an unbuilt sync stub, and a chat model picker that fetched nothing.
This change retires the two dead pages and makes the model picker list the
gateway's real models.

## Checklist

- [x] Remove the dead "Where apps run" runtime page and its stale local/remote subtitle
- [x] Remove the unbuilt "Sync & backups" stub page
- [x] Wire the chat Model picker to the gateway provider /models probe

## What changed

**Remove the dead "Where apps run" runtime page and its stale local/remote
subtitle.** In `apps/desktop/src/renderer/app.ts` the `runtime` id was
dropped from the `SettingsPageId` union, its `pageHosts` entry, and its
`settingsPages` definition (which carried the outdated *"Local mode runs
apps inside this Electron process. Remote mode delegates to the Centraid
gateway"* subtitle). The matching command-palette label/subtitle ("Where
apps run" / "Local or remote runtime") were removed, and the stale
"After #109 the runtime page is the Gateways panel" comment was replaced
with an accurate note (gateway lifecycle lives on the Profiles page;
userData paths are fixed and not user-configurable). The settings nav
groups pages by section, so the now-empty "Runtime" section no longer
renders, and `startPage` already falls back to `appearance`.

**Remove the unbuilt "Sync & backups" stub page.** The `sync` id was
dropped from the `SettingsPageId` union, `pageHosts`, and `settingsPages`,
the `pageHosts.sync.append(...)` placeholder block ("App sync and backup
settings will live here.") was deleted, and the command-palette
label/subtitle for it were removed.

**Wire the chat Model picker to the gateway provider /models probe.**
`loadChatModels()` previously hard-coded an empty list; it now calls
`getRunnerStatus()` and populates the dropdown from `provider.models`,
keeping "Gateway default" plus any persisted choice as a fallback. The
Refresh button now genuinely re-probes, and the misleading
`openclaw infer model list` hint was corrected. To carry the model ids:
`ProviderStatus` (`packages/app-engine/src/runtime.ts`) and the renderer's
`CentraidProviderStatus` (`apps/desktop/src/renderer/centraid-api.d.ts`)
gained a `models?: string[]` field, and the `GET <baseUrl>/models` probe in
`packages/agent-runtime/src/preflight.ts` now extracts the `data[].id`
entries (`extractModels`) and derives `modelCount` from that list.

## Out of scope

- The Codex-centric "preferred" provider framing on the AI providers /
  Inference pages (provider-agnostic naming is a separate concern).
- The dead `gatewayUrl` / `gatewayToken` / `runtimeMode` defaults still in
  the settings `current` object from the old local/remote form.
- Building an actual Gateways panel or a real sync/backup surface.
- Mobile settings (desktop only).

## Verification

- `bun run --cwd packages/app-engine build` — clean (emits the new
  `ProviderStatus.models` declaration).
- `bun run --cwd apps/desktop typecheck` — clean.
- `agent-runtime` typecheck against the freshly built app-engine `dist`
  (paths-override tsconfig) — exit 0. A plain in-worktree typecheck reports
  a spurious `models` error because `@centraid/*` resolves to main's stale
  `dist`; it resolves in dependency order in CI/main.
- Grep confirmed no remaining references to the removed `runtime` / `sync`
  page ids, the old palette labels, or `countModels`.
