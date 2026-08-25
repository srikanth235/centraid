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
- [x] `docs/design-divergences.md` and `docs/decisions.md` updated; superseded bespoke dimensions recorded
- [x] Receipt `receipts/issue-862-nightly-report-night-watch.md` complete with independent `## Audit`
- [x] Both-theme rendered screenshots compared against the mockup before push

## What changed

### W1 — the Night Watch palette enters the sheet

`scripts/site-tokens.mjs` gains a `NIGHT_WATCH_RAMP` table — one row per rung
carrying name, light value, dark value, so the three theme blocks cannot drift
from each other — and appends the lowered layer to the report sheet only; the
two public-site sheets are untouched. `scripts/test-report/report-tokens.css`
is regenerated — additive when the palette lands, and by the end of the branch
+78/−6, the six deletions being comment lines W5 rewrote — and declares the
nineteen rungs three
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

`scripts/test-report/report-state-words.test.mjs` is new, and closes the gap
the register's two collapses depend on. The theme suite proves the twelve
states keep distinct treatments and lets two pairs share one deliberately —
`infra-mismatch` rides `failed`'s tone, `lane-did-not-run` is the same absence
as `stale` — with the word as the only tell. Nothing asserted a cell emits its
word at all, so cells could have shipped blank or transposed with every gate
green. One real nightly-scoped render reaches all twelve states; the literal
words are pinned so a transposition fails and not merely an empty one, the
`aria-label` must name the same word the eye sees, and the two collapsed pairs
must differ. Stubbing `stateWord` to a constant fails three of the four tests,
and swapping two words fails the first.

`scripts/test-report/report-theme.test.mjs` dropped its `--row` allowance. The
inline per-cell stagger is gone with the old animation, so the two
token-resolution tests were carrying an escape hatch that would have accepted a
`var(--row)` nothing declares — precisely the silent-drop failure that suite
exists to catch. The generated sheet is now the whole vocabulary.

### W4 — the docs describe the page that ships

**`docs/design-divergences.md` and `docs/decisions.md` updated; superseded
bespoke dimensions recorded.** The register's "nightly test report" section
grows from five rows to eleven. The row describing eight states as a recessed
trough and four as a fill is replaced by the cell register, marked as
superseding #853's treatment: the argument for why a heat map may depart from
DESIGN.md survives and gets stronger, since a tint behind a word is further
from a fill than the trough was. Eight rows are new. Seven name a departure a
future agent might otherwise "fix" by mistake — the `--nw-` palette and why the
prefix is forced, §2/§3's declaration alphabet on neutral rungs, §6 as suite ×
budget, §5's absent simulation numerics, §7 as three per-row ledgers, the
ledgers' second verdict vocabulary, and the inspector taking neither the Sheet
recipe's ground nor a `--shadow-*` rung.

The eighth is a debt this pass created and leaves **Open**: twenty-three of the
twenty-eight `--st-*` status rungs are still emitted and are now painted by
nothing, the cell register having replaced the fills that used them. They are
not deleted here, because `--st-solid` is `verifySheet`'s wholeness marker and
because retiring a rung from the emitter is a decision about the ramp rather
than about this page's layout. The row says both: do not delete them, and do not
re-point cells at them.

