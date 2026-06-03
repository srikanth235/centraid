# issue-188 — Gateway-owned model catalog for the Chat model picker

GitHub issue: [#188](https://github.com/srikanth235/centraid/issues/188)

The Workspace → Chat **Model** picker only showed "Gateway default" for the
codex and claude-code runners. This wires per-runner self-report enumeration
(codex `model/list`, claude `claude -p`), persists the result to a
gateway-owned `model-catalog.json`, seeds the picker with a hardcoded default
table (behind per-line governance waivers), and re-enumerates on the existing
Refresh button.

## Checklist

- [x] Commit 1 — agent-runtime: codex `model/list` + claude `-p` enumerators
- [x] Commit 2 — agent-runtime: gateway-owned model catalog store + default seed
- [x] Commit 3 — gateway: wire model catalog into runner-status preflight
- [x] Commit 4 — desktop: supply per-gateway model-catalog path
- [x] Follow-up — "Gateway default" clears a pinned chat model (review note)
- [x] Rethink — scope chat model per runner (`chatModelByRunner`), retire the global Settings model picker
- [x] Rethink — coupled Agent · Model picker in the chat composer (Direction A)
- [ ] Rethink — demote Settings → Agents to status-only (switching moves to the composer)

## What changed

- **Commit 1 — agent-runtime: codex `model/list` + claude `-p` enumerators.** New `codex-model-list.ts` spawns `codex app-server`, handshakes `initialize`→`initialized`, requests `model/list`, and parses the result with a defensive parser (`{models}`/`{data}`/bare-array; string or object entries; default detection). New `model-enumerators.ts` exposes `enumerateRunnerModels(prefs)` dispatching to the codex helper and to `enumerateClaudeModels` (`claude -p` with fence-stripping + `claude-*` id validation). Both are best-effort (timeout + `[]` on any failure). Pure-function parser unit tests in `model-enumerators.test.ts`.
- **Commit 2 — agent-runtime: gateway-owned model catalog store + default seed.** New `model-catalog.ts` persists per-runner models at `<dir>/model-catalog.json`; `resolveRunnerModels` returns the cached entry or the `defaults` seed on a normal load (never enumerates), and on `refresh` runs `enumerate()` synchronously, overwriting only on a non-empty result (a transient failure keeps the prior entry / falls back to defaults). New `model-defaults.ts` holds the hardcoded concrete-id seed per runner, each entry behind a per-line `no-hardcoded-model-ids` waiver, shown by default until first Refresh. Store tests in `model-catalog.test.ts`.
- **Commit 3 — gateway: wire model catalog into runner-status preflight.** `runPreflight(prefs, { catalogPath?, refresh? })` now resolves `status.models` from the catalog (or the default seed when no `catalogPath`), outside the `--version` probe cache so Refresh re-enumerates without re-probing. `GatewayPaths` gains an optional `modelCatalogFile`; the default `runnerStatus` closure in `build-gateway.ts` threads it plus the refresh flag; the daemon `cli-paths.ts` sets `<dataDir>/model-catalog.json`. `preflight.test.ts` updated to cover the default-seed and no-enumerate-on-normal-load paths.
- **Commit 4 — desktop: supply per-gateway model-catalog path.** New `gatewayModelCatalogFile(id)` in `gateway-paths.ts` → `<userData>/gateways/<id>/model-catalog.json`; wired into the `serve({ paths })` object in `local-runtime.ts` so the local gateway persists/refreshes its catalog there.
- **Follow-up — align codex default seed with OpenClaw's catalog.** Replaced the ad-hoc codex seed (`gpt-5-codex`/`gpt-5.5`/`o3`) with OpenClaw's `FALLBACK_CODEX_MODELS` (`extensions/codex/provider-catalog.ts`): `gpt-5.5` (default) + `gpt-5.4-mini`.
- **Follow-up — thread runner `extraArgs` into codex enumeration (review P1/P2).** `enumerateRunnerModels` now forwards `prefs.extraArgs` to `enumerateCodexModels`, which appends them to `codex app-server` — mirroring the chat runner (`runtime.ts:52`). Without this, a configured `-c`/profile override would make Refresh enumerate a different catalog than the runner actually serves. The claude path is unchanged (its SDK turn ignores `extraArgs`).
- **Follow-up — "Gateway default" clears a pinned chat model (review note).** `saveSettings` treated `chatModel: undefined` as "preserve", so the picker (which sent `value || undefined`) could never return to "Gateway default" once a concrete model was saved — newly hittable now that the picker offers concrete per-runner ids. The picker now sends the raw value (`''` for Gateway default); the merge was extracted to a pure, electron-free `settings-merge.ts` (`mergePersistedSettings`) where empty-string clears, non-empty sets, and `undefined` still preserves. Added `settings-merge.test.ts` (+ a `test` script for `apps/desktop`, tests excluded from the tsc build). _(Superseded by the rethink below — see Out of scope; the empty-string-clear semantics now apply per-runner.)_
- **Rethink — scope chat model per runner (`chatModelByRunner`), retire the global Settings model picker.** A flat global `chatModel` decoupled the agent and model selectors: after switching the active agent, a saved id could point at a model belonging to a _different_ runner (e.g. a `claude-*` id while codex is active), which the old picker even re-added verbatim. Replaced the single `chatModel` string with a per-runner map `chatModelByRunner` (keyed by runner kind) across `PersistedSettings` / `DesktopSettings` / `CentraidSettings`. `mergePersistedSettings` now merges the map **key-by-key** — a non-empty value sets that runner, `''` clears that runner alone, a key absent preserves it, and an omitted field preserves the whole map — and `narrow` defensively sanitizes a malformed map. The in-app chat send path (`app-chat.ts`) resolves the model from `chatModelByRunner[activeRunner]` (keyed off the `agent.runner.kind` pref) so a turn always uses the active runner's own model and never a foreign id. Removed the global "Model" dropdown from Settings → Workspace → Chat (superseded by the composer control); rewrote `settings-merge.test.ts` (7 pass) for the per-runner semantics.

- **Rethink — coupled Agent · Model picker in the chat composer (Direction A).** Added one control to the in-app chat composer (`app-chat.ts`) that reads `<Agent> · <Model>`. Opening it shows the agents (codex / claude-code, with availability + version, accent-colored) — selecting one switches the gateway's active runner via `saveUserPrefs({ 'agent.runner.kind' })` and re-enumerates — and, below, the **active runner's own** models (Gateway default + tier-grouped catalog from `getRunnerStatus`), with a Refresh affordance. Picking a model persists just that runner's entry (`saveSettings({ chatModelByRunner: { [kind]: id } })`). The popover only ever offers the active agent's catalog, so a mismatched pair is structurally impossible; a saved id no longer in the runner's catalog renders as an explicit "unavailable" banner with one-click repair (use the runner default / Gateway default) rather than being silently re-selected or re-sent. The send path prefers the pill's cached, optimistically-updated selection to avoid racing a just-saved choice. New styles under `.app-chat-am-*`.

## Out of scope

- Tier classification (smart/balanced/fast) of codex/claude self-reported ids — the picker renders them flat; only OpenClaw classifies its catalog today.
- Migrating the OpenClaw plugin off its own `model-tiers.json` onto the shared store.
- De-duplicating `hashModelIds` between `openclaw-models.ts` and the new store.
- A CI job to refresh the hardcoded default seed.
- ~~Clearing a stale persisted `chatModel` when the active runner *changes*~~ — **resolved** by the rethink: `chatModelByRunner` keys the selection by runner, so an agent switch can never surface a foreign runner's model. A model going stale _within_ its own runner (e.g. an id dropped after a CLI upgrade) is surfaced as an explicit "unavailable" state with one-click repair by the composer pill, rather than silently re-selected.

## Verification

- **Typecheck:** `agent-runtime`, `gateway`, and `apps/desktop` all typecheck clean (`tsc --noEmit`).
- **Lint/format:** `oxlint` + `oxfmt` clean across all touched files.
- **Unit tests:** `agent-runtime` 51 pass (incl. new `model-enumerators.test.ts` parser shapes for claude `-p` and codex `model/list`, and `model-catalog.test.ts` covering default-load-without-enumerate, warm cache, refresh-overwrite, refresh-failure-preserves-prior, and corrupt-file→defaults); `gateway` 114 pass. `preflight.test.ts` confirms the default seed attaches and a normal load never writes the catalog. New `apps/desktop` `settings-merge.test.ts` (5 pass) covers empty-string-clears / non-empty-sets / undefined-preserves / clear-leaves-other-fields / activeGatewayId fallback.
- **Empirical basis:** `claude -p` model enumeration was verified live (reproducible across runs, returning the current pinned `claude-*` ids) before building on it.
- **Manual (to run in desktop):** Workspace → Chat → Model shows the hardcoded default ids instantly on first open; clicking **Refresh** enumerates live, writes `<userData>/gateways/local/model-catalog.json`, and updates the list; reopening settings reads the persisted list; deleting the file restores defaults; with codex active and `model/list` unsupported the picker degrades to defaults without error.

_(filled in at completion)_
