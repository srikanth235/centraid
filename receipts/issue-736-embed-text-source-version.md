# Issue #736 — refresh text embeddings after same-model source rewrites

GitHub issue: [#736](https://github.com/srikanth235/centraid/issues/736)

## Checklist

- [x] Re-embed a content item when its text or transcript derivative changes under the same embedding model.
- [x] Skip embedding work when both the model and source derivative are unchanged.
- [x] Ship the corrected generated recognition handler and document the freshness invariant.

## What changed

- **Re-embed a content item when its text or transcript derivative changes under the same embedding model.** `tools/recognition-automations/automation-handlers/embed-text.js` now treats an embedding stamp as current only when its model and `source_version` both match the source derivative. Cursor seeding uses the same rule, and `enrich.upsert_embedding` receives the current `derivative_id` as `source_version`.
- **Skip embedding work when both the model and source derivative are unchanged.** `packages/automation/src/manifest/enricher-templates.test.ts` restores the regression coverage removed during #731: a same-model rewrite re-embeds, while an unchanged source skips.
- **Ship the corrected generated recognition handler and document the freshness invariant.** `packages/blueprints/automations/embed-text/automations/embed-text/handler.js` is the regenerated, formatted shipped handler containing that source-version check and stamp.
- `docs/recognition-automations.md` records why text-embedding freshness is the pair of model plus source derivative rather than model alone.
- `CHANGELOG.md` records the semantic-search correctness fix under Unreleased / Fixed.
- `receipts/issue-736-embed-text-source-version.md` records the issue crosswalk, decisions, audit, and replayable verification.

## Out of scope

- No vault command or schema change: `enrich.upsert_embedding` already accepts and stamps `source_version`, and its existing upsert replaces the vector for the `(target_type, target_id, model)` key.
- No change to `embed-image`, OCR, faces, or transcript currentness checks because their source asset and derivation target share the same identity.
- The independent Commons follow-ups listed in #736 remain separate work.

## Decisions

- Reuse the vault's existing `source_version` payload contract rather than introduce another stamp field or embedding key.
- Apply the model-plus-source check during first-fire cursor seeding as well as the bounded per-item loop; otherwise enabling the automation over a same-model stale stamp could seed past the rewritten derivative.
- Keep malformed stamp payload behavior aligned with the existing recognition-handler parsing convention: invalid `payload_json` is a data-integrity failure, not an honest skip.

## Verification

The regression was demonstrated red before the implementation: the focused suite reported `expected [] to have a length of 1` for the same-model rewrite case.

```sh
bun run --cwd packages/automation test -- src/manifest/enricher-templates.test.ts
```

After the implementation and handler regeneration, the focused suite passes 54/54 tests.

```sh
bun run --cwd tools/recognition-automations build:automations
bun run format
bun run --cwd packages/blueprints build:manifest
bun run --cwd packages/automation test -- src/manifest/enricher-templates.test.ts
bun run check:push
```

## Audit

**PASS** — Fresh-context audit against issue #736 and the full working-tree diff found the receipt faithful. Both source and generated `embed-text` handlers require matching model and `source_version`, stamp the current `derivative_id`, and regression tests cover same-model re-embedding plus unchanged-source skipping. Independent verification passed: focused automation suite 54/54 and `bun run check:push` 39/39.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | codex | 019fee99-de1c-79e1-97a5-3cbc17c27fab |