The open `lint:design-tokens` row keeps its verdict and loses its stale reason.
The 40px cell, 98px header band and 230px surface column it cited are gone with
the old layout. Measured against the same metrics the gate uses, the report's
whole residue is now 34 raw font sizes across ten literal steps (26px down to
10px, below the shell's smallest rung), and the gate walks `.css` files while
`REPORT_CSS` lives in a `.mjs` template literal it cannot see. The row stays
open; no budget was widened.

`docs/decisions.md` gains a dated ruling for 2026-08-24 in the file's existing
voice, and a row in its superseded-pointers table retiring #853's fill-and-
trough register. The ruling records the bounded reopening of #853's "no palette
and no scale of its own" — a page read at a glance in ink that bottoms out at
10px needs tones and steps the shell has no rung for — with the non-goal that no
`--nw-*` rung appears on any other surface, and it generalises the honesty rule
from the matrix to every section.

### W6 — the receipt is audited, and repaired where it was wrong

Receipt `receipts/issue-862-nightly-report-night-watch.md` complete with
independent `## Audit`: a fresh-context auditor read the whole branch against
this receipt and issue #862, and **refuted** the faithfulness check. Its three
findings are repaired above rather than argued with — `grey`'s prior contrast
was 2.06:1 light and 2.17:1 dark, not the single 2.19:1 figure claimed; the
register gained eight rows, not the six claimed against a list of seven; and
the emitted sheet is +78/−6 across the branch rather than purely additive. The
two gaps it named — the unregistered `--st-*` surplus and the uncommitted CI
wiring for the slot link — are now carried in `## Decisions` and
`## Out of scope`.

### W5 — the palette clears AA, which the mockup did not

The mockup's `ghost` rung measured 3.49:1 light and 3.30:1 dark against the page
ground, below the 4.5:1 WCAG AA floor for text — and it is not decorative: it
inks the `n/a` cell word, the footer, the section tags, the severity labels and
the skipped result. `grey` was 2.06:1 light and 2.17:1 dark. Two rungs moved in
`NIGHT_WATCH_RAMP`,
the only place these literals live: `ghost` to `#757572` light and `#7B7B79`
dark, `grey` to `#8B8A87` and `#666664`. Every other rung is untouched, and the
sheet was regenerated from the table rather than edited.

Recomputed over the shipped values, every pair carrying text clears AA in both
themes — ink 18.10/16.48, ink2 6.79/6.85, ink3 5.18/5.36, ghost 4.54/4.55, link
7.69/9.10, and the four word-on-tint pairs 5.46/6.44 (ok), 4.88/6.26 (attn),
5.92/6.64 (danger), 4.63/4.84 (grey cell). `grey` sits at 3.39/3.35, which is
the right floor for what it actually draws: a dashed rule and two dots, no text.

`scripts/site-tokens.mjs`'s comments described a fill under ink on the matrix
cell and counted eleven states. The page paints no fill and there are twelve;
both are corrected, and the file stays at 624 lines against the 625 cap.

## Decisions

- The mockup's bare token names collide with three product tokens already in
  the report sheet (`--line`, `--danger`, `--link`), so all nineteen rungs are
  uniformly prefixed `--nw-` rather than splitting the namespace.
- The `--st-*` status ramp from #853 stays in the sheet alongside the Night
  Watch rungs, and `verifySheet` guards both — but the cell register replaced
  the fills that used it, so twenty-three of its twenty-eight rungs are now
  emitted and painted by nothing. They are kept rather than retired in this
  pass: `--st-solid` is the sheet's wholeness marker, and thinning the ramp is a
  decision about the ramp, not about this page's layout. Registered Open in
  `docs/design-divergences.md`.
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
- Two palette rungs deliberately depart from the mockup's values. `ghost` and
  `grey` as drawn there fail WCAG AA against the page ground while inking real
  text, and matching a reference exactly is not worth shipping text a reader
  cannot read. The hues are kept; only the lightness moved, and only far enough
  to clear the floor.
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
- Wiring the masthead's immutable-slot link in CI. The link renders only when
  `TEST_REPORT_RUN_SLUG` and `TEST_REPORT_PUBLIC_URL` both reach the generator,
  and today neither does: no workflow sets the slug, and the public URL reaches
  only `write-job-summary.mjs`. The generator omits the link rather than
  guessing, so the page is honest as it stands; `.github/workflows/e2e.yml` must
  pass `steps.slot.outputs.slug` for the link to appear, and that workflow is
  deliberately not in this change set. The mockup's separate "history" link is
  not rendered at all, for the same reason.
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

The whole report lane and the push gate:

```sh
bunx vitest run --config scripts/test-report/vitest.config.ts
bun run test:ratchet:unit
bun run check:push
```

436 tests over 30 files, none failing; coverage 53.48 / 49.27 / 53.64 / 54.45
against floors of 35 / 30 / 30 / 35, no floor moved. `check:push` clears 46 of
its 47 gates. The one failure is `design:gallery`, which dies at
`chromium.launch` — the sandbox provides `chromium_headless_shell-1194` while
this Playwright expects `-1234`. It is an environment gap, not a defect in the
diff: `scripts/design-gallery.mjs` is not in the change set, the failure
precedes any page load, and the environment's own guidance is not to install
browsers over the preinstalled set. CI runs the same gate with matching
browsers.

**Both-theme rendered screenshots compared against the mockup before push.**
The page was generated and opened in Chromium at 1180px under each colour
scheme. Light ground `rgb(253, 253, 252)` on ink `rgb(20, 20, 20)`, dark
`rgb(14, 14, 14)` on `rgb(237, 237, 236)`, Instrument Sans resolving in both;
`h1` "Night watch" at 26px; section ids in document order `queue, product,
states, consent, joins, journeys, adv, infra, shelf`; `#inspector` computing to
`position: fixed`; `scrollWidth` equal to `clientWidth`, so nothing overflows
horizontally. Against the mockup the masthead, verdict bar, sticky index,
`§`-tagged headings with their rationale lines, and the queue's chip/owner/age/
action columns all match. The render carried no evidence artifacts, so every
cell is honestly grey and the delta reads "first recorded night".

## Audit

Fresh-context audit of the **complete branch** — all five commits in
`origin/main...HEAD` plus the staged receipt edit in `git diff --cached`. It
supersedes the W1-milestone audit that stood here, which judged four staged
files and one checklist row and explicitly deferred the rest. Every command
below was run against the working tree as it stands (clean but for the staged
receipt); the two sabotage probes edited `generate.mjs` in place and restored
it from a byte copy, and `git status` is unchanged by this audit.

**(1) `## What changed` describes the diff faithfully — REFUTED.** The section
is accurate almost everywhere, and three statements in it are not.

*The wrong figure.* W5 says the mockup's `grey` rung "was 2.19:1". Recomputing
WCAG 2.x contrast over the values commit `1db07dff` actually replaced —
`#B4B3B0` light, `#4A4A48` dark — gives **2.06:1** light and **2.17:1** dark
against `--nw-ground`. No pairing of `grey` with any rung the page declares
(`ground`, `greybg`, `surf`, `sunken`, either theme) yields 2.19. The argument
is unaffected — both figures are far under the 3:1 mark rung floor — but the
number as written is reproducible from nothing.

*The undercount, and the row nobody described.* W4 says the register's
"nightly test report" section "grows from five rows to eleven" (true: 5 → 11)
and that "**Six** rows are new" — then enumerates **seven** (`--nw-` palette,
the §2/§3 declaration alphabet, §6, §5, §7, the ledgers' second verdict
vocabulary, the inspector). The diff adds **eight** new rows plus the one
replacement it names. The eighth — "Twenty-three of the twenty-eight `--st-*`
status rungs are declared by the emitter and painted by nothing", verdict
**Open**, do not delete and do not re-point — appears nowhere in the receipt.
It is the most consequential row added: a standing debt this pass created by
taking the fills off the cells, and the Decisions bullet that comes closest
("the `--st-*` status ramp from #853 stays in the sheet") records the opposite
emphasis — that the ramp survives, not that five of its twenty-eight rungs are
all that still paint. Verified: the authored layers reference exactly
`--st-solid-text`, `--st-failed-text`, `--st-flaky-text`, `--st-na-text` and
`--st-absent-text` (four in `BRIEFING_CSS`, one in `prepare-pages-site.mjs`),
against 28 `--st-` declarations in the sheet.

*The stale adjective.* W1 calls the regenerated `report-tokens.css` "purely
additive". It was, at the W1 milestone. Across the branch the file is
**+78/−6**: the W5 comment corrections in the emitter rewrote six comment lines
inside the emitted sheet. True then, not true of the change set this receipt
now describes.

Everything else in the section reproduces. All sixteen files in `--numstat` are
accounted for and nothing is described that the diff does not contain. The
whole W5 contrast table was recomputed from `NIGHT_WATCH_RAMP` and matches to
the digit — ink 18.10/16.48, ink2 6.79/6.85, ink3 5.18/5.36, ghost 4.54/4.55,
link 7.69/9.10, ok-on-okbg 5.46/6.44, attn 4.88/6.26, danger 5.92/6.64, ink3
on greybg 4.63/4.84, grey 3.39/3.35 — as do the mockup's 3.49/3.30 for `ghost`
and the claim that only those two rungs moved (a rung-for-rung compare against
the issue's inlined lists shows `ghost` and `grey` differing and the other
seventeen identical, in both themes). The `--nw-grey` "no text" justification
holds: its three call sites are `.quality-light`'s 9px dot, `.dot`'s 7px dot
and border, and `.cell.expected-grey`'s 1px dashed rule — no text, so 3:1 is
the right bar. `624` lines against `FILE_SIZE_LIMIT=625` in
`.governance/conf/governance-kit/foundation/repo-hygiene.conf`, which the diff
does not touch. The ledger column templates match the issue's contract byte for
byte (queue `84px 1fr 190px 70px 120px`, consent `170px 1fr 150px 110px 90px`,
joins `240px 1fr 120px 90px`, adversaries `200px 90px 90px 110px 1fr`), and the
eight consent layers and ten join laws are the real registry counts.
`BRIEFING_CSS` is five rules. The "34 raw font sizes across ten literal steps
(26px down to 10px)" is exact: 34 `font-size` literals, steps 26/17/15/14/13/
12/11.5/11/10.5/10.

Every `## Verification` number reproduces: `bunx vitest run --config
scripts/test-report/vitest.config.ts` → **436 tests over 30 files, 0 failing**;
`bun run test:ratchet:unit` → **53.48 / 49.27 / 53.64 / 54.45** against the
thresholds `35 / 30 / 30 / 35` declared in `scripts/test-report/vitest.config.ts`,
a file outside the change set; `bun run lint:site-tokens` and `bun run
test:report:smoke` green. `check:push` does list **47** gates. The
`design:gallery` explanation is confirmed rather than taken on faith:
`playwright-core@1.62.0`'s `browsers.json` pins chromium revision **1234** and
the sandbox carries only `/opt/pw-browsers/chromium_headless_shell-1194`.

**(2) Every `- [x]` item is realized in the diff — PASS.** Nine rows are
checked; the tenth (this audit) is honestly left open. Each was attacked
rather than read.

- *Palette / `lint:site-tokens` / `verifySheet`* — the sheet carries **57**
  `--nw-` declarations, 19 rungs × 3 blocks (`:root`, the
  `prefers-color-scheme` block, `[data-theme="dark"]`); no other sheet in the
  tree contains `--nw-`, so the ruling's non-goal holds; `verifySheet` throws on
  a missing or light-only palette, after the linked-face throw.
- *Running order* — a real render (`node scripts/test-report/generate.mjs`)
  emits `<h2 id>` in exactly `queue, product, states, consent, joins, journeys,
  adv, infra, shelf`, each reachable from `nav.toc`, `<main class="page">`,
  `<footer class="foot">`, and `<div id="inspector">` after `</main>`.
- *Twelve states, two collapses* — the register gives ten pairwise-distinct
  treatments; inside a family the states separate by weight, slope or the
  dashed rule. The word claim was sabotage-tested, not read: stubbing
  `stateWord` to a constant fails **3 of 4** tests in
  `report-state-words.test.mjs` (the aria test survives, since the label reads
  the same stub — exactly as the receipt says), and transposing `gap`/`stale`
  fails **the first only**. Both claims are literally true.
- *Geometry* — queue, four ledgers, journeys, the fixed sheet
  (`position: fixed` confirmed in a browser) and 96×22 sparklines with a
  trailing dot, stroke and dot taken from `.spark` rules rather than SVG
  presentation attributes.
- *Honesty gate unchanged* — the nightly `cellsMissing > 0` exit-1 block is
  untouched by the diff; the only edit near the banner is the hero's deletion.
- *Self-contained* — measured on a real 793 KB render, not on the `<style>`
  block alone: **0** `<link>`, **0** `<script src>`, **0** non-`data:` `url()`,
  no `googleapis`. The only absolute hrefs are GitHub issue links, which are
  hyperlinks and not resource loads. All **33** `var()` names in the authored
  layers resolve against the sheet; both layers carry zero six-digit hex.
- *Gates green* — reproduced here: `format:check`, `lint`, `knip`,
  `test:ratchet:unit`, `test:report:smoke`, `lint:site-tokens`, `lint:css`,
  `lint:design-tokens`, `lint:hairline`, `lint:motion-rule`, `lint:type-floor`,
  `lint:aria-labels`, `lint:logical-insets`, `lint:container-opacity`,
  `test:hygiene-ratchet`, `lint:design-md`, `typecheck:affected`.
- *Screenshots* — every measurement in the closing paragraph was reproduced by
  driving the available headless shell over the rendered page at 1180px: light
  `rgb(253, 253, 252)` on `rgb(20, 20, 20)`, dark `rgb(14, 14, 14)` on
  `rgb(237, 237, 236)`, Instrument Sans first in the resolved stack, `h1` 26px
  "Night watch", `#inspector` `fixed`, `nav.toc` `sticky`, `scrollWidth` 1180 =
  `clientWidth` in both themes.

**No gate, budget, floor, allowlist or test was weakened.** The change set
touches no configuration file at all — not the vitest thresholds, not
`repo-hygiene.conf`, not an oxlint or knip config, not the `check:push` gate
list. Every assertion the restructure displaced came back stronger and was
verified as such: the two app-grid checks now pin class **and** word together,
smoke's two hero strings became regexes pinning count beside label, the
briefing's shelf test was measuring a heading that had moved out of the shelf
and now anchors on `id="shelf"`, and `report-theme.test.mjs` **dropped** its
`--row` escape hatch rather than gaining one. `report-state-words.test.mjs` is
282 lines of new property nothing previously held. The line cap was met by
compacting the emitter to 624, not by raising 625; the divergence register
gained an **Open** debt row rather than losing one. This is the opposite of
going green by policy.

**(3) `## Checklist` mirrors the issue's acceptance criteria — PASS.** Issue
#862 was read live through the GitHub API. Its "## Acceptance criteria" list
has ten items; the receipt's Checklist has ten; a normalized `diff` of the two
(collapsing every box to `[ ]`) is empty — verbatim, same order, nothing added,
dropped or reworded.

Three things judged questionable and left standing rather than softened. The
masthead cannot render the design contract's **immutable-slot** link as CI is
wired today: `TEST_REPORT_RUN_SLUG` is set in no workflow, and
`TEST_REPORT_PUBLIC_URL` is passed only to `write-job-summary.mjs`, never to the
generate step — the Decisions bullet says the workflow "must pass the slot slug
for it to appear", but `.github/workflows/e2e.yml` is not in the change set and
the gap is recorded under Decisions rather than under `## Out of scope`, where
the issue asks for it. The contract's **history** link is likewise absent from
`.runmeta`; the receipt never claims it, so this refutes nothing, but the
masthead is one element short of the design it is measured against. And
`verifySheet` still keys on `--nw-ground:` alone, so a sheet declaring that one
rung in all three blocks while missing the other eighteen would pass it — a
sentinel, which is what the checklist row asks for, with `lint:site-tokens`
byte-freshness carrying the ramp's completeness.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-24 | claude-code | 7a729e34-2c7f-5e19-b800-09a117655f2e |
