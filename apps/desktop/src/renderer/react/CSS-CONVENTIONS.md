# Desktop renderer CSS conventions

Status: **modularization complete** (issue #325, R6/M5+M6). There is no more
vanilla renderer — R5 deleted every `.ts` CSS-emitting file, so the old
"shared with a vanilla host" rationale for keeping a class global no longer
applies to anything. Every class that is safely scopable (owned by exactly one
surface, or shared by React files that can agree on one module) has been
carved out of the monolithic `src/renderer/styles.css` into co-located or
shared CSS Modules. The file went from ~14,788 lines (pre-R1) to ~2,120. What
remains is a small, permanent global layer: reset/tokens/base, the two design-
sync primitive families, the window-chrome family, and a deliberate atomic
utility layer (see "What stays global" below) — not a migration backlog. This
doc is the north star for **all new work** — new screens author a co-located
`*.module.css`, never grow the monolith.

M6 (same issue, after M5 was first declared "done") found and closed a real
gap: the classifier script used to audit this file (`full.mjs`, kept outside
the repo) had a hardcoded prefix whitelist that silently skipped ~90 classes
all migration long — a `ctx-*` context-menu family, a `msg-*`/`chat-scroll`/
`pulse` chat-bubble family shared by the two chat surfaces, `drawer-group*`,
`right-pane`, `preview-toast*`, `ap-preview*`, `app-view-frame`/`-fullbleed`,
`btn-danger`, `sheet-actions`, and a batch of genuinely dead rules (orphaned
`app-topbar`, `cd-sb-icon`/`cd-sb-dot`, `hide`, `empty-art`, `journal-list-
item`, `share-access-row`, `tap-circle.sm`, `app-tile-add .app-icon` —
selectors that survived earlier dead-sweeps only because they were entangled
with a *different*, still-live class in the same rule). The classifier is
fixed now (no whitelist) — running it again turns up nothing but the
documented global families below and known noise (comment prose, dynamically-
built class names like `` `cd-btn-${variant}` ``, and an e2e-only consumer
outside the renderer tree).

## The four layers

1. **Tokens — `@centraid/design-tokens`.** CSS custom properties (`var(--accent)`,
   `var(--ink)`, `var(--line)`, `var(--font-mono)`, radii, spacing). The single
   cross-platform contract, shared with mobile. **Never** hard-code a hex,
   px-radius, or font stack a token already covers.

2. **Global base — `styles.css`.** Reset, `:root` token wiring, base element
   defaults, and the two families that legitimately stay global forever (see
   "What stays global"). This file is **frozen and small**: it is not where new
   component styles go. (It is still served as a blocking `<link>` and copied
   verbatim by the claude.ai/design sync.)

3. **Component/screen modules — `*.module.css`, co-located.** Each screen/
   component owns a `Foo.module.css` next to `Foo.tsx`. Classes are scoped by
   Vite CSS Modules (`vite.config.ts` → readable `[name]__[local]__[hash]`).
   Author local names in `camelCase` (`.stageBg`, `.rowLabel`); reference them
   `styles.stageBg`. This is where essentially all new styling goes.

4. **Reuse = components, not shared classes.** Do **not** reach for a shared
   global class to reuse a look — share a React component (`<Button>`, `<Icon>`,
   `<AppCard>` in `react/ui/`). A class shared across screens is a smell; promote
   it to a component or a shared module (see below).

## The one rule that keeps it clean

**No component reaches into another's internals.** The old monolith is full of
cross-surface combinators like `.cd-tl-main .cd-btn` (the shell titlebar styling
a button). Don't add new ones. If surface A must affect element B, pass a prop
or a `data-*` attribute that B owns — never a descendant selector across the
boundary. (Existing cross-boundary combinators inside the chrome family are why
`ShellFrame`/`Sidebar` stay entirely global — see "What stays global" below.)

## How to author a new screen's CSS

Onboarding, Palette, and Insights (and every screen listed below) are worked
examples (commits on `main`).

1. **Classify the screen's classes.** A class is **private** iff it's used only
   by that one `.tsx`/`.ts` and no CSS rule mixes it with a class owned
   elsewhere (i.e. it's "rooted" — the first class in at least one selector's
   comma-group). A class used by ≥2 React files is **shared** — put it in one
   `react/styles/<name>.module.css` all consumers import (see `vault.module.css`,
   `toolGroup.module.css`, `automation.module.css` for the pattern), never
   duplicated per-file and never left as a bare global string. A class that's
   only ever reached as a descendant of a foreign root (e.g. `.tool-group
   .tg-row-clickable`) can't be scoped without moving the foreign-rooted rule
   too — either co-locate both ends into one shared module (the `toolGroup`
   fix), or leave it global if the foreign root is chrome/design-sync (below).
2. **Lift the rules** out of `styles.css` into `Foo.module.css`, renaming
   `.cd-foo-bar` → `.fooBar` (camelCase; strip the family prefix unless two
   prefixes in the same file collide on the stripped name, e.g. `chat-body` /
   `thinking-body` both → `body` — then use full-name camelCase for that file's
   whole scope set). Keyframes move too — Vite scopes `animation-name`
   references inside a module even when the keyframe is defined elsewhere, so
   any module animating with a shared keyframe (`cd-pulse`/`cd-spin`) needs a
   **local copy** of that `@keyframes` block; the global copy stays in
   `styles.css` for other consumers.
3. **Rewrite the source:** `className="cd-foo-bar"` → `className={styles.fooBar}`;
   multi-class → `className={cx(styles.a, styles.b)}`; a **shared** global class
   stays a plain string, so a mixed element is `cx(styles.priv, 'cd-shared')`.
   `.ts` string-builders (`el.className = '...'`, template-literal HTML) follow
   the same rule — `styles.x` types as `string | undefined` under
   `noUncheckedIndexedAccess`, so a bare direct assignment needs `?? ''`
   (`cx(...)` already returns `string`, no coercion needed).
4. **Foreign class you're keeping global, reached from a scoped rule**
   (`.cd-app-settings-pane .cd-swatch`): in the module write
   `.pane :global(.cd-swatch) { … }` — the `:global()` escape hatch keeps the
   foreign class un-scoped while the rule that reaches it still moves.
5. **Tests:** class-based selectors use the **local** name (`.fooBar`); Vitest's
   `classNameStrategy: 'non-scoped'` (in `vitest.config.ts`) makes
   `styles.fooBar === 'fooBar'`, so `.fooBar` selectors and `toContain('fooBar')`
   both match.
6. **Verify:** `bun run typecheck` (both graphs) + `bun run test` (in
   `apps/desktop`) + `bun run build` + `oxlint src/renderer/react`. Also run an
   integrity check before committing — confirm no class your module claims is
   still bare-referenced by a *live* selector in `styles.css` (a comment
   mentioning the old name is fine; an actual `.foo {}` or combinator rule means
   you stranded it and it needs to stay global, or its foreign-rooted rule needs
   to move with it into a shared module). There's no live-Electron visual check
   in CI — eyeball every diff, since a class silently losing its rule (or a
   module-write tool clobbering pre-existing content instead of appending) is
   invisible to typecheck/tests/build.

## What stays global, and why

Three families are **permanently** global — do not attempt to scope these,
they are not migration debt:

- **Design-sync primitives.** `cd-app-card*`, `cd-btn*`, `cd-status`,
  `cd-status-dot`, `cd-disc-badge` — rendered by the shared `ui/AppCard.tsx` and
  `ui/Button.tsx` components. The claude.ai/design bundle ships `styles.css`
  verbatim and expects these classes to exist globally under exactly these
  names; scoping them would desync the design-sync bundle from the app. Some
  of these (e.g. `cd-btn-ghost`/`cd-btn-soft`/`cd-btn-danger`) are built as a
  template literal (`` `cd-btn-${variant}` `` in `ui/Button.tsx`), so a plain
  grep for the literal string won't find the consumer — check the component,
  not just the source text, before assuming one of these is dead.
- **Window/shell chrome.** `cd-window*`, `cd-sidebar*`, `cd-sb-*` (`Sidebar.tsx`),
  `cd-tl-*`/`cd-main`/`cd-traffic-lights-spacer` (`ShellFrame.tsx`), `cd-tb-btn*`,
  `cd-tooltip`, `cd-kbd`, `chip` — `ShellFrame.tsx` and `Sidebar.tsx` are densely
  cross-combinated with each other and with per-screen content (e.g.
  `.cd-window[data-sidebar='closed'] .cd-tl-side`,
  `.cd-app-card-wrap:hover .cd-card-more`); scoping either file strands classes
  the other reaches into. Confirmed via a reverted attempt (10 stranded
  classes) — this is the one part of the shell intentionally left as the old
  global-string style, forever.
- **The atomic utility layer.** `btn`/`btn-primary`/`btn-ghost`/`btn-icon`/
  `btn-soft`, `flex`/`row`/`col`/`center`/`between`, `textarea`/`label`/`input`,
  `hint`/`muted`/`tiny`/`spacer`/`card`/`chip`/`empty`/`empty-art` — each reused
  by 3–15+ files as a one- or two-word rule (`.flex { display: flex }`). Rule
  #4 above ("reuse = components, not shared classes") is about *look-alike UI*,
  not these — scoping a 2-line atomic rule means either duplicating it into
  every consumer's module or funneling everything through one shared
  `utilities.module.css`, which is just relocating the global layer, not
  eliminating it. Left global on purpose, the same call most CSS-Modules
  codebases make for a small utility layer. `tiny-btn` and `right-pane-content`
  are the same call for a different reason — each is foreign-rooted under a
  combinator owned by an unrelated family (`preview-toast-action`, `has-phone`)
  and isn't worth detangling for one selector.

Everything else — every per-screen private family and every cross-screen
shared family that isn't one of the three above — has been carved into a
module. A `full.mjs`-style classifier (defined-in-`styles.css` ×
referenced-by, **no prefix whitelist** — see the M6 pitfall below) run against
the current tree should turn up nothing but: these three families, and noise —
comment prose that happens to contain a class-shaped word (`.empty-art` inside
a doc sentence is not a live selector), and a consumer outside the scanned
tree (`tile-more-btn` is real, asserted on by a Playwright e2e flow under
`tests/agent-e2e/`, invisible to a classifier that only scans `src/renderer`).

### Tooling pitfalls hit during the carve (worth knowing before automating this again)

- **A class can be "rooted" (owns a rule) and *also* reached from a foreign
  combinator elsewhere** (`.cd-tl-side { … }` plus
  `.cd-window[data-sidebar='closed'] .cd-tl-side { … }`). A naive
  private-class check that only looks for "is this the first class in *some*
  selector" will misclassify it as safely scopable. The fix is a **fixpoint**:
  carve, then check whether any moved class is still referenced by a *kept*
  rule; if so, exclude it and reprocess, until nothing is left stranded.
- **A module-carve tool must *append* to an existing `.module.css`, never
  overwrite it.** A screen migrated in an earlier pass may already have a
  module with unrelated content; a tool that blindly `writeFileSync`s the
  newly-carved rules (especially when that set is empty, e.g. every candidate
  got fixpoint-excluded) silently wipes the file to empty. Always read-merge
  the CSS text and the `class → local-name` map with what's already there.
- **A classifier that only evaluates a hardcoded prefix whitelist will miss
  real families.** M5 declared this migration done using a classifier whose
  loop started `if (!/^(cd-|app-chat-|.../.test(c)) continue;` — anything
  outside that prefix list (`ctx-*`, `msg-*`, `drawer-group*`, `right-pane`,
  `preview-toast*`, `ap-preview*`, `sheet-actions`, `btn-danger`, …) was never
  evaluated for scoping, all migration long, without erroring or warning. M6
  found this by re-running the classifier with the filter removed. Evaluate
  every defined class; let real noise (comment prose, dead orphaned rules,
  dynamically-built names) show up as an empty ref set or a doc-only hit, not
  as a skip before it's even checked.
- **`ruleDead`/dead-sweep checks must look at the *whole* selector, not just
  the candidate class.** A combinator rule like `.journal-list-item .date {}`
  has two class tokens; if only `journal-list-item` is dead but `date` is a
  live class elsewhere, an all-classes-must-be-dead check correctly refuses to
  delete the rule — which is right for `date`, but leaves the truly-orphaned
  `journal-list-item` half of it stranded forever. These need a manual pass:
  find rules where the *first* class is confirmed dead even if a later class
  in the same selector is a live class from an unrelated family, and delete
  just those rules.

## Serving + design-sync

Component modules are bundled by Vite into `dist/renderer/react-boot.css`, linked
blocking in `index.html` ahead of the module scripts (no FOUC).

The claude.ai/design desktop-shell sync (`.design-sync/desktop-src/`) ships only
the four **`ui/` primitives** (`Icon`/`Button`/`Logo`/`AppCard`) plus
`styles.css`. Those primitives render the **design-sync global classes**
(`cd-btn*`, `cd-app-card*`, `cd-status*`, `cd-disc-badge`) described above, which
stay in `styles.css` — so the design bundle remains complete with `styles.css`
alone. **No `react-boot.css` re-plumb is needed** (the module CSS is for the
app's own screens, which the design bundle does not ship). The only follow-up
is an optional content refresh — re-uploading the (now much smaller)
`styles.css` so the design bundle reflects the full modularization — a
`/design-sync` step run interactively (it needs OAuth).
