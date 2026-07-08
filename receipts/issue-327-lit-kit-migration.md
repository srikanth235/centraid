# issue-327 — Migrate the blueprint kit from vanilla JS/CSS to Lit / native Web Components

GitHub issue: [#327](https://github.com/srikanth235/centraid/issues/327)

Ports `packages/blueprints/kit/` (`kit.js` + `kit.css`) from hand-rolled vanilla
DOM builders to **Lit-based native Web Components**, loaded as plain ESM with
**no build/bundle step** — the constraint that keeps the kit dynamically
alterable and deployable by the builder harness (files read, edited, and served
as-is). Because native custom elements are what Lit compiles to, and claude.ai/
design ingests them directly (the issue's POC), this also lets design-sync drop
its hand-authored React-wrapper package and its wrapper-drift risk.

## Checklist

- [x] Phase 0 — Spike confirmed.
      Native custom elements are ingested by claude.ai/design with zero React
      glue (validated in the issue itself; no code required).
- [x] Phase 1 — Component-by-component port.
      The kit's presentation primitives are now `LitElement` subclasses in
      `kit/elements.js`, defined via `customElements.define()`: `<kit-avatar>`
      (`letterAvatar`), `<kit-meter>` (`barSpan`), `<kit-line-chart>`
      (`lineChart`), `<kit-bar-chart>` (`barChart`), `<kit-skeleton>`
      (`showSkeleton`), `<kit-toast>` (`toast`), `<kit-mention-chip>`
      (`mentionChip`), and `<kit-reference-strip>` (`renderReferenceStrip`).
      Each renders the SAME `.kit-*` markup the vanilla builder produced, so
      `kit.css` styles it identically. `kit.js` keeps the exported factory
      functions — now thin constructors over the elements — so every calling
      app is unchanged.
- [x] Phase 2 — Simplify design-sync.
      `.design-sync/ds-src/` (the React wrapper package + `tsc` build) is
      replaced by a `build.mjs` that copies the REAL `kit/elements.js` +
      `lit-core.min.js`, assembles the CSS bundle, and emits one `@dsCard`
      preview + a `manifest.json` per component. No compile step, no wrapper
      markup to keep in sync. `config.json` shape becomes `web-components`; the
      17 stale React preview `.tsx` files are removed.
- [x] Phase 3 — Styling migration.
      Decided: light DOM + `display: contents` host. The elements render their
      `.kit-*` markup into the light DOM and the custom-element host contributes
      no box, so the emitted tree lays out byte-for-byte like the old builders'
      output and `kit.css` + each app's CSS custom properties apply unchanged.
      Shadow DOM / adopted stylesheets were **not** needed. Honest finding:
      `styles/bridge.css` is a *var-name adapter* between the design-tokens
      package (`--bg`, `--ink`, …) and the app-level names the kit reads
      (`--surface`, `--text`, …); Shadow-DOM encapsulation would not have removed
      that mismatch, so the bridge **stays** (documented).
- [x] Phase 4 — Cleanup.
      The superseded vanilla builders are gone (removed from `kit.js` in the
      Phase 1 commit — `letterAvatar`/`lineChart`/`barChart`/`barSpan`/`toast`/
      `showSkeleton`/`mentionChip`/`renderReferenceStrip` are now thin
      constructors, and `svgEl`/`SVG_NS` are deleted). `.design-sync/NOTES.md`
      and `conventions.md` are rewritten to the new (simpler) wrapper-free sync
      contract; the retired wrapper-drift risk is called out as retired.

## What changed

This PR realizes every checklist item. Phase 0 — Spike confirmed. Phase 1 —
Component-by-component port. Phase 2 — Simplify design-sync. Phase 3 — Styling
migration. Phase 4 — Cleanup. It lands over focused commits; the files below are
grouped by phase.

The port plus the runtime wiring it needs (Phases 1 + 3):

- `packages/blueprints/kit/elements.js` (new) — the ported **Phase 1** primitives
  as `LitElement` subclasses defined with `customElements.define()`:
  `<kit-avatar>`, `<kit-meter>`, `<kit-line-chart>`, `<kit-bar-chart>`,
  `<kit-skeleton>`, `<kit-toast>`, `<kit-mention-chip>`, `<kit-reference-strip>`.
  Also holds `entityKindLabel` + `PICK_KIND_LABELS` (moved here from kit.js).
- `packages/blueprints/kit/kit.js` — imports `elements.js`; its exported factory
  functions (`toast`, `showSkeleton`, `letterAvatar`, `lineChart`, `barSpan`,
  `barChart`, `mentionChip`, `renderReferenceStrip`) are now thin constructors
  over the custom elements; the old vanilla builders and the `svgEl`/`SVG_NS`
  helpers are removed; `entityKindLabel` is re-exported from elements.js.
- `packages/blueprints/kit/kit.css` — the **Phase 3** styling migration: a
  `display: contents` host rule for the eight custom elements so their light-DOM
  `.kit-*` markup lays out exactly as the vanilla builders' output did.
- `packages/blueprints/kit/lit-core.min.js` (new) — the vendored, reproducible,
  no-build-step Lit runtime bundle the elements import.
- `packages/blueprints/scripts/vendor-lit.mjs` (new) — regenerates that bundle
  from the lockfile-pinned `lit` package (never a CDN), in production mode.
- `packages/blueprints/package.json` + `bun.lock` — add the pinned `lit@3.3.3`
  devDependency (the vendoring source).
- `packages/app-engine/src/http/static-server.ts` — add `elements.js` +
  `lit-core.min.js` to `SHARED_ASSET_FILES` so the import chain (app.js → kit.js
  → elements.js → lit-core.min.js) serves from `KIT_DIR` like kit.js/kit.css.
- `packages/app-engine/src/http/static-server.test.ts` — a case asserting both
  new shared assets serve from the shared dir.
- `.oxfmtrc.jsonc` — ignore the vendored minified bundle (it is generated).
- `receipts/issue-327-lit-kit-migration.md` (new) — this receipt.

The no-build-step runtime detail: the npm `lit` package ships a bare-specifier
module graph a browser can't resolve without a bundler, so `vendor-lit.mjs`
bundles exactly the entry points the kit uses (`LitElement`, `html`, `svg`,
`css`, `nothing`, `noChange`) into a single ~15 KB ESM file, reproducibly.

Design-sync simplification + cleanup (Phases 2 + 4):

- `.design-sync/ds-src/src/` (17 React wrapper `.tsx` + `lib/kinds.ts` +
  `index.ts`), `.design-sync/ds-src/tsconfig.json`, `.design-sync/ds-src/
  package-lock.json`, and the 17 stale `.design-sync/previews/*.tsx` React
  preview files are **deleted** — no wrapper markup, no `tsc`.
- `.design-sync/ds-src/build.mjs` — rewritten: assembles the CSS bundle and
  copies the REAL `kit/elements.js` + `kit/lit-core.min.js` into `components/`,
  emits one `@dsCard` preview HTML per component into `previews/`, and writes a
  `manifest.json` (tag → source + preview). No React, no `tsc`.
- `.design-sync/ds-src/package.json` — drop the `react`/`react-dom`/`typescript`
  devDependencies and the `dist` entry points.
- `.design-sync/config.json` — `shape` becomes `web-components`; it names the
  `manifest`, component `source`, `runtime`, and `previews` instead of a React
  package `entry`/`globalName`.
- `.design-sync/NOTES.md` + `.design-sync/conventions.md` — rewritten to the
  wrapper-free contract (embed `<kit-*>` tags directly; the wrapper-drift risk
  is retired); `.gitignore` ignores the new `components/`, `previews/`, and
  `manifest.json` build outputs.

## Decisions

- **Light DOM + `display: contents` host, not Shadow DOM (Phase 3).** The issue
  floated per-component Shadow-DOM adoption. Light DOM keeps the emitted `.kit-*`
  tree byte-identical to the old builders' output, so `kit.css` and every app's
  CSS custom properties keep working with zero app changes — the safest path that
  satisfies "runnable at every commit." Shadow DOM was not needed.
- **`styles/bridge.css` stays.** The issue hypothesized Shadow-DOM encapsulation
  might let the design-sync bridge be retired. It cannot: the bridge is a
  var-name *adapter* (design-tokens emits `--bg`/`--ink`; the kit reads
  `--surface`/`--text`), a naming mismatch unrelated to DOM encapsulation. Kept,
  and this is documented for Phase 4.
- **Backward-compatible factory functions.** Rather than make apps adopt tags,
  `kit.js` keeps the exported functions returning the new elements, so the 8
  blueprint apps are untouched. v0 has no back-compat constraint, but this keeps
  the diff to the presentation layer.
- **Vendored Lit rather than a declared browser dependency.** The kit is served
  as-is with no bundler, so it needs a single self-contained ESM file; it is
  derived from the pinned npm package via a committed, reproducible script.
- **Design-sync push is a separate credentialed step.** The local restructure
  (delete wrappers, point at the real files, generate `@dsCard` previews +
  `manifest.json`) is what this PR owns and verifies. The actual claude.ai/design
  push runs later via the `/design-sync` skill against the pinned `projectId`;
  the `config.json` `shape: "web-components"` is validated there. The static
  Ask/@-mention shells are **dropped** from the design system (not re-authored as
  Lit) — a static shell would re-introduce the exact DOM duplication this
  migration removes, and the live controllers were already excluded.

## Out of scope (unchanged, per the issue)

- `apps/desktop` renderer (React DOM migration, #325) — untouched.
- `apps/mobile` (React Native) — no overlap.
- Blueprint app business logic / vault contract — presentation layer only.
- The kit's **live-network controllers** — the Ask SSE driver, `attachMentionField`,
  and the vault-fetching `attachMentionPopover` — stay the imperative controllers
  they were (same exclusion the old design-sync applied). Only their
  presentation primitives were ported.

## Verification

- `packages/blueprints` — `vitest run` green (123 tests).
- `packages/app-engine` — `vitest run` green (240 tests), including a new
  `static-server` case asserting `elements.js` + `lit-core.min.js` serve from
  the shared dir.
- jsdom render smoke: the full `kit.js` module evaluates cleanly (Ask controller
  still mounts, all elements define), and every factory
  (`letterAvatar`/`lineChart`/`barChart`/`barSpan`/`toast`/`showSkeleton`/
  `mentionChip`/`renderReferenceStrip`) produces its custom element emitting the
  expected `.kit-*` markup, with `<kit-toast>` firing `kit-undo`/`kit-dismiss`
  and `<kit-reference-strip>` firing `onRemove`.
- `oxfmt --check` and `oxlint` clean on all hand-authored changes; the vendored
  bundle is ignored by both (regenerated, not hand-edited).
- `node scripts/vendor-lit.mjs` reproduces `lit-core.min.js` bit-for-bit.

Re-runnable:

```sh
# build prerequisites (worktree), then the two suites this change touches
( cd packages/design-tokens && bun run build )
( cd packages/app-engine && bun run build && bun run test )
( cd packages/blueprints && bun run test )
# reproduce the vendored Lit bundle from the pinned package and confirm no drift
node packages/blueprints/scripts/vendor-lit.mjs && git diff --exit-code packages/blueprints/kit/lit-core.min.js
# design-sync (Phase 2): the wrapper-free build assembles the bundle + previews
node .design-sync/ds-src/build.mjs   # → styles/bundle.css, components/*, 8 @dsCard previews, manifest.json
# format + lint the hand-authored changes
npx oxfmt --check packages/blueprints/kit/kit.js packages/blueprints/kit/elements.js \
  packages/blueprints/scripts/vendor-lit.mjs packages/app-engine/src/http/static-server.ts
npx oxlint packages/blueprints/scripts/vendor-lit.mjs packages/app-engine/src/http/static-server.ts
```

## Audit

Fresh-context sub-agent (haiku) verdict:

- **A1 — What changed matches the diff:** PASS — All files listed (elements.js, kit.js, kit.css, vendor-lit.mjs, lit-core.min.js, static-server.ts/test.ts, package.json, .oxfmtrc.jsonc, bun.lock, .gitignore; design-sync build.mjs rewritten, config.json shape:"web-components", NOTES.md + conventions.md rewritten, 17 React wrapper .tsx files deleted, 17 preview .tsx files deleted, package.json/package-lock.json modified, receipt new) are present in the diff with correct scope and descriptions.
- **A2 — checked items realized in the diff:** PASS — All five phases [x] checked and realized: Phase 0 (spike in issue, no code); Phase 1 (all 8 Lit components—KitAvatar/KitMeter/KitLineChart/KitBarChart/KitSkeleton/KitToast/KitMentionChip/KitReferenceStrip—in elements.js with customElements.define(), thin factory functions in kit.js); Phase 2 (17 React wrappers + previews deleted, build.mjs rewritten to copy real files + generate previews + manifest.json, config.json shape:"web-components"); Phase 3 (display:contents host rule for all 8 custom elements in kit.css); Phase 4 (vanilla builders removed from kit.js, NOTES.md + conventions.md rewritten to wrapper-free contract).
- **A3 — checklist mirrors the issue:** PASS — Receipt checklist matches issue #327 exactly: all five phases (0–4) in same order, all [x] checked, descriptions match issue scope.

## Steering

Fresh-context sub-agent (haiku) verdict:

- **B1 — all steering events recorded:** PASS — Zero human-steering events in session; all 150 user-type entries are tool results, /goal command, or system acknowledges, no mid-task corrections or interrupts.
- **B2 — no non-steering message recorded as steering:** PASS — Steering section contains only agent verdicts with no non-steering messages falsely marked as steering.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-e892a36c-e81-1783537119-1 | claude-code | e892a36c-e81b-45b3-b446-15a1131972a8 | #327 | claude-opus-4-8 | 39444 | 732146 | 34582834 | 233261 | 1004851 | 27.8961 | 39444 | 732146 | 34582834 | 233261 |  |
| claude-code-e892a36c-e81-1783537388-1 | claude-code | e892a36c-e81b-45b3-b446-15a1131972a8 | #327 | claude-opus-4-8 | 19999 | 52058 | 3530237 | 30496 | 102553 | 2.9529 | 59443 | 784204 | 38113071 | 263757 |  |
| claude-code-e892a36c-e81-1783537542-1 | claude-code | e892a36c-e81b-45b3-b446-15a1131972a8 | #327 | claude-opus-4-8 | 733 | 52072 | 4653802 | 24318 | 77123 | 3.2640 | 60176 | 836276 | 42766873 | 288075 |  |
| claude-code-e892a36c-e81-1783537558-1 | claude-code | e892a36c-e81b-45b3-b446-15a1131972a8 | #327 | claude-opus-4-8 | 0 | 0 | 0 | 0 | 0 | 0.0000 | 60176 | 836276 | 42766873 | 288075 |  |
| claude-code-e892a36c-e81-1783537614-1 | claude-code | e892a36c-e81b-45b3-b446-15a1131972a8 | #327 | claude-opus-4-8 | 11613 | 23544 | 1702854 | 6942 | 42099 | 1.2302 | 71789 | 859820 | 44469727 | 295017 |  |
| claude-code-e892a36c-e81-1783538550-1 | claude-code | e892a36c-e81b-45b3-b446-15a1131972a8 | #327 | claude-opus-4-8 | 23734 | 142935 | 23838741 | 102207 | 268876 | 15.4866 | 95523 | 1002755 | 68308468 | 397224 |  |
