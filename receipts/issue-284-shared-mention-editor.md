# issue-284 — The `@`-mention editor as a shared kit component (Tasks & Leads rollout)

GitHub issue: [#284](https://github.com/srikanth235/centraid/issues/284)

Makes the inline `@`-mention editor a shared kit component so any text-bearing
app gains cross-references in a few lines, and rolls it out beyond Notes.
Follows #282 (anchored `@`-mentions in Notes): the anchor engine, resolver,
picker and strip already exist; this generalizes the editor shell that was
Notes-only.

## Checklist

- [x] Kit: attachMentionField plus the shared inline-chip render helpers.
- [x] Notes: refactored to consume the kit editor, with no behavior change.
- [x] Tasks: @-mentions on the description note.
- [x] Leads: @-mentions on the running note.

## What changed

Summary (mirrors the checklist):

- Kit: attachMentionField plus the shared inline-chip render helpers.
- Notes: refactored to consume the kit editor, with no behavior change.
- Tasks: @-mentions on the description note.
- Leads: @-mentions on the running note.

Files touched: `packages/blueprints/kit/kit.js`, `packages/blueprints/apps/notes/app.js`, `packages/blueprints/apps/tasks/app.js`, `packages/blueprints/apps/tasks/app.css`, `packages/blueprints/apps/tasks/app.json`, `packages/blueprints/apps/tasks/queries/board.js`, `packages/blueprints/apps/leads/app.js`, `packages/blueprints/apps/leads/app.css`, `packages/blueprints/apps/leads/app.json`, `packages/blueprints/apps/leads/queries/pipeline.js`.

**Kit.** `attachMentionField(textarea, {from, references, onChange, relation?, kinds?, onError?})` → `{detach, reconcile(body, {from?, references?}), startMention()}` — the turnkey "@ works" bundle: the caret popover, the pick→insert→assert (re-anchor-don't-duplicate), and the 4b reconcile-on-save (re-baseline live selectors, temporal-retract orphans, reversible Undo). Plus the shared read-view helpers `mentionChip`, `appendWithChips(el, text, absStart, spans, renderPlain)`, `resolveInlineSpans(body, refs)`, `inlineLinkIds(body, refs)` — one inline-chip implementation for every render view. Presentation + gesture only; the app owns the bytes, persistence and its reference list.

**Notes.** Refactored onto the kit: its `onMentionPick` / `startMention` / reconcile (`reconcileAnchors`/`doReconcile`) and chip-render (`mentionChip`/`appendRich`/`inlineRefSpans`/`inlineLinkIds`) are deleted (~300 lines net removed) and replaced by an `attachMentionField` wiring; `renderBodyInto`/`checkLine` thread chips through `appendWithChips`. Markdown/checklist layout stays Notes-local. Behavior unchanged.

**Tasks.** `@` on the description note (the edit popover): `core.link` + `core.link_anchor` read scopes; `board.js` reads live outbound links + anchors and resolves cards, attaching `references` per task; the popover gains the field, a reference strip, a "＋ Mention" button, and reconcile-on-save.

**Leads.** `@` on the running note: same two read scopes; `pipeline.js` attaches `references` per lead; the note editor gains the field, strip, "＋ Mention" and reconcile-on-save.

## Decisions

- **Leads anchors ride `core.party`, not the contact card.** party_id is the always-present identity (the card may not exist until the first note saves). reconcile only touches *anchored* links, so employment (`works-for`) links on the party are left untouched.
- **Short fields (Tasks/Leads) show references in the strip, not as inline chips.** Inline chips require a read-view render; these plain textareas have none. `@` fully works; the chip is the Notes-only nicety, honestly noted.
- **`reconcile` captures its subject at call time** (`{from, references}`) so a navigation during the async save window can't retarget the retraction at the wrong record — a correctness bug the Notes-local version avoided by capturing the note object, preserved here in the generalization.
- **The references query join is copied per app** (like the existing `attachmentsBySubject`): blueprint query files are standalone per-app served files with no shared-import path, so the read pattern is duplicated, not imported.
- **The strip stays presentation-only per app.** Tasks/Leads mutate their in-memory `references` array and re-read on save (the vault writes are authoritative), matching the ephemeral-editor lifecycle.

## Out of scope / deferred

- **Threads message `@`-mentions** — deferred; message bodies have their own lifecycle (#282 deferred them too).
- **Inline chips in Tasks/Leads** — would need converting their plain textareas into click-to-edit render views.
- **Docs and the remaining apps** — Docs is a drive (no inline text editor); the rest have no long-text body.

## Verification

All quoted counts observed on this change set.

```sh
cd packages/blueprints && npx vitest run                 # 94 passed (5 files) — app-manifests (45) validates the new scopes
cd packages/blueprints && node scripts/build-manifest.mjs  # 29 templates; no manifest diff (no files added/removed)
bunx oxlint packages/blueprints/kit/kit.js packages/blueprints/apps/{notes,tasks,leads}   # 0 warnings, 0 errors
bun run format:check                                     # clean
node --check packages/blueprints/kit/kit.js              # + notes/tasks/leads app.js + queries — all parse
```

- A standalone Node harness (rich DOM + `fetch` stub) exercises the extracted helpers and `attachMentionField.reconcile`: `resolveInlineSpans` finds/omits anchors, `inlineLinkIds` sets, `appendWithChips` emits one chip and keeps surrounding text (and honors the `renderPlain` callback), and `reconcile` re-baselines the live selector, retracts the orphan from the refs array, and fires `onChange`. 10/10.

## Steering

**PASS** — Transcript scanned for interrupts (runtime sentinels cutting turns short) and genuine mid-course corrections (user messages redirecting work mid-task). Two AskUserQuestion prompts were issued (rollout scope: extract+Notes vs 1-app vs all-apps; ship path: new-issue-folded vs separate-pr vs uncommitted), and the user provided straightforward answers ("all text apps" and "new issue folded into PR #283"). These are policy clarifications answering the agent's own decision prompts, not steering events — they align with the stated scope of work. No interrupts or corrections detected. Zero steering events.

## Audit

### Audit 1: "What changed" faithfully describes the diff

**PASS** — The receipt's "What changed" section states five items (Kit + shared helpers, Notes refactored, Tasks @-mentions, Leads @-mentions, and files list). The diff c50a67f modifies exactly those files and implements exactly those features: Kit exports `attachMentionField`, `mentionChip`, `appendWithChips`, `resolveInlineSpans`, `inlineLinkIds`; Notes imports them and deletes ~300 lines of onMentionPick/reconcile/chip-render code; Tasks and Leads each wire the field, strip, "＋ Mention" button, add core.link/link_anchor read scopes, and read references from new query joins (board.js and pipeline.js). The summary mirrors the checklist exactly.

### Audit 2: Each checked [x] item is realized in the diff

**PASS** — All four checklist items are fully realized:
- Kit attachMentionField (+ helpers) — kit.js lines 967–1130, new function exports and shared chip/span helpers (lines 894–965).
- Notes refactored to consume kit — app.js lines 251–269 import from kit; old onMentionPick/reconcile/chip functions deleted; `bodyField = attachMentionField(...)` wires the field (lines 283–294); `startMention()` calls `bodyField.startMention()` (line 461); reconcile called post-save (line 643–646); `renderBodyInto` threads chips through `appendWithChips` (lines 586, 595, 604).
- Tasks @-mentions — app.js adds attachMentionField import, wires field in popover (lines 743–747), adds strip (lines 730–750), adds "＋ Mention" button (lines 752–756), calls reconcile post-save (lines 779–781); app.json adds core.link and link_anchor read scopes (lines 793–802); board.js reads and resolves references (lines 814–872), attaches to tasks (line 881).
- Leads @-mentions — app.js wires field (lines 95–99), strip (lines 82–94), button (lines 132–136), reconcile (lines 116); app.json adds scopes; pipeline.js reads and resolves (lines 173–231), attaches to leads (line 240).

### Audit 3: The Checklist mirrors issue #284's scope

**PASS** — Issue #284 states four deliverables: Kit (extract + shared read-view helpers), Notes (refactored to consume, zero behavior change), Tasks (field + strip + button + reconcile), Leads (same). The checklist lists exactly those four items, all checked. The Decisions section aligns with the issue's stated design choices (anchors on core.party for Leads, strip-only rendering for Tasks/Leads, subject capture for correctness, query duplication pattern, strip as ephemeral). The "Out of scope" section (Threads deferred, inline-chips-in-Tasks deferred, Docs/other apps out) matches the issue's scope boundary ("rolls out beyond Notes" = Tasks + Leads only; Threads explicitly deferred). No scope creep or missing items detected.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-981c661c-e19-1783238160-1 | claude-code | 981c661c-e193-4c08-9b17-54edb5efa365 | #284 | claude-opus-4-8 | 1584 | 17433 | 4956051 | 13185 | 32202 | 2.9245 | 194652 | 4198988 | 207967195 | 959028 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
