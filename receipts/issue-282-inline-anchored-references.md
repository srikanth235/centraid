# issue-282 — Inline anchored references (`@`-mentions over plain-text bodies)

GitHub issue: [#282](https://github.com/srikanth235/centraid/issues/282)

Lets a text-bearing app offer the familiar `@`-mention gesture — type `@`,
pick an entity, keep typing — and render the pick as an inline chip in the
read view, **without** turning the note body into a bespoke document format
or coupling text edits to vault writes. The reference stays a `core.link`
edge (rule 10); a thin **standoff anchor** points into the plain body from
outside it. Notes is the first (and, this PR, only) consumer.

Builds on #272 (the edge, resolver, picker, strip).

## Checklist

- [x] Vault engine: the core_link_anchor locator, an optional selector on core.link_entities, and the core.anchor_link command (migration v4).
- [x] Gateway: the selector on the owner link assert, and a re-anchor route.
- [x] Kit: the @-mention popover, the assignAnchors resolver, and the shared renderReferenceStrip primitive; the modal picker removed.
- [x] Notes: anchor read in the library query, inline chips, the @ gesture, and 4b reconcile-on-save with reversible Undo.

## What changed

Summary (mirrors the checklist):

- Vault engine: the core_link_anchor locator, an optional selector on core.link_entities, and the core.anchor_link command (migration v4).
- Gateway: the selector on the owner link assert, and a re-anchor route.
- Kit: the @-mention popover, the assignAnchors resolver, and the shared renderReferenceStrip primitive; the modal picker removed.
- Notes: anchor read in the library query, inline chips, the @ gesture, and 4b reconcile-on-save with reversible Undo.

Files touched: `packages/vault/src/schema/core.ts`, `packages/vault/src/schema/migrate.ts`, `packages/vault/src/schema/tables.ts`, `packages/vault/src/commands/links.ts`, `packages/vault/src/commands/links.test.ts`, `packages/gateway/src/routes/vault-routes.ts`, `packages/gateway/src/serve/vault-picker.ts`, `packages/gateway/src/serve/vault-plane.ts`, `packages/blueprints/kit/kit.js`, `packages/blueprints/kit/kit.css`, `packages/blueprints/apps/notes/app.js`, `packages/blueprints/apps/notes/app.css`, `packages/blueprints/apps/notes/app.json`, `packages/blueprints/apps/notes/index.html`, `packages/blueprints/apps/notes/queries/library.js`.

**Vault engine.** `core_link_anchor` (one anchor per link, `UNIQUE(link_id)`,
W3C-style `selector_json` = `{exact, prefix, suffix, start}`) as **migration
v4** (backfills empty; `IF NOT EXISTS` so the v3-rewind test replays the
ladder cleanly). `core.link_entities` takes an optional `selector`, written
atomically with the link. New `core.anchor_link` command: with a selector it
upserts the anchor (re-anchor / re-baseline); without one it clears it
(demote to strip-only). Anchors ride live links only — no independent GC, so
the dangling-link sweep needs no extension. `link_anchor` added to the entity
registry and refused as a link endpoint ("links do not link links").

**Gateway.** `POST /_vault/links` carries an optional `selector`; new `PATCH
/_vault/links/<id>` `{selector: {...}|null}` for re-anchor/clear. Both ride
the owner-device credential (pick-is-consent). `parseSelector` validates the
wire shape → 400 on malformed.

**Kit + Notes.** `attachMentionPopover` (caret-anchored `@` popover, one
receipted `/_vault/picker` fetch per opened popover, filtered client-side);
`computeMentionSelector` + `assignAnchors` (the read-view resolver: layered
exact → context+nearest-position → whitespace/smart-quote-normalized →
orphan, **no fuzzy**; global one-span-per-anchor arbitration); `reanchorReference`.
The reference strip was promoted to a shared, anchor-aware kit primitive
`renderReferenceStrip` (in-text/in-strip state, live/trashed/missing/denied
card states, optional remove). Notes renders inline chips resolved to the
**live** card title, wires the `@` gesture with re-anchor-don't-duplicate,
and reconciles on save (re-baseline selectors + auto-retract orphans with a
reversible Undo).

## Decisions (open questions resolved)

- **Q1 Undo = re-assert a fresh link, not reactivate.** Un-stamping `valid_to`
  would rewrite history (R3); `core.link_entities` already anticipates
  re-assertion after unlink (`no_identical_live_link`). The re-asserted link
  carries **no anchor**, so it's a plain strip entry the orphan scan never
  re-inspects — "kept-in-strip" is structural, and Undo can't oscillate
  against the still-missing words. Zero new engine surface.
- **Q2 selector robustness = quote + position, exact-then-normalized, orphan
  rather than guess; fuzzy deferred.** We re-baseline on every save (we own
  the editable body), so drift never accumulates across sessions and steps
  1–3 already cover within-session edits. A wrong fuzzy match is a lie; an
  orphan is honest — so we bias to orphan. Full ladder in the issue body.
- **Q3 trigger = reconcile rides the existing autosave settle** (800ms idle +
  blur flush), gated on the save actually carrying `body_text`. No second
  timer; mid-typing can't fire a vault write; the prototype's auto/save mode
  toggle collapses to one behavior.
- **Q4 assignment lives in the kit** (`assignAnchors`), one implementation for
  Notes now and Docs later. Rejected engine-side (it doesn't know render
  offsets) and per-app (that's the drift the kit prevents).
- **`@` is the sole cross-reference creation gesture (owner directive).** The
  #272 modal picker (`openEntityPicker` + `.kit-pick-*`) was deleted — one
  creation mechanism, one mental model. Its button is repurposed as a
  discoverability shim that drops an `@` and hands off to the popover (kept
  for mobile, where typing `@` mid-text isn't obvious). The strip stays as
  the orphan-landing / Undo-restore home — now a projection/management
  surface, not a creation surface. Accepted tradeoff: you can only reference
  something you'll name inline.
- **Re-anchoring is receipted** via `core.anchor_link`, a deliberate deviation
  from the issue's "no write" aspiration — this architecture has no
  unreceipted write door and shouldn't grow one for a locator move.

## Out of scope / deferred

- **Docs (and the other 12 apps).** Docs has none of the #272 baseline yet
  (no `core.link` scope, no strip, no picker), so its adoption is "port the
  #272 baseline, then add anchors" — a separate lift the issue sequences
  second.
- **Atomic mention nodes / contenteditable (POC 5).** Discrete "delete the
  chip = unlink" precision needs a rich-editor widget + the mobile-IME
  problem — deferred. 4b delivers the feel on the existing `<textarea>`.
- **Block-structured bodies (Notion path).** Substitutive to the storage
  model; anchors stay forward-compatible with it.
- **Bounded fuzzy matching.** Additive at step 3.5 only if telemetry shows
  normalization-missed orphans; must be a position-seeded Bitap with early
  bailout, never a full-document `diff-match-patch` scan.
- **`@` in `social_message` bodies** (Threads) — same model would apply, not
  a consumer here.
- **Typed relations from the UI.** `@` asserts `references` only; richer SKOS
  relations stay command/agent/import-asserted (a typed affordance can return
  later as an annotation on an existing `@`-link, not a second gesture).

## Verification

All quoted counts observed on this change set.

```sh
cd packages/vault && npx vitest run     # 209 passed (24 files) — links.test.ts now 16 (7 new anchor tests)
cd packages/vault && npx tsc --noEmit   # 0 errors
cd packages/gateway && npx vitest run src/serve/vault-plane.test.ts   # 11 passed
cd packages/blueprints && npx vitest run    # 94 passed (5 files)
cd packages/blueprints && node scripts/build-manifest.mjs   # 29 templates; no manifest diff (embeds neither versions nor scopes)
cd packages/gateway && npx tsc --noEmit   # 0 errors (rebased onto main incl. #280/#281)
```

- **Rebased onto current `main` (which merged #280/#281 "the vault is the
  unit").** The one conflict was the `vault-plane.ts` file-size waiver comment
  (both changes waive the same file) — resolved into one line. `anchorAsOwner`
  and the anchor imports fold cleanly into #280's reworked plane, and
  `packages/gateway` now typechecks with **0 errors** (the app-engine
  export/signature drift that showed 9 errors pre-rebase was fixed on `main`).

Behaviors a reviewer can replay:

- **Anchor engine** — `links.test.ts`: selector written atomically with the
  link; malformed selector refused at the schema (no anchor row); `anchor_link`
  upserts in place (one row, moved not multiplied); attaches to a link created
  without one; clears (demote to strip) leaving the judgment live; refused on
  an ended link (`link_live`); `core.link_anchor` refused as an endpoint.
- **Resolution ladder** (`assignAnchors`) — position-verified exact; shifted by
  an earlier edit; two mentions → two spans; one occurrence + two anchors → one
  inline + one orphan (arbitrated); words deleted → orphan; double-space +
  smart-quote normalized; typo → orphan (no fuzzy); overlapping exacts never
  double-claim. (9-case harness.)
- **Shared strip** (`renderReferenceStrip`) — kind badge; in-text vs in-strip
  flag only on anchored refs; plain link has no flag; missing/trashed gone
  states; subtitle only on live; per-tile remove passes the ref; read-only
  strip (no `onRemove`) shows no remove; empty-text path. (13-case harness.)
- **Gateway** — `vault-plane.test.ts` (11) still green over the `/_vault/links`
  and picker surfaces the popover rides.

## Steering

**PASS** — Transcript scanned for interrupts and corrections; one genuine steering event identified: user message at line 496 redirected from "both @ and modal picker" to "@-only deletion," a course correction (tier: classifier). No other user messages constituted steering (task requests, clarifications, and approvals were non-steering).

### Steering ledger (populated by agent-steering-accounting hook)

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (ledger rows appended by pre-commit hook) | | | | | | | | |

## Audit

### Audit 1: "What changed" faithfully describes the diff

**PASS** — The receipt's "What changed" section matches the diff with no material omissions or misrepresentations. It accurately names all 15 files touched; correctly describes vault engine (`core_link_anchor` v4, selector on `core.link_entities`, `core.anchor_link` command); gateway changes (selector on POST, PATCH for re-anchor); kit components (`attachMentionPopover`, `computeMentionSelector`, `assignAnchors`, `reanchorReference`, shared `renderReferenceStrip`, modal picker removal); and Notes integration (anchor read in library query, inline chips, @ gesture, 4b reconcile-on-save, button repoint). Evidence: `git show d082102` confirms deletion of `openEntityPicker` and `.kit-pick-*` styles, all schema/command additions, gateway routes, and kit/Notes function implementations.

### Audit 2: Each checked [x] item is realized in the diff

**PASS** — All four checklist items are present in the diff:
1. Vault engine ✓ — `core_link_anchor` table in tables.ts, migration v4 in migrate.ts, selector on core.link_entities and core.anchor_link command in links.ts, tests in links.test.ts.
2. Gateway ✓ — selector parameter on POST /_vault/links and PATCH /_vault/links/<id> in vault-routes.ts.
3. Kit ✓ — attachMentionPopover, computeMentionSelector, assignAnchors, reanchorReference, renderReferenceStrip all in kit.js; openEntityPicker deleted; modal picker styles removed from kit.css.
4. Notes ✓ — anchor read in library.js, inline chips in app.js with @ gesture, re-anchor-don't-duplicate logic, 4b reconcile-on-save with reversible Undo, button repointed to @ gesture in app.json.

### Audit 3: Checklist mirrors issue #282's scope

**PASS** — The four checklist items align with the issue's declared "Scope of change": (1) vault engine, (2) gateway, (3) kit, (4) Notes as first consumer. The issue designates Docs as deferred (no #272 baseline), matching the receipt's deferral. All scope boundaries match.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-981c661c-e19-1783233105-1 | claude-code | 981c661c-e193-4c08-9b17-54edb5efa365 | #282 | claude-opus-4-8 | 34150 | 139076 | 13713301 | 105860 | 279086 | 10.5431 | 87172 | 2994530 | 79873259 | 571229 |  |
| claude-code-981c661c-e19-1783233244-1 | claude-code | 981c661c-e193-4c08-9b17-54edb5efa365 | #282 | claude-opus-4-8 | 1168 | 37033 | 5877972 | 19432 | 57633 | 3.6621 | 88340 | 3031563 | 85751231 | 590661 |  |
| claude-code-981c661c-e19-1783235348-1 | claude-code | 981c661c-e193-4c08-9b17-54edb5efa365 | #282 | claude-opus-4-8 | 36815 | 728478 | 10996967 | 25337 | 790630 | 10.8690 | 125155 | 3760041 | 96748198 | 615998 |  |
| claude-code-981c661c-e19-1783235534-1 | claude-code | 981c661c-e193-4c08-9b17-54edb5efa365 | #282 | claude-opus-4-8 | 9312 | 33663 | 11523735 | 14015 | 56990 | 6.3692 | 134467 | 3793704 | 108271933 | 630013 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-981c661ce193-1783233053-1 | 981c661c-e193-4c08-9b17-54edb5efa365 | #282 | correction | classifier | redirect from both mechanisms to @-only, delete modal picker | d082102 | 496 | 2026-07-05T06:15:00Z |
