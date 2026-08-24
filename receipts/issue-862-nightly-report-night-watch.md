# Issue #862 — Umbrella: revamp the nightly report to the Night Watch design

One orchestrated pass restructuring `scripts/test-report/generate.mjs` output
from the #853 layout (hero heading, saturated-fill history, inline inspector)
to the Night Watch mockup: masthead + verdict bar + sticky TOC, eight sections
in the mockup's running order, word-on-tint cell register, ledgers, a fixed
bottom-sheet inspector, and SVG sparklines — over the same evidence pipeline,
with the honesty gate untouched.

## Checklist

- [x] Night Watch palette declared in the generated report sheet for both themes; `lint:site-tokens` green; `verifySheet` refuses a sheet missing it
- [x] Page restructured to the Night Watch running order: masthead, verdict bar with since-last-night delta, sticky TOC, §1–§8, detail shelf, footer
- [x] Matrix cells render state words on quiet tints via the button register; all 12 states individually tellable; the two named collapses preserved
- [x] Attention queue, consent/joins/adversaries ledgers, journeys grid, fixed bottom-sheet inspector, and SVG sparklines implemented per the mockup geometry
- [x] Every section renders real evidence or an honest absence state; the nightly honesty gate is unchanged
- [x] Authored CSS layers stay hex-free and `var()`-resolvable; the rendered page stays fully self-contained (`data:` URIs only, no external links)
- [x] Test files evolved to the new structure with every #853 property preserved, and the report package gates green (`test:ratchet:unit`, `typecheck`, `format`, `lint:site-tokens`, `test:report:smoke`)
- [ ] `docs/design-divergences.md` and `docs/decisions.md` updated; superseded bespoke dimensions recorded
- [ ] Receipt `receipts/issue-862-nightly-report-night-watch.md` complete with independent `## Audit`
- [ ] Both-theme rendered screenshots compared against the mockup before push

## What changed

### W1 — the Night Watch palette enters the sheet

`scripts/site-tokens.mjs` gains a `NIGHT_WATCH_RAMP` table — one row per rung
carrying name, light value, dark value, so the three theme blocks cannot drift
from each other — and appends the lowered layer to the report sheet only; the
two public-site sheets are untouched. `scripts/test-report/report-tokens.css`
is regenerated (purely additive) and now declares the nineteen rungs three
times: light on `:root`, dark under both the `prefers-color-scheme` media
block and `[data-theme="dark"]`. The rungs are prefixed `--nw-` because
`--line`, `--danger` and `--link` already name product tokens in the sheet.
`scripts/test-report/report-theme.mjs` extends `verifySheet` to refuse a sheet
that declares no Night Watch palette or only its light half, after the face
check so a linked face still reports as itself.

The addition first pushed `site-tokens.mjs` to 687 lines, over the repo-hygiene
625 cap. Rather than a budget change, the file was compacted to 624: the ramp
became an aligned name/light/dark text table read by one named-group regex, the
separate Night Watch layer function dissolved into the tail of the report
layer's template, the twice-spelled write-or-byte-compare settle logic became
one helper, the two site trees are walked once and shared, and the duplicated
declared-props/face-bytes spellings were unified. The emitted sheets are
byte-identical before and after the compaction.

Checklist item 1 in full: Night Watch palette declared in the generated report
sheet for both themes; `lint:site-tokens` green; `verifySheet` refuses a sheet
missing it.

### W2 — the shell, the running order, and the cell register

`scripts/test-report/report-theme.mjs` carries the rewritten `REPORT_CSS`: the
Night Watch frame (13px body on `--nw-ground`, `.page` at 1060px, the 26px
masthead over a 1px `--nw-ink` rule, `.runmeta`, the verdict bar, the sticky
`nav.toc`, `h2` at 12px uppercase with its `§` tag and `.why` rationale, the
grid head on `--nw-sunken`, the detail-shelf cards, the footer and the 760px
collapses), all authored against `var(--nw-*)`.

`scripts/test-report/generate.mjs` is restructured. **Page restructured to the
Night Watch running order: masthead, verdict bar with since-last-night delta,
sticky TOC, §1–§8, detail shelf, footer.** The nine-tile hero the #853 page
opened with is deleted in favour of `<h1>Night watch</h1>` plus a `.runmeta`
line carrying scope, date, run id, evidence age and — only when the CI env
supplies a real slug and public URL — the immutable-slot and Actions links.
The old `renderVerdictStrip` section becomes a `role="status"` verdict bar with
the verdict word, the green/red/grey/stale counts and the delta sentence. §1 is
the attention queue, §2 app × seat, §3 app × designed state, §4 consent, §5
joins, §6 journeys, §7 adversaries, §8 the surface × quality-dimension heatmap
demoted from opening act, §9 the detail shelf; `<main>` becomes
`<main class="page">` and the footer is a `<footer>` carrying the generated-at
stamp, scope, run id and axis sizes.

