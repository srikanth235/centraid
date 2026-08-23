# Issue 853 - The nightly test report renders in the product's design

## Checklist

- [x] Emit the report's token sheet from the SAME emitter the two public sites take theirs from
- [x] Inline the four bundled faces, so an archived run keeps rendering at either depth it is published to
- [x] Rewrite the report's stylesheet and every inline `style=` onto product tokens
- [x] Give the report `light` and `dark` on the product's theme contract
- [x] Restructure the matrix ramp so measured evidence leads and absence stays classified
- [x] Extend `lint:site-tokens` over the report's authored modules
- [x] Add byte-level tests for the layers the report authors and for the page it renders
- [x] Record the ruling and the heat-map divergences in the docs

## What was actually wrong

[#843](https://github.com/srikanth235/centraid/issues/843) / [#841](https://github.com/srikanth235/centraid/issues/841) unified `centraid.dev` and `centraid.dev/docs/` onto the product design system on 2026-08-21 and scoped itself to `scripts/home-site/` and `scripts/docs-site/`. The **third public surface on the same Pages origin was left behind**: `scripts/test-report/` contained zero references to `site-tokens` or `centraid-tokens`, and every emitted page opened with

```
:root{color-scheme:dark;--text:#ecf3ee;--text-soft:#8f9f98;--panel:#111713;--line:#273129;--bg:#090d0b;
--green:#5bd697;--red:#ff766f;--amber:#e9b95c;--blue:#72a9ff;--violet:#b39cff;--cyan:#69d8d0;--grey:#738079;
--sans:Inter,ui-sans-serif,system-ui,…}
```

— a second palette, a second face the product does not ship, a second type scale, and no light theme at all.

It had also been mistaken for solved work. [255be5de](https://github.com/srikanth235/centraid/commit/255be5debf489827971f8433e2b1897d56f694c1) (#839/#845) rewrote the report's *content* — matrix schema v2, the app×engine / app×seat / app×designed-state grids, the briefing, the verdict — and its CSS diff only appended rules for the new sections. The `:root` block above is byte-identical before and after it. The published page was current in content and untouched in visual identity, which is exactly the shape of drift a gate has to catch, because a CSS mistake never throws: a `var()` naming a token nothing declares is invalid at computed-value time, the declaration is dropped, and the page renders wrong in silence.

## What changed

**One emitter, three surfaces.** `scripts/site-tokens.mjs` gains a third emitted artifact, `scripts/test-report/report-tokens.css`: `toCss()` unmodified, the same `SITE_LAYER` the two sites take, the bundled faces, and a new `REPORT_LAYER` carrying the matrix status ramp. Same `bun run site:tokens` to write, same `bun run lint:site-tokens` to gate by bytes. No second emitter, no second command, no second gate.

**The faces are inlined, and only here.** `generate.mjs` emits one self-contained HTML file that `prepare-pages-site.mjs` publishes to *both* the mutable `test-report/nightly/` alias and the immutable `test-report/nightly/runs/<slug>/` archive. No relative `url()` resolves from both depths; a root-absolute one bakes in the `/centraid/` Pages base and breaks `file://` reading; and an archived run has to keep rendering years after the run that produced it. So `facesInline()` rewrites only the `src` target of the design package's own `@font-face` block — the weights, subsets, `unicode-range` split and `font-display` stay the emitter's — into `data:` URIs, and throws if any file is left unsubstituted. ~64 KB on a page that is already ~1.6 MB.

**The two run under different engines, which is why the sheet is committed.** `site-tokens.mjs` runs under bun and can import `packages/design`'s TypeScript; `test:report` runs under **node** and cannot. Committed-generator-output-plus-freshness-gate is the shape the two sites already use, for the same class of reason.

**The stylesheet moved out of the generator.** `scripts/test-report/report-theme.mjs` is new and node-only: `designSystemCss()` reads and verifies the committed sheet, and `REPORT_CSS` is the report's component layer, lifted out of the 6 KB single line `generate.mjs` carried. `verifySheet()` is split out as a pure function so its two guards — a ramp that is gone, a face that is linked instead of inlined — are reachable from a test rather than only from a broken checkout.

**Every layer the report authors is token-only.** `REPORT_CSS` and `BRIEFING_CSS` declare no colour, no face and no type scale; the eight inline `style="color:var(--amber)"` banners in `generate.mjs` became `.lede.attention` / `.urgent` / `.absent` / `.scope`; the landing page in `prepare-pages-site.mjs` (Google-blue links, `#e6f4ea` / `#137333` tag fills) takes the same sheet. The report's own reduced-motion rule is gone — `toCss()` emits the product's one global rule.

**The ramp is two registers, and the split is the report's own thesis.** A lane RAN and returned a result — passed, partial, failed, flaky — so the cell is a filled mark. Nothing ran or nothing owns it — n/a by design, tracked gap, evidence unmatched, owner silent, missing, stale, lane did not run, named absence — so the cell is a recessed trough carrying its tone as a 3px inline-start rule and as its own numerals. That is not a softening: it is what DESIGN.md already requires of `--warning`, `--seam` and `--attention` (type, a border or a 2px rule, never a fill), and before it 136 of 165 cells were a saturated fill, so the page read as mostly-loud with the evidence lost inside it. Absence stays fully visible and stays classified; what it stops doing is out-shouting the proof.

**"n/a by design" left the amber family.** It takes `--c-slate`, a content marker, because an exclusion an app's own manifest declares is a classification and not a degraded reading. It was also forced: in dark, `--warning` (`#d9a75b`) and `--attention` (`#D8A64E`) land within a hair of each other, so "n/a by design" and "owner silent" sharing that family would be one state to any reader. `--warning` keeps this page's one honest use of itself, `--st-degraded`, on the verdict strip.

## The gates

`lint:site-tokens` now scans `scripts/test-report/*.mjs` (tests excluded — a test asserting a literal is REJECTED has to spell one) with the three shared rules plus two of its own: a colour literal at six or eight digits, and the withdrawn face. Six digits, not three, because `#839` in this tree is an issue number and a gate that reds on every citation is a gate someone turns off. The colour rule is report-only: the two sites paint marks in inline SVG inside `index.html`, where a `fill` has to name a colour literally, and the report draws no artwork — its one SVG is a sparkline whose stroke is a token.

`scripts/test-report/report-theme.test.mjs` adds eight cases: the sheet carries the tokens and the ramp, every face is a `data:` URI, both themes are declared and neither is pinned by default, the guards refuse a gutted sheet, the authored layers declare no colour and name no face outside the two token stacks, every `var()` in them resolves, every matrix state has a treatment of its own, and the *rendered page* resolves every token, names no withdrawn face, and fetches nothing. The two deliberate collapses — `infra-mismatch` riding `failed`'s consequence tone, `lane-did-not-run` being the same absence as `stale` — are named in the test and asserted to still MATCH, so a future edit cannot silently split one either.

## What this pass did not do

- **The report's content, model, schema, validators and verdict semantics are untouched.** Same sections, same states, same numbers; the diff is styling. All 422 pre-existing report tests pass unchanged.
- **The deployment path, the gh-pages merge and the run-archive layout are untouched.**
- **`bun run lint:design-tokens` is still not pointed at `scripts/test-report/`**, on the same reasoning that keeps it off `scripts/*-site`: that gate's checked-in budget is empty and must stay empty, and the report still carries bespoke layout dimensions (the 40px cell, the 98px header band, the 230px surface column) that a heat map's geometry needs and no `--sp-*` rung expresses. Recorded as an open row in [design-divergences.md](../docs/design-divergences.md#the-nightly-test-report) rather than closed by widening a budget.

## Validation

- `bun run lint:site-tokens` — home + docs + the nightly report match the emitters. Verified it FAILS first: against the unmigrated tree it reported 61 findings across `generate.mjs`, `render-briefing.mjs` and `prepare-pages-site.mjs`.
- `bun run test:ratchet:unit` — 29 files, 431 tests, green.
- `bun run test:report:smoke`, `bun run lint`, `bun run format`, `bun run check:reachability` — green.
- Rendered against the real repo root and screenshotted in both themes at 1600px: hero, verdict strip, attention queue, the app×designed-state grid and the full 15×11 matrix, plus a swatch of all twelve cell states. Every state is distinguishable in both themes; ink on every fill clears AA.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-23 | claude-code | - |
