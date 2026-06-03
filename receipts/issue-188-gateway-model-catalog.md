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
- [ ] Commit 3 — gateway: wire model catalog into runner-status preflight
- [ ] Commit 4 — desktop: supply per-gateway model-catalog path

## What changed

- **Commit 1 — agent-runtime: codex `model/list` + claude `-p` enumerators.** New `codex-model-list.ts` spawns `codex app-server`, handshakes `initialize`→`initialized`, requests `model/list`, and parses the result with a defensive parser (`{models}`/`{data}`/bare-array; string or object entries; default detection). New `model-enumerators.ts` exposes `enumerateRunnerModels(prefs)` dispatching to the codex helper and to `enumerateClaudeModels` (`claude -p` with fence-stripping + `claude-*` id validation). Both are best-effort (timeout + `[]` on any failure). Pure-function parser unit tests in `model-enumerators.test.ts`.
- **Commit 2 — agent-runtime: gateway-owned model catalog store + default seed.** New `model-catalog.ts` persists per-runner models at `<dir>/model-catalog.json`; `resolveRunnerModels` returns the cached entry or the `defaults` seed on a normal load (never enumerates), and on `refresh` runs `enumerate()` synchronously, overwriting only on a non-empty result (a transient failure keeps the prior entry / falls back to defaults). New `model-defaults.ts` holds the hardcoded concrete-id seed per runner, each entry behind a per-line `no-hardcoded-model-ids` waiver, shown by default until first Refresh. Store tests in `model-catalog.test.ts`.

## Out of scope

- Tier classification (smart/balanced/fast) of codex/claude self-reported ids — the picker renders them flat; only OpenClaw classifies its catalog today.
- Migrating the OpenClaw plugin off its own `model-tiers.json` onto the shared store.
- De-duplicating `hashModelIds` between `openclaw-models.ts` and the new store.
- A CI job to refresh the hardcoded default seed.

## Verification

_(filled in at completion)_