**Matrix cells render state words on quiet tints via the button register; all
12 states individually tellable; the two named collapses preserved.** Each cell
is a `<button class="cell <state>">` whose text is the state's word — passed,
failed, infra, gap, flaky, silent, unmatched, stale, no lane, missing, named,
n/a — over a quiet family tint rather than a saturated fill. Ten treatments are
pairwise distinct by word-agnostic means (tint family, slope, weight, a dashed
rule); `.cell.infra-mismatch` shares its merged treatment with `.cell.failed`
and `.cell.lane-did-not-run` with `.cell.stale`, exactly the two collapses
#853 named. §2/§3 keep a separate declaration alphabet (`owned`, `unowned`,
`n/a`) on neutral tints. The legend becomes a `.keyline` with one entry per
distinct treatment and the two collapses shown as shared entries.

`scripts/test-report/report-verdict.mjs` gains `counts.green` and a
`greenDelta` on `verdictDelta`; `scripts/test-report/history-point.mjs`
whitelists `cellsPassed` so the delta has a series to read (null on nights
recorded before this pass). `scripts/test-report/render-briefing.mjs` loses the
now-dead `renderVerdictStrip` and its `.verdict*` rules, the verdict having
moved into the page's own bar.

### W2b — queue, ledgers, inspector, sparklines

**Attention queue, consent/joins/adversaries ledgers, journeys grid, fixed
bottom-sheet inspector, and SVG sparklines implemented per the mockup
geometry.** `scripts/test-report/render-briefing.mjs` rewrites all five
renderers into the Night Watch registers: the queue as `.qrow` at
`84px 1fr 190px 70px 120px` with bordered-and-tinted `.chip` bands, an owner
column and an age column; the consent ledger at
`170px 1fr 150px 110px 90px` over its eight real layers; joins at
`240px 1fr 120px 90px` over the ten laws; adversaries as three ledgers sharing
`200px 90px 90px 110px 1fr`; journeys as suite ledgers with a budget line.
State words render as coloured `.state` type, never a fill. `BRIEFING_CSS`
shrinks to five shelf-only rules.

`scripts/test-report/report-theme.mjs` adds those registers plus the
`#inspector` fixed bottom sheet (`inset-inline: 0; bottom: 0; z-index: 20`,
`border-top: 2px solid var(--nw-ink)`, hidden until `.open`) and the `.spark`
geometry. `scripts/test-report/generate.mjs` moves the inspector out of §8 to
after `</main>`, adds `openSheet`/`closeSheet` with a close button and Escape,
formats evidence ages, and renders 96×22 sparklines with a trailing dot from
real series — the verdict bar's green trend, the mutation seeds' floor series,
and the shelf's durable and lane trends — each guarded so a series with fewer
than two points prints "no history yet" instead of a line.

`scripts/test-report/report-verdict.mjs` adds `lastAt` to queue entries so the
age column has a source. `scripts/test-report/prepare-pages-site.mjs` has its
`ensureMainScopeBanner` splice retargeted from the `<p class="lede">` the new
page no longer emits to `<nav class="toc">`, falling back to
`<main class="page">` and then `<body>`; its early return is unchanged, and no
test pins the old splice point.

**Every section renders real evidence or an honest absence state; the nightly
honesty gate is unchanged.** Where the mockup shows a figure the repo cannot
prove, the page says so instead of inventing one: §6 is suite × budget over the
real registry because no flow-to-app map or declared platform axis exists, §5
omits the simulation interleaving numerics and names them in its `.why`, the
age column prints an em dash when evidence carries no timestamp, and the
masthead omits the slot link when CI supplies no slug. Grading, the twelve
states and the zero-grey exit-1 contract are untouched.

**Authored CSS layers stay hex-free and `var()`-resolvable; the rendered page
stays fully self-contained (`data:` URIs only, no external links).** The
mockup's Google Fonts `<link>` is deliberately not carried over — the faces stay
inlined from the sheet. A real render was scanned for both properties.

### W3 — the tests follow the structure, and get stricter doing it

**Test files evolved to the new structure with every #853 property preserved,
and the report package gates green (`test:ratchet:unit`, `typecheck`, `format`,
`lint:site-tokens`, `test:report:smoke`).** No assertion was deleted or loosened
to reach green; each was repointed at the same property in the new layout and
most came back stronger.

`scripts/test-report/generate-app-grids.test.mjs` pinned `class="metric
axis-declared"` and a regex requiring an en-dash glyph before the `#831`
citation badge. Both now match the state class and the cell's word together, so
a cell that keeps its tint and loses its text fails — something the old
class-only assertions could not catch.

