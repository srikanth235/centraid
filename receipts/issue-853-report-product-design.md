# Issue 853 - The nightly test report renders in the product's design

## Checklist

Mirrors the acceptance criteria of [#853](https://github.com/srikanth235/centraid/issues/853).

- [x] `scripts/test-report/report-tokens.css` is emitted by `scripts/site-tokens.mjs` and `bun run lint:site-tokens` fails on drift from the emitter
- [x] The layers the report authors contain no colour literal, no `font-family` outside `--font-sans` / `--font-code`, and no `Inter`; the rendered page resolves every `var()` and fetches nothing
- [x] The report renders in `light` and `dark`, following the system when no `data-theme` is set
- [x] Every matrix state stays visually distinct and is carried as text as well as colour
- [x] The four bundled faces are inlined as `data:` URIs; an unsubstituted `@font-face` rule throws at generate time
- [x] Report content is byte-unchanged apart from styling — same sections, same states, same numbers
- [x] `docs/decisions.md` carries the ruling; `docs/design-divergences.md` carries the status-ramp divergence with its bound

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

Eleven files: the emitter, four report modules, one new test module, one generated sheet, one formatter exclusion, two docs, and this receipt.

**`scripts/site-tokens.mjs` — one emitter, three surfaces.** It gains a third emitted artifact, `scripts/test-report/report-tokens.css`: `toCss()` unmodified, the same `SITE_LAYER` the two sites take, the bundled faces, and a new `REPORT_LAYER` carrying the matrix status ramp. Same `bun run site:tokens` to write, same `bun run lint:site-tokens` to gate by bytes. No second emitter, no second command, no second gate. **`scripts/test-report/report-tokens.css` is emitted by `scripts/site-tokens.mjs` and `bun run lint:site-tokens` fails on drift from the emitter** — the sheet is compared byte-for-byte, the same way each site's `centraid-tokens.css` is.

**The four bundled faces are inlined as `data:` URIs; an unsubstituted `@font-face` rule throws at generate time.** `generate.mjs` emits one self-contained file that `prepare-pages-site.mjs` publishes to *both* the mutable `test-report/nightly/` alias and the immutable `test-report/nightly/runs/<slug>/` archive. No relative `url()` resolves from both depths, a root-absolute one bakes in the `/centraid/` Pages base and breaks `file://` reading, and an archived run has to keep rendering years after the run that produced it. `facesInline()` rewrites only the `src` target of the design package's own `@font-face` block — the weights, subsets, `unicode-range` split and `font-display` stay the emitter's — and throws on any file left unsubstituted. ~64 KB against the 1,591,287 bytes the deployed nightly page weighed on 2026-08-23 (a local render with no evidence loaded is ~740 KB).

**`scripts/test-report/report-theme.mjs` (new) — the stylesheet, out of the generator.** Node-only, because the two halves run under different engines: `site-tokens.mjs` runs under bun and can import `packages/design`'s TypeScript, while `test:report` runs under **node** and cannot, so committed-generator-output-plus-freshness-gate is the shape both public sites already use for the same class of reason. `designSystemCss()` reads and verifies the committed sheet; `REPORT_CSS` is the report's component layer, lifted out of the 6 KB single line `generate.mjs` carried. `verifySheet()` is split out as a pure function so its two guards — a ramp that is gone, a face left linked instead of inlined — are reachable from a test rather than only from a broken checkout.

**`scripts/test-report/generate.mjs` — token-only.** Its inline `<style>` is replaced by `designSystemCss()` + `REPORT_CSS` + `BRIEFING_CSS`; all eight inline `style=` sites are gone. Seven were honesty banners — three `color:var(--amber)`, three `color:var(--red)`, one `color:var(--grey)` — and the eighth is the `unhandledErrors` line, which is rendered beside the array rather than inside it; they became `.lede.attention` / `.urgent` / `.absent`, and the `border-left:3px solid var(--blue)` main-slot banner became `.lede.scope`. The inline `style="color:var(--blue)"` on the tracking-issue link is gone too, since `a` takes `--link`. The report's own `prefers-reduced-motion` rule is gone with the old sheet — `toCss()` emits the product's one global rule, and a second one is how the two drift.

**`scripts/test-report/render-briefing.mjs` — `BRIEFING_CSS` rewritten** onto the same ramp: the verdict strip, the severity-band chips (`--st-s1` … `--st-s4`), the delta and pinned chips, the adversary grid. `--panel`, `--green`, `--red`, `--amber`, `--violet`, `--grey` and the loose `#ff9e64` / `#ffcb6b` / `#334038` literals are gone.

**`scripts/test-report/prepare-pages-site.mjs` — the run-index landing page** took the same sheet. It had Google-blue links (`#0b57d0`) and `#e6f4ea` / `#137333` / `#fce8e6` / `#a50e0e` tag fills; its per-run outcome tag is now a chip in `--st-solid-text` / `--st-failed-text` on a border, never a filled ground. Its injected "per-push / main" banner takes `.lede.scope`.

**`scripts/test-report/report-theme.test.mjs` (new)** is the gate the old sheet never had: nine cases over the generated sheet, the authored layers and the rendered page. It is the file that makes every claim in `## Verification` re-runnable rather than asserted in prose, and it joins the existing `scripts/test-report` vitest project, so `bun run test:ratchet:unit` covers it and its coverage counts toward the same floors.

**`oxfmt.config.ts`** adds `scripts/test-report/report-tokens.css` to `ignorePatterns`, beside the existing `scripts/*-site/public/assets/centraid-tokens.css` entry and for the identical reason: oxfmt rewrites the emitted sheet's quoting, which makes the byte-exactness gate fail on every regeneration while proving nothing about style.

**The report renders in `light` and `dark`, following the system when no `data-theme` is set** — the page was pinned `color-scheme:dark` with no light ramp at all; it now takes the product's four-way theme block (`:root`, `:root:not([data-theme])` under `prefers-color-scheme`, and both explicit `[data-theme]` pins).

**Every matrix state stays visually distinct and is carried as text as well as colour**, and the ramp is now two registers, which is the report's own thesis rather than a graphic choice. A lane RAN and returned a result — passed, partial, failed, flaky — so the cell is a filled mark. Nothing ran or nothing owns it — n/a by design, tracked gap, evidence unmatched, owner silent, missing, stale, lane did not run, named absence — so the cell is a recessed trough carrying its tone as a 3px inline-start rule and as its own numerals. That is what DESIGN.md already requires of `--warning`, `--seam` and `--attention` (type, a border or a 2px rule, never a fill). Before it **every one of the 165 cells was a fill**, and the 136 unproven ones were a flat `#46534c` block — so the page was a wall of solid colour in which the handful of cells carrying actual evidence had nothing to distinguish them but hue. Absence stays fully visible and stays classified; what it stops doing is out-shouting the proof. Every cell also carries its state in its class, its `title`, the legend and the evidence inspector, so nothing is legible only to a reader who sees hue.

**`docs/decisions.md` carries the ruling; `docs/design-divergences.md` carries the status-ramp divergence with its bound.** The ruling is dated 2026-08-23 and names its non-goal (a second design language for internal or engineering-facing surfaces); the register adds a "The nightly test report" section with five rows — the four measured states as fills, the eight absent states as troughs, `--c-slate` for n/a-by-design, the inlined faces, and the open `lint:design-tokens` row.

## Decisions

**The ramp was not ported 1:1, and that is the one substantive judgment call in this diff.** The straight translation — every state a fill, in the nearest product token — put 136 of 165 cells on `--text-faint` over near-white paper and three system-signal tones (`--warning`, `--seam`, `--attention`) into fills that DESIGN.md forbids outright. Rendered and looked at, the absences drowned the evidence. Splitting measured-fills from absent-troughs *shrinks* the divergence that had to be registered rather than enlarging it, and it renders the report's stated thesis instead of contradicting it. The alternative — port faithfully, register a larger divergence, and file a follow-up — was rejected because it would have shipped a page whose own gate text says absence must not be mistaken for proof while the pixels said the opposite.

**"n/a by design" left the amber family** for `--c-slate`, a content marker. An exclusion an app's own manifest declares is a classification, not a degraded reading. It was also forced: in dark, `--warning` (`#d9a75b`) and `--attention` (`#D8A64E`) land within a hair of each other, so "n/a by design" and "owner silent" sharing that family would be one state to any reader. `--warning` keeps this page's one honest use of itself, `--st-degraded`, on the verdict strip. This is a semantic change to what a colour means on this page, so it is called out rather than buried in the ramp table.

**One acceptance criterion was reworded, in the issue and here together.** #853 originally asked that "the generated report HTML contains no colour literal". That is not achievable and never was: the generated sheet declares the tokens, and a token declaration IS a colour literal — a real render carries 77 of them, all inside the embedded `<style>`. The criterion conflated the layers the report *authors* with the sheet it *embeds*. Both the issue and this checklist now state the enforced scope — zero literals in the authored layers, every `var()` resolved and nothing fetched on the rendered page — rather than leaving a box ticked against a claim the diff cannot support. Flagged rather than quietly narrowed: the independent audit refuted the original wording, and moving a goalpost silently is the failure that refutation exists to catch.

**The faces are inlined here and linked on the two sites.** Divergence between the three surfaces was accepted because the cause is publication, not taste: the report publishes identical bytes at two depths and archives per run. The cost is a ~83 KB generated file in the repo; the alternative costs every archived run its typography the first time the asset layout changes.

**The gate was extended rather than duplicated.** Adding the report to `lint:site-tokens` means one command, one failure message and one re-emit instruction across all three surfaces. The colour-literal and withdrawn-face rules are report-only, because the two sites paint marks in inline SVG inside `index.html` where a `fill` must name a colour literally, and the report draws no artwork — its one SVG is a sparkline whose stroke is a token. The literal rule matches six and eight hex digits, not three, because `#839` in this tree is an issue number and a gate that reds on every citation is a gate someone turns off.

## Out of scope

- **Report content, model, schema, validators and verdict semantics.** Untouched. Same sections, same states, same numbers; the diff is styling. This is asserted rather than asserted-by-hand: all 422 pre-existing report tests pass unchanged.
- **The deployment path, the gh-pages merge and the run-archive layout.** Untouched.
- **`bun run lint:design-tokens` is still not pointed at `scripts/test-report/`.** Deliberately not closed by widening a budget, on the same reasoning that keeps it off `scripts/*-site`: that gate's checked-in budget is empty and must stay empty, and the report still carries bespoke layout dimensions (the 40px cell, the 98px header band, the 230px surface column) that a heat map's geometry genuinely needs and no `--sp-*` rung expresses. Recorded as an open row in [design-divergences.md](../docs/design-divergences.md#the-nightly-test-report).
- **`typecheck` and `test:qualities` were not run locally.** The workspace packages are unbuilt in this container, so both fail identically on a clean `origin/main` checkout here (`Failed to resolve entry for package "@centraid/backup"`). This diff touches only `.mjs` scripts, one generated `.css`, `oxfmt.config.ts` and Markdown — nothing in either graph. CI builds first and covers both.

## Verification

**Report content is byte-unchanged apart from styling — same sections, same states, same numbers**: the 422 pre-existing report tests in `scripts/test-report/**` pass without an edit to any of them, and the 9 new cases are additive.

```sh
bun run site:tokens          # re-emit all three surfaces
bun run lint:site-tokens     # byte-for-byte + unresolvable var() + literal scan
bun run test:ratchet:unit    # 29 files, 431 tests (422 pre-existing, 9 new)
bun run test:report:smoke
node scripts/ci/run-gates.mjs format:check lint scripts:test test:matrix test:ratchet \
  test:hygiene-ratchet check:ui-receipt check:reachability lint:packages lint:tsconfigs \
  lint:css lint:design-tokens lint:design-md lint:type-floor lint:motion-rule \
  lint:aria-labels lint:container-opacity lint:hairline lint:logical-insets
```

All green. **The gate was verified to FAIL first**: run against the unmigrated tree it reported 61 findings across `generate.mjs`, `render-briefing.mjs` and `prepare-pages-site.mjs` — every `--green` / `--red` / `--amber` / `--blue` / `--violet` / `--cyan` / `--grey` / `--panel` reference and every loose hex literal.

**The layers the report authors contain no colour literal, no `font-family` outside `--font-sans` / `--font-code`, and no `Inter`; the rendered page resolves every `var()` and fetches nothing** — the two halves are asserted separately in `scripts/test-report/report-theme.test.mjs`, because they are different claims. The colour-literal and face checks run over `REPORT_CSS` + `BRIEFING_CSS` only: the generated sheet is *where* a colour literal belongs (a token declaration is a literal, and a real render carries 77 of them, all inside the embedded sheet), so asserting zero literals over the whole page would be asserting something false. The rendered-page case, driven through the real `generate.mjs` against the synthetic fixture root, asserts that every `var()` resolves, that no `Inter` survives, and that no `url()` is anything but `data:`. The same file asserts that **the four bundled faces are inlined as `data:` URIs; an unsubstituted `@font-face` rule throws at generate time**, that **the report renders in `light` and `dark`, following the system when no `data-theme` is set**, and that **every matrix state stays visually distinct and is carried as text as well as colour** — the last by merging each state's shared-trough rule with its own tone rule and requiring the twelve results to be distinct, with the two deliberate collapses (`infra-mismatch` riding `failed`'s consequence tone, `lane-did-not-run` being the same absence as `stale`) named in the test and asserted to still match.

Rendered against the real repo root and screenshotted in both themes at 1600px — hero, verdict strip, attention queue, the app×designed-state grid, the full 15×11 matrix, and a swatch of all twelve cell states:

```sh
node scripts/test-report/generate.mjs --output /tmp/report.html
/opt/pw-browsers/chromium --headless --disable-gpu --hide-scrollbars \
  --window-size=1600,1250 --screenshot=/tmp/report.png file:///tmp/report.html
```

Ink on every fill clears AA in both themes: `--st-on-fill` is `--text-inv`, which inverts with the theme as the identity hues do (oklch L .50 light, L .72 dark).

## Audit

Independent fresh-context adjudication of three checks against `git diff origin/main...HEAD` (11 files), the tree, and [#853](https://github.com/srikanth235/centraid/issues/853).

### 1. `## What changed` faithfully describes the diff — REFUTED

One changed file is never accounted for. The section opens "Eleven files. The emitter, four report modules, one generated sheet, one formatter exclusion, two docs, and this receipt" — that enumeration sums to **ten** (1 + 4 + 1 + 1 + 2 + 1), and the four report modules it then describes in its own paragraphs are `report-theme.mjs`, `generate.mjs`, `render-briefing.mjs` and `prepare-pages-site.mjs`. The eleventh file in the diff, the new 194-line `scripts/test-report/report-theme.test.mjs`, is named nowhere in `## What changed` (it appears only under `## Verification`). Fix the tally and give the test module its line.

Two imprecisions in the same section, smaller but worth correcting:

- "the eight inline `style="color:var(--amber)"` honesty banners". The **count is right** — eight `style=` sites in `generate.mjs` (`git diff` at lines 1446, 1457, 1460, 1471, 1477, 1483, 1489/1491, 1500) — but only three were `color:var(--amber)`; three were `--red`, one `--grey`, and one a `border-left … var(--blue)` rule. The eighth (`unhandledErrors`) is also not in the `honestyBanners` array.
- "before it 136 of 165 cells were a saturated fill". The counts check out — rendering `node scripts/test-report/generate.mjs` against the real root yields exactly 165 `.cell` elements, 136 of them `.cell.missing` — but on `origin/main` those 136 painted `#46534c`, a desaturated grey, and **all 165** were fills, not 136. The same sentence is repeated in `docs/design-divergences.md`.

Everything else in the section was checked and holds: `toCss()` untouched and `SITE_LAYER` reused (`scripts/site-tokens.mjs` `reportSheet()`); `facesInline()` rewrites only `src` and throws on a survivor; the report's own `prefers-reduced-motion` rule is gone and the sheet carries exactly one (`grep -c prefers-reduced-motion scripts/test-report/report-tokens.css` → 1, none in `REPORT_CSS`); `render-briefing.mjs` no longer names `--panel`/`--green`/`--red`/`--amber`/`--violet`/`--grey` or `#ff9e64`/`#ffcb6b`/`#334038`; `prepare-pages-site.mjs` drops `#0b57d0`/`#e6f4ea`/`#137333`/`#fce8e6`/`#a50e0e` for `--st-solid-text`/`--st-failed-text` on a border; `oxfmt.config.ts` adds the one `ignorePatterns` entry; `docs/design-divergences.md` adds a five-row section. Sizes check out: the sheet is 84,740 bytes ("~83 KB") of which 63,876 are base64 face bytes ("~64 KB"). Not verifiable here: "a page that is already ~1.6 MB" — a local render is 738 KB; the figure is inherited from the issue.

### 2. Every `- [x]` item is realized in the diff — REFUTED

Two of the seven did not hold as written; one was repaired in the working tree while this audit ran, the other stands.

- **Box 3, "renders in `light` and `dark`, following the system when no `data-theme` is set".** The CSS work is present (`scripts/test-report/report-tokens.css:236`, `:313`, `:389`, `:495-512`), but as **committed** (b4133022) the test asserting it **failed**: `report-theme.test.mjs:88-89` asserted `toContain('[data-theme="dark"]')` with double quotes while the emitted sheet writes `[data-theme='dark']`. `bun run test:ratchet:unit` → `Test Files 1 failed | 28 passed (29)`, `Tests 1 failed | 430 passed (431)` on "declares both themes, and follows the system when neither is pinned". `.github/workflows/ci.yml:245` runs that command, so the committed branch was red in CI and the "All green" line under `## Verification` was false. A working-tree fix (quote-agnostic `toMatch(/\[data-theme=['"]dark['"]\]/u)`) appeared **during this audit** and was re-verified green: `Test Files 29 passed (29)`, `Tests 431 passed (431)`. The box holds once that edit is committed; the "All green" claim only becomes true with it.
- **Box 2, "The generated report HTML contains no colour literal …".** The rendered page carries **77 unique 6-digit hex literals**, all inside the embedded generated sheet (`python3` scan of a real `generate.mjs` render: 77 in the `<style>` block, 0 in the body). That is by design — a token declaration is where a literal belongs — but it is not what the box says, and `## Verification` overstates the coverage: it says the four clauses are "asserted in `scripts/test-report/report-theme.test.mjs` over both the authored layers and the rendered page", whereas the rendered-page test (`report-theme.test.mjs:176-193`) asserts only unresolved `var()`, no `Inter`, and no non-`data:` `url()` — no colour-literal and no `font-family` check. Likewise the emitter's colour-literal rule (`REPORT_FORBIDDEN`, `scripts/site-tokens.mjs:207-221`) is scanned over `scripts/test-report/*.mjs` only, never over the sheet or the HTML. Re-word the box and the verification line to the scope actually enforced (the authored layers).

The other five verified:

- Box 1: `bun run lint:site-tokens` exits 0 and prints "home + docs + the nightly report"; the byte comparison is `scripts/site-tokens.mjs:477-499` (`actual.equals(bytes)` → "differs from the emitter"). The gate was also confirmed to bite: dropping this branch's `site-tokens.mjs` + `report-tokens.css` into a clean `origin/main` worktree reports **61** findings across `generate.mjs` (45), `render-briefing.mjs` (10) and `prepare-pages-site.mjs` (6) — the receipt's number, exactly.
- Box 4: `report-theme.mjs:141-165` gives each of the twelve states a treatment (four fills, eight troughs with an inline-start tone), and every cell also carries its state in its class/`title`/legend; `report-theme.test.mjs:120-173` merges each state's rules and requires distinctness with the two named collapses. That test passes.
- Box 5: four `url(data:font/woff2;base64,…)` sources in the sheet and zero linked; `verifySheet()` (`report-theme.mjs:50-54`) throws at generate time on `src: url(` that is not `data:`; `facesInline()` throws at emit time on a survivor.
- Box 6: strongest evidence in the diff. Rendering both `origin/main` and this branch against the real root and stripping `<style>` and `style=` attributes gives **byte-identical** HTML (639,583 bytes each) apart from the two generation timestamps. The 422 pre-existing tests all pass (430 of 431 as committed, the single failure being the new theme test above; 431 of 431 with the working-tree fix), and no pre-existing test file is touched.
- Box 7: `docs/decisions.md:299` (ruled 2026-08-23, names the non-goal) and the new `docs/design-divergences.md#the-nightly-test-report` section with its bound.

Receipt counts spot-checked and correct: 9 new test cases, "29 files, 431 tests (422 pre-existing, 9 new)", 61 pre-migration findings, five divergence rows.

### 3. `## Checklist` mirrors the issue's acceptance criteria — PASS

Machine-compared the seven `- [x]` items against the seven `- [ ]` items under "## Acceptance criteria" in the issue body (fetched from the REST API; the MCP reader truncates it at "an inline `<style"). Same count, same order, and all seven strings identical apart from the issue's trailing full stops. Nothing dropped, nothing softened, nothing added.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-23 | claude-code | - |
| 2026-08-23 | claude-code | 7a729e34-2c7f-5e19-b800-09a117655f2e |
