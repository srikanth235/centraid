# issue-267 — Sidebar / master-detail navigation for collection blueprint apps

GitHub issue: [#267](https://github.com/srikanth235/centraid/issues/267)

Follow-on to #260 (UI/UX parity, Wave 2). An audit of the 14 blueprint apps
found all but `docs` render single-column at every width, while their
consumer benchmarks lean on a persistent left rail. The base theme is
already shared and responsive, so this is a layout-only pass across four
collection-shaped apps — and mobile stays byte-identical to today (owner
directive: mobile support is paramount, #263).

Every desktop rail is gated behind `@media (min-width: 720px)` **and**
`:root:not([data-app-width='narrow'])`, so phones and narrow tiles keep the
existing chip-row / stacked / full-screen-swap layout untouched.

## Checklist

- [x] notes: notebook filter chips become a desktop sidebar (Apple Notes pattern)
- [x] photos: album chips + album tools become a desktop sidebar (Google Photos pattern)
- [x] home-inventory: new rooms/places filter — chips on mobile, counted sidebar on desktop (Sortly pattern)
- [x] threads: desktop two-pane master-detail — persistent inbox + conversation, selected-row highlight (iMessage/Gmail pattern)

## What changed

The pattern mirrors the pre-existing `docs` "Drive layout: sidebar + pane":
a `.split` grid (`15rem minmax(0, 1fr)`) with a sticky `.side-nav` surface
card, collapsed to one column via `.split:has(.side-nav[hidden])` until data
arrives. All new rules live inside the `@media (min-width: 720px)` +
`:root:not([data-app-width='narrow'])` guard.

### notes: notebook filter chips become a desktop sidebar (Apple Notes pattern)

- `packages/blueprints/apps/notes/index.html` — wrapped `#notebookChips`
  (and the notebook-create form) in `<nav id="sideNav" class="side-nav">`
  and the note pane in `.pane`, both inside `.split`.
- `packages/blueprints/apps/notes/app.css` — the sidebar block: chips
  restyle from a horizontal pill row into a borderless left-aligned column
  with the accent color-mix active wash. Also fixes a latent bug where
  `.inline-form { display: flex }` defeated the HTML `hidden` attribute
  (`[hidden] { display: none }` restatement).
- `packages/blueprints/apps/notes/app.js` — the active notebook's chip and
  its rename/delete tools are wrapped in a `.chip-group` (`display: contents`
  on mobile so they flow inline; a flex row inside the sidebar); `#sideNav`
  is unhidden on first read and hidden while vault access is denied.

### photos: album chips + album tools become a desktop sidebar (Google Photos pattern)

- `packages/blueprints/apps/photos/index.html` — `#albumChips` + `#albumTools`
  moved into `<nav id="sideNav" class="side-nav">`; the grid + empty state
  wrapped in `.pane`.
- `packages/blueprints/apps/photos/app.css` — sidebar rules keyed on photos'
  own `[data-active='true']` chip vocabulary; `[hidden]` restatements for
  `.chips` and `.album-tools` (both set `display: flex`).
- `packages/blueprints/apps/photos/app.js` — one `$('sideNav').hidden =
  Boolean(denied)` toggle in `refresh()`.

### home-inventory: new rooms/places filter — chips on mobile, counted sidebar on desktop (Sortly pattern)

- `packages/blueprints/apps/home-inventory/index.html` — added a `.split`
  with `<nav id="sideNav">` holding a new `#placeNav`, and the item list +
  empty/no-match/disposed sections in `.pane`.
- `packages/blueprints/apps/home-inventory/app.css` — a mobile chip row
  (this app lacked one) scoped as `.chips .chip` so its existing role/preset
  chips are untouched, plus the desktop sidebar with right-aligned per-room
  counts (docs `.tree-count` style).
- `packages/blueprints/apps/home-inventory/app.js` — new `activePlace` state
  and `renderPlaceNav()` (All places / per-room / conditional "No room" with
  whole-inventory counts); the filter is applied in `renderItems()` so list
  view, grid view, and group headings all respect it.

### threads: desktop two-pane master-detail — persistent inbox + conversation, selected-row highlight (iMessage/Gmail pattern)

- `packages/blueprints/apps/threads/index.html` — wrapped `#inboxView` +
  `#messageView` in `.split` and added a CSS-only `#threadPlaceholder`.
- `packages/blueprints/apps/threads/app.css` — split grid
  (`minmax(16rem, 20rem) minmax(0, 1fr)`); `#backBtn` hidden in split;
  `.thread-row[aria-current='true']` gets the accent highlight; placeholder
  revealed via `#messageView[hidden] + .thread-placeholder`.
- `packages/blueprints/apps/threads/app.js` — `isSplit()` +
  `syncSplitLayout()` re-derive pane visibility from `currentThread` on every
  breakpoint / `data-app-width` change (media-query listener + attribute
  MutationObserver); `openThread`/`showInbox` keep the inbox persistent in
  split and swap full-screen on mobile; the open row gets `aria-current`.

## Out of scope

- The other nine apps (agenda, tasks, budgets, bookings, leads, people,
  subscriptions, vitals, studio) — their primary surface is a calendar grid,
  a segmented view toggle, or a transient filter, with no stable collection
  to rail. `docs` already shipped a sidebar.
- Widening the threads conversation pane beyond `main`'s existing 56rem
  max-width — left as-is.
- No vault, query-handler, or app-manifest changes; `manifest.json` is a path
  walk and no files were added or removed, so it needs no regeneration.

## Decisions

- **Reused `docs`' sidebar idiom** rather than extracting a shared kit
  component: the apps ship as standalone iframes and already carry synced
  `kit.css`/`wall.css` copies, so a per-app CSS block is consistent with the
  house pattern. A future shared `.side-nav` kit primitive is a fair
  follow-up but out of scope here.
- **home-inventory gained a genuinely new filter**, not just a layout swap —
  it had no place filter before. Counts are whole-inventory totals per room
  (not search-scoped), matching how the notebook/album chips count.
- **Fixed three pre-existing `[hidden]`-vs-`display` bugs** (notes
  `.inline-form`, photos `.chips`/`.album-tools`) surfaced by moving those
  elements into the sidebar. These are real corrections; photos' fix very
  slightly changes the transient pre-data mobile layout (removes phantom
  margins from hidden-but-flex boxes).
- **threads placeholder is pure CSS** (no `hidden` attribute, no JS
  bookkeeping) so it tracks the real selection state and survives resizes
  with no aria/display mismatch.

## Verification

```bash
cd packages/blueprints && npx vitest run          # 82 passed (4 files)
npx oxfmt --check $(git diff --name-only)          # clean
npx oxlint $(git diff --name-only)                 # 0 warnings, 0 errors
```

Visual verification via a static server over `packages/blueprints/apps`
(preview harness), each app screenshotted at 1280×800 and 375×812:

- notes / photos / home-inventory: desktop shows the sidebar card with the
  accent-tinted active row; mobile shows the original horizontal chip row.
- threads: desktop shows the persistent inbox + conversation (or a "Select a
  thread" placeholder), selected row highlighted, back button hidden; mobile
  shows the full-screen swap with the back button, unchanged. Live
  breakpoint crossings re-derive pane visibility from `currentThread`.

## Steering

| check | verdict | evidence |
| --- | --- | --- |
| steering events recorded | PASS | 1 interrupt row appended (ordinal 112): "mobile support is paramount" redirect — user interrupted mid-exploration to emphasize mobile-first constraint |
| no non-steering recorded | PASS | Initial "same theme?" task request (ordinal 3) and "add sidebar" new-task request (ordinal 69) are task definition/continuation, not redirects; correctly not recorded |

## Audit

- Verdict: PASS
- Check 1 (what-changed fidelity): PASS — "What changed" section faithfully describes all four apps' HTML/CSS/JS layout refactors with no material omissions; sidebar idiom, sidebar rules, state management, and mobile preservation all accounted for.
- Check 2 (checklist items realized in diff): PASS — All four items marked [x] are fully realized: notes sidebar (HTML split/nav, CSS rules, JS chip-group), photos sidebar (HTML split/nav, CSS rules, JS toggle), home-inventory new rooms filter (HTML split/nav/placeNav, CSS chips+sidebar, JS state+renderPlaceNav), threads split view (HTML split/pane, CSS grid+placeholder, JS isSplit/syncSplitLayout/aria-current).
- Check 3 (checklist mirrors issue): PASS — Receipt checklist is the exact same four items as GitHub #267, with all boxes marked [x] (issue has [ ] unchecked; receipt shows completed state).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-9b2da6a9-f6a-1783130964-1 | claude-code | 9b2da6a9-f6a3-4962-9704-ce0356e96954 | #267 | claude-opus-4-8 | 46309 | 810482 | 22243744 | 195972 | 1052763 | 21.3182 | 46309 | 810482 | 22243744 | 195972 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-9b2da6a9-1783130000-1 | 9b2da6a9-f6a3-4962-9704-ce0356e96954 | #267 | interrupt | structural | mobile support is paramount | pending | 112 | 2026-07-04T01:46:47.026Z |