`scripts/test-report/smoke.mjs` required two strings that lived on the deleted
hero: `unproven cells` and `unhandled errors`. The first is now pinned as the
verdict bar's grey stat, which counts the same `GREY_CELL_STATES` tally; the
second moved to the render that actually produces it, where label, count and
message are matched in one expression alongside the red verdict they should
drive. Both replacements were sabotage-checked — dropping the count or the
message fails them. A required entry may now be a `RegExp` where the shape of
the markup carries the meaning.

`scripts/test-report/generate-briefing.test.mjs` had a test named for the split
between briefing and detail shelf that measured a heading since promoted out of
the shelf, so it passed while checking nothing; it now anchors on the shelf's
own id. It also gains the test that pins the deliverable: the nine section ids
in document order, every one reachable from the sticky table of contents, and
`#inspector` outside `</main>` as the fixed sheet.

`scripts/test-report/report-theme.test.mjs` dropped its `--row` allowance. The
inline per-cell stagger is gone with the old animation, so the two
token-resolution tests were carrying an escape hatch that would have accepted a
`var(--row)` nothing declares — precisely the silent-drop failure that suite
exists to catch. The generated sheet is now the whole vocabulary.

## Decisions

- The mockup's bare token names collide with three product tokens already in
  the report sheet (`--line`, `--danger`, `--link`), so all nineteen rungs are
  uniformly prefixed `--nw-` rather than splitting the namespace.
- The `--st-*` status ramp from #853 stays in the sheet alongside the Night
  Watch rungs; `verifySheet` guards both.
- §6 renders **suite × budget**, not the mockup's app × platform. No flow-to-app
  registry exists and platform is a per-evidence-item property rather than a
  declared axis, so the mockup's grid could only have been filled by inventing
  one. The heading and `.why` name what is missing.
- §2/§3 keep the declaration alphabet (`owned` / `unowned` / `n/a`) on neutral
  tints instead of the mockup's green-and-amber assessment words. Those grids
  carry declared seat ownership, not evidence; painting them in the evidence
  palette would claim proof the cells do not hold.
- §7 is three ledgers over the real per-seed, per-target and per-engine rows
  rather than the mockup's five summary rows: no source computes a median
  mutation score, a seeded-orderings tally, or an honesty-budget row, and
  collapsing to summaries would have dropped data the report already shows.
- Consent verdicts read `green` / `no evidence` / `no owner` rather than the
  mockup's `holds` / `partial`. The cell reports what the adversary suite did
  tonight; `holds` would assert more than the evidence supports.
- The inspector's shadow is `color-mix(in oklab, var(--nw-ink) 14%, transparent)`
  rather than the mockup's `rgba(0,0,0,.08)`, so it reads in both themes.
- The masthead's immutable-slot link needs a new `TEST_REPORT_RUN_SLUG` env
  alongside the existing public URL; the slug is computed outside the generator
  and cannot be reconstructed from `generatedAt` on a re-run. Absent either, the
  link is omitted rather than guessed, and `.github/workflows/e2e.yml` must pass
  the slot slug for it to appear.
