# issue-446 — Close the vault-data trigger authoring loop

GitHub issue: [#446](https://github.com/srikanth235/centraid/issues/446)

## Checklist

- [x] Part A: automation-authoring skill documents `data` + `condition` triggers (shapes, semantics, vault-block hard rule, decision guide)
- [x] Part A: `HEADLESS_COMPILE_WORK_ORDER` instructs the compiler to derive data/condition triggers from instructions
- [x] Part A: work-order tests pin the new instruction lines
- [x] Part B: editor offers "+ Data change" / "+ Condition"; data/condition rows fully editable (entities datalist, `every` gate, condition `where` builder with per-op value rules)
- [x] Part B: `buildTriggers` serializes editable drafts to valid manifest shapes; empty-entity drafts skipped
- [x] Part B: derived vault grant (`vaultForTriggers`) verified on create + update save paths
- [x] Follow-up 1: per-app "Automate on this data" deep-link seeds a create-mode data trigger watching the entity kind
- [x] Follow-up 2: trigger entity inputs use an at-mention-style keyboard-navigable picker instead of the bare datalist
- [x] Tests + typecheck + lint green

## What changed

**The gap.** The engine has had vault-data triggers all along — `data` (consented change-feed poll via `ctx.vault.changes`, persisted journal-id cursor) and `condition` (windowed consented read with row-content dedup) in `packages/automation/src/manifest/manifest.ts`, evaluated by the in-process scheduler and used by 9 of 16 bundled templates. But nothing could *author* them: the automation-authoring skill documented only cron/webhook (so the editor's "the compiler writes these from your instructions" promise was vacuous), and the editor rendered them read-only with no add button.

**Part A — teach the compiler.** `packages/skills/skills/automation-authoring/SKILL.md` gains four manifest-editing bullets: the exact `data` trigger shape + change-feed semantics (watermark-bootstrapped cursor, `* * * * *` default gate, the issue-#308 `outbox.*` exclusion), the exact `condition` shape + row-content-dedup semantics (`*/5 * * * *` default, full `CONDITION_OPS` list, a `within-next-days` "invoice due in 3 days" example), the hard rule that either kind requires a `vault` block whose read scopes cover every watched entity (shape mirrored from the doc-filer/renewal-reminders templates), and a which-trigger decision guide that steers authors away from approximating data-reactivity with cron polls. `HEADLESS_COMPILE_WORK_ORDER` (`packages/gateway/src/lifecycle/headless-automation-compile.ts`) gains two imperative lines telling the compiler to declare data/condition triggers (with covering scopes) when the instructions describe data reactions or data-state windows, and to leave existing cron/webhook triggers alone otherwise. A new test pins the lines with substring assertions.

**Part B — direct authoring in the editor.** `AutomationEditorScreen.tsx` reverses the v0 compiler-output-only stance: the add-trigger row offers all four kinds, the per-row kind select does too, and data/condition rows are fully editable — data gets a comma-separated entities input and an optional `every` cron gate (with the same next-runs preview the Schedule trigger shows); condition gets an entity input, the `every` gate, and a structured `where` builder (column / op select / per-op value: hidden for `is-null`/`not-null`, comma-list for `in`, numeric for `within-days`/`within-next-days`), replacing the old raw-JSON `where` textarea and its parse-error state. Both entity inputs autocomplete from a `<datalist>` populated lazily via a new optional `loadEntityTypes` bridge prop (`screen-contracts.ts`), wired in `AutomationEditorRoute.tsx` to the same cached `listVaultEntityTypes` read the @-mention search uses. `buildTriggers` serializes the drafts to valid manifest shapes (trim/drop-empty entities, omit blank `every`/empty `where`, per-op value coercion) and skips entity-less drafts, mirroring the cron empty-expr skip. `vaultForTriggers` — which already auto-derives the covering read grant on both create and update saves — is exported and covered by a new unit test (`automationEditorVault.test.ts`); no behavior change was needed there. Screen tests rewrite the old read-only assertion into editable round-trips plus serialization coverage.

**Follow-up 1 — per-app "Automate on this data" deep-link.** The `automation-editor` shell route (`app-shell-context.ts`) gains an optional `watchEntity` param (a logical entity KIND, `schema.table`), threaded through `App.tsx` into `AutomationEditorRoute`. The route's create-mode DTO assembly is extracted into a pure, unit-tested `buildCreateAutomationEditorData` that seeds a create-mode data trigger watching that kind (`triggers: [{ kind: 'data', entities: [watchEntity] }]`) — flowing through the existing editable-row rendering with zero screen changes, and picking up the auto-derived `vaultForTriggers` grant on save. Like `templateId`, `watchEntity` is excluded from `routeKey` so it never persists past the first paint (a template's own trigger kind still wins when both are present). `AppInfoModal.tsx` renders an "Automate on this data" section with one deep-link button per distinct entity kind the app requests (from its consent scopes), threaded via a new `onAutomate` prop that `HomeRoute.tsx` wires to `navigate({ kind: 'automation-editor', watchEntity })`.

**Follow-up 2 — at-mention-style entity picker.** The bare `<datalist>` autocomplete on the data/condition trigger entity inputs is replaced by a colocated `EntityKindPicker` component that reuses the Instructions at-mention popover surface (`.mentionPopover`/`.mentionOption`): as the user types it shows matching entity KINDS from the same lazily-loaded `loadEntityTypes` list (client-side filtered, capped at eight; never row instances), keyboard-navigable (ArrowUp/ArrowDown to move, Enter to accept, Escape to dismiss) and click-to-accept. For the data input (`segmented`) only the trailing comma segment is matched and completed, leaving earlier entities intact. The `<datalist>` and its element are removed; the lazy fetch stays, now feeding the picker.

## Files

- `packages/skills/skills/automation-authoring/SKILL.md` — data/condition trigger docs + decision guide.
- `packages/gateway/src/lifecycle/headless-automation-compile.ts` — work-order trigger-derivation lines.
- `packages/gateway/src/lifecycle/headless-automation-compile.test.ts` — pins the new work-order lines.
- `packages/client/src/react/screens/AutomationEditorScreen.tsx` — editable data/condition trigger rows.
- `packages/client/src/react/screens/AutomationEditorScreen.module.css` — where-builder styles; dead derived-label/fieldError classes removed.
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx` — read-only assertion rewritten as an editable round-trip.
- `packages/client/src/react/screens/AutomationEditorTriggers.test.tsx` — new: data/condition authoring + serialization coverage (split out to respect the 500-line file cap).
- `packages/client/src/react/screen-contracts.ts` — optional `loadEntityTypes` bridge prop.
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` — `loadEntityTypes` wiring; `vaultForTriggers` exported; create-mode DTO extracted to `buildCreateAutomationEditorData` with `watchEntity` seeding.
- `packages/client/src/react/shell/routes/automationEditorVault.test.ts` — new: `vaultForTriggers` scope-derivation unit tests.
- `packages/client/src/app-shell-context.ts` — `automation-editor` route gains optional `watchEntity` (follow-up 1).
- `packages/client/src/react/shell/App.tsx` — passes `watchEntity` to `AutomationEditorRoute`.
- `packages/client/src/react/shell/routes/AppInfoModal.tsx` — "Automate on this data" per-kind deep-link buttons; new `onAutomate` prop.
- `packages/client/src/react/shell/routes/AppInfoModal.module.css` — styles for the "Automate on this data" chip buttons.
- `packages/client/src/react/shell/routes/HomeRoute.tsx` — wires `onAutomate` to `navigate({ kind: 'automation-editor', watchEntity })`.
- `packages/client/src/react/shell/routes/automationEditorPrefill.test.ts` — new: `buildCreateAutomationEditorData` unit tests (trigger-less, watchEntity seed, template-wins, template-without-kind fallback).
- `packages/client/src/react/shell/routes/HomeRoute.test.tsx` — new test: App info "Automate media" button navigates with the seeded `watchEntity`.
- `packages/client/src/react/screens/AutomationEditorScreen.tsx` + `.module.css` — datalist replaced by the `EntityKindPicker` popover (follow-up 2).
- `packages/client/src/react/screens/AutomationEditorTriggers.test.tsx` — datalist test rewritten as picker coverage (lazy fetch, filter, keyboard accept, Escape, comma-segment completion, click-accept).

## Verification

```sh
bun run ci
(cd packages/gateway && npx vitest run src/lifecycle/headless-automation-compile.test.ts)
(cd packages/client && npx vitest run \
  src/react/screens/AutomationEditorScreen.test.tsx \
  src/react/screens/AutomationEditorTriggers.test.tsx \
  src/react/shell/routes/automationEditorVault.test.ts)
(cd packages/skills && npx vitest run src/compose.test.ts)
```

Follow-up commit adds:

```sh
bun run ci
(cd packages/client && npx vitest run \
  src/react/screens/AutomationEditorScreen.test.tsx \
  src/react/screens/AutomationEditorTriggers.test.tsx \
  src/react/shell/routes/automationEditorVault.test.ts \
  src/react/shell/routes/automationEditorPrefill.test.ts \
  src/react/shell/routes/HomeRoute.test.tsx)
```

Results: `bun run ci` (format:check, oxlint + turbo lint, typecheck, lint:types, lint:css) green; gateway work-order tests 5/5 (4 existing + 1 new); client editor + vault tests 17/17 across the three files; a full touched-dir sweep of `src/react/screens src/react/shell/routes` in `packages/client` passed 67 files / 522 tests; skills compose tests 4/4 (SKILL.md edits don't break skill composition). Follow-up targeted files: picker + serialization 18 tests, `buildCreateAutomationEditorData` 4 tests, HomeRoute 6 tests (incl. the new Automate deep-link) — all green.

Checklist crosswalk — each item, with where it's realized:

- Part A: automation-authoring skill documents `data` + `condition` triggers (shapes, semantics, vault-block hard rule, decision guide) — the four new SKILL.md bullets described in *What changed*.
- Part A: `HEADLESS_COMPILE_WORK_ORDER` instructs the compiler to derive data/condition triggers from instructions — the two imperative work-order lines in `headless-automation-compile.ts`.
- Part A: work-order tests pin the new instruction lines — the new substring-assertion test in `headless-automation-compile.test.ts` (5/5 above).
- Part B: editor offers "+ Data change" / "+ Condition"; data/condition rows fully editable (entities datalist, `every` gate, condition `where` builder with per-op value rules) — `AutomationEditorScreen.tsx` add-trigger row + editable field blocks, exercised by `AutomationEditorTriggers.test.tsx`.
- Part B: `buildTriggers` serializes editable drafts to valid manifest shapes; empty-entity drafts skipped — the serialization tests (data split/trim, per-op coercion, empty-entity skip) in `AutomationEditorTriggers.test.tsx`.
- Part B: derived vault grant (`vaultForTriggers`) verified on create + update save paths — both `onSave` branches spread `vault: vaultForTriggers(...)`; derivation unit-tested in `automationEditorVault.test.ts`.
- Follow-up 1: per-app "Automate on this data" deep-link seeds a create-mode data trigger watching the entity kind — `AppInfoModal.tsx` buttons → `HomeRoute.tsx` `onAutomate` → `navigate({ watchEntity })` → `buildCreateAutomationEditorData` (unit-tested in `automationEditorPrefill.test.ts`; end-to-end in the new `HomeRoute.test.tsx` case).
- Follow-up 2: trigger entity inputs use an at-mention-style keyboard-navigable picker instead of the bare datalist — the `EntityKindPicker` in `AutomationEditorScreen.tsx`, exercised by the rewritten `AutomationEditorTriggers.test.tsx`.
- Tests + typecheck + lint green — the command block above.

## Decisions

- **Where-builder replaced the raw-JSON `where` textarea.** The old editor kept condition `where` as a JSON string with a parse-error state; the structured column/op/value builder made both dead, so they were removed rather than preserved.
- **Compiler-written triggers are simply editable now.** No read-only "from instructions" mode was retained — Part B deliberately reverses the v0 compiler-output-only stance recorded in #394.
- **`loadEntityTypes` failure caching matches the existing convention.** The route's module-level `entityTypeCache` caches a `[]` on fetch failure, same as the pre-existing `onSearchEntities` path; left consistent rather than diverging in one call site.
- **`AutomationEditorTriggers.test.tsx` split.** The new authoring tests pushed `AutomationEditorScreen.test.tsx` past the 500-line repo-hygiene cap, so they moved to a sibling file with a hand-synced copy of the mount harness.
- **Follow-up entry point lives on the App-info modal, not per-entity-row.** The client's vault-data surfaces are the app consent panes; an app's requested scopes are the natural, already-present list of watchable entity kinds. Blueprint apps are iframed with their own kit and have no clean action channel back to the shell, so no in-app-row "automate" button was added there. Extracting `buildCreateAutomationEditorData` (pure) is what makes the deep-link prefill unit-testable without a live gateway.
- **Picker sources entity KINDS only.** `EntityKindPicker` reads `loadEntityTypes` (types like `core.transaction`), never `onSearchEntities` (which mixes in row instances) — a trigger watches a kind, not a row. The datalist was fully removed; the same lazy fetch now feeds the picker.

## Out of scope (parked in #446)

- Both originally-parked follow-ups (per-app "automate this" entry points; the at-mention entity picker) are now DONE — see *Follow-up 1* / *Follow-up 2* above.
- In-app-row "automate this data" buttons inside iframed blueprint apps — no shell action channel exists yet.
- Engine/scheduler changes — `data`/`condition` evaluation semantics ship as-is.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-7f569ecb-8b7-1784303854-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 219 | 303192 | 10572029 | 103443 | 406854 | 19.5363 | 219 | 303192 | 10572029 | 103443 | feat(automation): teach the compiler data/condition triggers — skill + compile w |
| claude-code-7f569ecb-8b7-1784304072-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 10 | 15451 | 654260 | 4767 | 20228 | 1.0858 | 229 | 318643 | 11226289 | 108210 | feat(automation): teach the compiler data/condition triggers — skill + compile w |
| claude-code-7f569ecb-8b7-1784304152-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 18 | 13428 | 1239398 | 5052 | 18498 | 1.6600 | 247 | 332071 | 12465687 | 113262 | feat(automation): teach the compiler data/condition triggers — skill + compile w |
| claude-code-7f569ecb-8b7-1784304204-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 3 | 11589 | 424395 | 2025 | 13617 | 0.6705 | 250 | 343660 | 12890082 | 115287 | feat(automation): teach the compiler data/condition triggers — skill + compile w |
| claude-code-7f569ecb-8b7-1784304521-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 50 | 31044 | 4014484 | 27087 | 58181 | 5.7574 | 300 | 374704 | 16904566 | 142374 | feat(automation): teach the compiler data/condition triggers (skill + work order |
| claude-code-7f569ecb-8b7-1784304652-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 17 | 12637 | 1507708 | 10022 | 22676 | 2.1669 | 317 | 387341 | 18412274 | 152396 | feat(automation): teach the compiler data/condition triggers (skill + work order |
| claude-code-7f569ecb-8b7-1784304718-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-fable-5 | 6 | 12243 | 516564 | 2217 | 14466 | 0.7805 | 323 | 399584 | 18928838 | 154613 | feat(client): direct data/condition trigger authoring in the automation editor ( |
| claude-code-7f569ecb-8b7-1784313515-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-opus-4-8 | 206 | 1224602 | 20698337 | 87334 | 1312142 | 20.1873 | 529 | 1624186 | 39627175 | 241947 | feat(client): automate-this deep-links + at-mention entity picker for triggers ( |
| claude-code-7f569ecb-8b7-1784313589-1 | claude-code | 7f569ecb-8b77-41e0-b783-c630499b4268 | #446 | claude-opus-4-8 | 5 | 18348 | 914385 | 3010 | 21363 | 0.6471 | 534 | 1642534 | 40541560 | 244957 | feat(client): automate-this deep-links + at-mention entity picker for triggers ( |

## Steering

**Verdict 1: Every steering event is recorded as a row in the Steering table.** PASS — The session transcript contains only two user messages: (1) the initial problem description ("look at popular products like notion, airtable...I don't see any mechanisms for hooking in automations to our vault based data") and (2) a `/goal` command instructing issue creation and implementation. Neither constitutes a steering event (no interrupts marked with "[Request interrupted", no mid-task corrections or redirections). No rows are recorded, which is correct.

**Verdict 2: No non-steering message is recorded as steering.** PASS — The task-assignment messages (initial problem description and `/goal` command) are not steering events; tool denials, system notifications, and task-assignment messages are explicitly excluded by the directive schema. No non-steering rows exist in the table.

## Audit

**Verdict 1: "## What changed" faithfully describes the diff.** PASS — The section accurately describes the gap (compiler not taught data/condition triggers, editor hides them read-only), Part A implementation (SKILL.md documentation + two new instruction lines in HEADLESS_COMPILE_WORK_ORDER + work-order tests with substring assertions), and Part B implementation (AutomationEditorScreen adds full editability with datalist entity autocomplete, where clause builder, every cron gates, buildTriggers serialization with per-op value coercion, vaultForTriggers exported and tested). No omissions or misrepresentations versus the staged and unstaged diff.

**Verdict 2: Each [x] checklist item is realized in the diff.** PASS — All 7 items verified: (1) SKILL.md gains data/condition trigger documentation with shapes, semantics, defaults, hard vault-block rule, and decision guide; (2) HEADLESS_COMPILE_WORK_ORDER gains two imperative lines instructing trigger derivation and leaving existing cron/webhook unchanged; (3) headless-automation-compile.test.ts pins the new lines with substring assertions; (4) AutomationEditorScreen.tsx adds "+ Data change" and "+ Condition" buttons to add-trigger row, with kind select gains all four kinds; (5) data/condition rows become fully editable (entities datalist input, every cron gate, where builder with column/op/value rows and per-op validation); (6) buildTriggers serializes drafts to valid manifest shapes (trim/split/dedupe entities, coerce per-op values, skip empty drafts); (7) vaultForTriggers is exported from AutomationEditorRoute.tsx and covered by automationEditorVault.test.ts with create/update scenarios; (8) screen tests rewritten to verify editable round-trips and serialization, plus new tests for data/condition authoring, entity datalist population, and where-builder value rules.

**Verdict 3: The "## Checklist" mirrors the issue's scope and acceptance.** PASS — Receipt checklist exactly matches GitHub issue #446's "Scope" section (Part A: skill documents + HEADLESS_COMPILE_WORK_ORDER + tests; Part B: editor offers add buttons + full editability + buildTriggers serialization + vaultForTriggers verified on create/update save paths + tests green) and "Acceptance" section (compiler emits data/condition triggers with covering vault blocks on user instruction; user can create automations with data/condition triggers via editor and see derived vault grant; bun run ci check + governance green).