- The receipt-per-issue gate appeared to demand an attestation on the merged
  `receipts/issue-831-clear-four-app-interfaces.md`, which `doc-integrity`
  freezes as immutable. Neither rule had to give: the gate resolves its change
  set through `merge-base HEAD main`, and this clone's local `main` ref was
  twelve commits stale, so already-merged work (#831, #839, #853, #676) was
  being attributed to this branch. Fast-forwarding that ref restored the real
  change set. An auditor had by then examined #831 and found two substantive
  defects in merged main, recorded under `## Out of scope` rather than by
  editing a frozen receipt.

## Out of scope

- The live journey instrumentation the mockup's §6 assumes — a flow-to-app
  registry and a declared platform axis. Where no evidence source exists the
  page renders what is real (suite × budget) and names the gap; building the
  source is product work, not report work. (§4's consent ledger, by contrast,
  already had eight real layers behind it.)
- Two defects an auditor found in merged main while this branch's change set
  was misattributed to it, both outside this issue and neither repaired here:
  PR #832 (#831) deleted `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`
  without naming it in its receipt, while `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`
  and `QUALITY.md` still cite that suite as live coverage of native SQLite
  restart parity; the same change narrowed a suspended-surface assertion in
  `handler-reachability.test.ts` from `mobileSource` to `nativeCover`. Both
  belong to #831's surface, and its receipt is frozen by `doc-integrity`.

## Verification

```sh
bun run lint:site-tokens
bunx vitest run scripts/test-report/report-theme.test.mjs --config scripts/test-report/vitest.config.ts
bun run test:report:smoke
```

All three green after W1 (9/9 theme tests; smoke "ok", exit 0 — identical to
the pre-change baseline). After the line-cap compaction: `wc -l
scripts/site-tokens.mjs` → 624 (cap 625), `bun run lint:site-tokens` green,
`git diff scripts/test-report/report-tokens.css` empty against the
pre-compaction sheet, oxfmt and oxlint clean, theme tests 9/9 against a clean
checkout-index tree (the working tree carried a sibling slice's in-flight
edit at verification time).

## Audit

Fresh-context audit of the **W1 milestone change set only** — the four staged
files in `git diff --cached`, not the finished umbrella. It will be superseded
by a final-state audit before #862 closes; the unchecked Checklist rows are
W2–W4 work and were not judged. The working tree carried sibling slices'
in-flight edits at audit time (`generate.mjs`, `render-briefing.mjs`,
`report-verdict.mjs`, `history-point.mjs`, and a second unstaged layer on
`report-theme.mjs`), so every command below was re-run in a throwaway worktree
built from the index alone (`git write-tree` → `commit-tree` → detached
worktree, removed afterwards) and nothing unstaged is credited to W1.

**(1) `## What changed` describes the diff faithfully — PASS.** All four
staged files are accounted for and nothing is described that the diff does not
contain (`--numstat`: receipt +92/-0, `scripts/site-tokens.mjs` +129/-116,
`scripts/test-report/report-theme.mjs` +13/-0,
`scripts/test-report/report-tokens.css` +74/-0). `NIGHT_WATCH_RAMP` is one
`name light dark` text table read by a single named-group regex
(`NW_RUNG`/`nightWatchDecls`) and interpolated three times into the tail of
`REPORT_LAYER` — as described, and only into `reportSheet()`: the two site
sheets are absent from the diff and contain zero `--nw-` (`grep -c`).
The regenerated `report-tokens.css` hunk is `@@ -603,3 +603,77 @@` — purely
additive, no deletions — and carries 57 `--nw-` declarations, i.e. **19 rungs
× 3 blocks**: `:root` light, `@media (prefers-color-scheme: dark)
:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`. All 38
values were compared against the issue's inlined light and dark lists and
match rung-for-rung; the `--nw-` prefix and its stated reason
(`--line`/`--danger`/`--link` already in the sheet) are borne out.
The `verifySheet` hunk sits after the linked-face throw, as claimed. The
compaction narrative also holds: staged `wc -l scripts/site-tokens.mjs` is
**624** against `FILE_SIZE_LIMIT=625` in
`.governance/conf/governance-kit/foundation/repo-hygiene.conf`, which the diff
does not touch — the budget was not moved. Each named compaction move is
present (`faceBytes`, `settle`, `SITE_ROOTS`/`SITE_FILES` walked once,
`declaredProps`, the dissolved layer function). "The emitted sheets are
byte-identical" is confirmed indirectly but decisively: `bun run
lint:site-tokens` is green on the index tree, which is a byte compare of all
three emitted sheets against this emitter.

**(2) Every `- [x]` item is realized in the diff — PASS.** One item is
checked. "Palette declared in the generated report sheet for both themes" —
the `report-tokens.css` hunk above, both themes, dark spelled twice.
"`lint:site-tokens` green" — reproduced on the index tree (`site tokens: home
+ docs + the report match @centraid/design`, exit 0). "`verifySheet` refuses a
sheet missing it" — reproduced by probe against the staged module: the full
sheet is accepted; a sheet with the palette renamed away, a light-half-only
truncation, and a sheet with the dark rungs gutted are each refused with the
`declares no Night Watch palette` error. The Verification block's other claims
also reproduce on the index tree: theme tests **9/9**, `bun run
test:report:smoke` → `test report smoke: ok`, exit 0.

**(3) `## Checklist` mirrors the issue's acceptance criteria — PASS.** Issue
#862 was read live via the GitHub API. Its "## Acceptance criteria" list has
ten items; the receipt's Checklist has ten, and a normalized `diff` of the two
lists (collapsing the single `[x]` to `[ ]`) is empty — verbatim identical,
same order, no additions, no droppings, no rewording.

Two observations that do not refute the above, recorded rather than softened:
`verifySheet` keys on `--nw-ground:` alone, so a sheet declaring that one rung
in all three blocks while missing the other eighteen would pass — a sentinel
check, which is what the checklist row asks for, but it does not guard the
ramp's completeness the way `lint:site-tokens` byte-freshness does. And five
operator-visible strings in `site-tokens.mjs` were shortened by the compaction
(the two `facesInline` throws, the `--write` and success logs, the scanned-zero
error); the receipt names the compaction but not that its output text changed.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-24 | claude-code | 7a729e34-2c7f-5e19-b800-09a117655f2e |
