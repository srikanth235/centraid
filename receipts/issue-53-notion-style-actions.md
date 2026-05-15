# issue-53 — Notion-style action menus for apps and templates

GitHub issue: [#53](https://github.com/srikanth235/centraid/issues/53)

## Checklist

- [x] Hover/focus-revealed `•••` button on app cards (home grid)
- [x] Hover/focus-revealed `•••` button on template cards (home grid)
- [x] Hover/focus-revealed `•••` button on sidebar app + draft rows (home and builder)
- [x] Right-click on cards and sidebar rows opens the same menu (cursor-anchored)
- [x] App menu gains Rename (inline contenteditable) and Reveal in Finder
- [x] Template click opens a preview modal with an explicit "Use this template" CTA
- [x] Status pill moved out of the top-right so `•••` can claim the corner
- [x] Status dot on sidebar rows hides on hover so it doesn't fight the `•••`
- [x] `MenuAnchor` hoisted to a global type so `chrome.ts` and `app.ts` share the contract
- [x] `openContextMenu` refactored into a generic `openMenu(items, anchor, onPick)`
- [x] Typecheck and lint clean

## What changed

### Hover/focus-revealed `•••` button on app cards (home grid)

`renderAppCard` in `apps/desktop/src/renderer/app.ts` now returns a `cd-app-card-wrap` div that holds the existing `<button class="cd-app-card">` plus a sibling `•••` action trigger built by `buildMoreButton`. The wrap is the positioning context (the card itself is a button, so nesting another button is invalid HTML), and is also the `:focus-within` anchor so tabbing onto the card reveals the affordance for keyboard users. The trigger opens the same context menu as right-click — see "Right-click on cards and sidebar rows opens the same menu" below.

### Hover/focus-revealed `•••` button on template cards (home grid)

`renderTemplateCard` mirrors the app-card structure: a `cd-tmpl-card-wrap` holds the existing template button plus a `•••` sibling. The button is wired to `openTemplateContextMenu` (a thin specialisation of `openMenu` with the template-specific item list). Template cards are shorter than app cards, so the CSS variant tucks the button against the right edge with `top: 50%; right: 6px; transform: translateY(-50%)`.

### Hover/focus-revealed `•••` button on sidebar app + draft rows (home and builder)

`apps/desktop/src/renderer/chrome.ts` gains an `appRow(item, appId, onAppContext)` helper that wraps each app/draft button in a `cd-sb-app-row` div with a `•••` sibling. The button is `cd-card-more cd-sb-more` so it reuses the existing reveal styles; a row-specific override sizes it down to 22×22 and uses a muted resting color (`var(--ink-4)`) so it reads as a supporting glyph until hovered. The wrap is only added when `onAppContext` is passed — test harnesses and other callers that don't need the menu get the bare row.

### Right-click on cards and sidebar rows opens the same menu (cursor-anchored)

`openContextMenu` was refactored to delegate to a generic `openMenu(items, anchor, onPick)` in `apps/desktop/src/renderer/app.ts`. `MenuAnchor` is a discriminated union — `{ kind: 'point'; x; y }` for right-click, `{ kind: 'rect'; rect }` for the `•••` button. Point anchors use the cursor position with viewport clamping; rect anchors drop the menu below the trigger's bottom-left, flipping horizontally if it would clip the right edge or vertically if it would clip the bottom.

The menu is identical regardless of which surface or trigger opened it. From sidebar rows, the wrap's right-click listener calls `onAppContext(id, { kind: 'point', x, y })`; the `•••` button calls `onAppContext(id, { kind: 'rect', rect })`. Home routes both into `openContextMenu(findApp(id), anchor)`; the builder routes them through `window.Centraid.openAppContext` (added to `CentraidRoot` so the builder doesn't need its own implementation).

### App menu gains Rename (inline contenteditable) and Reveal in Finder

The menu item list in `openContextMenu` now includes Rename and Reveal in Finder for both drafts and published apps. Rename is implemented by `startInlineRename(app)` — it locates the card via `[data-app-id="..."]`, flips `.cd-app-card-name` to `contenteditable="plaintext-only"`, selects all text, and listens for Enter (commit), Escape (cancel), and blur (commit). Commit calls `window.CentraidApi.updateProjectMeta({ id, name })` and re-renders home so the meta timestamp and any title-derived state stay consistent. Reveal in Finder is a one-liner against the existing `openProjectFolder` IPC.

The Rename trigger works from any surface — the home card's `•••`, the home card's right-click, the sidebar row's `•••`, the sidebar row's right-click, or the builder's sidebar (which forwards via `window.Centraid.openAppContext`). All four paths land on the same `startInlineRename` which finds the card by `data-app-id` and animates the rename inline.

### Template click opens a preview modal with an explicit "Use this template" CTA

`renderTemplateCard` no longer calls `cloneTemplate` on click — it now calls `openTemplatePreview(tmpl)`. The preview reuses the existing `.modal-card` chrome with a new `cd-tmpl-preview` variant: a head row with a tinted icon next to the title and a `v<version>` eyebrow, the template description, a subtle helper note explaining what cloning does, and primary "Use this template" + ghost "Cancel" buttons. The CTA closes the modal and then calls `cloneTemplate` — gating the side effect (a new project on disk) behind an explicit user gesture instead of a hair-trigger click. The right-click / `•••` menu still has a "Use this template" shortcut for users who don't need the preview.

### Status pill moved out of the top-right so `•••` can claim the corner

The "new" / "draft" status pill on app cards used to live at `top: 14px; right: 14px` via the now-deleted `.cd-status-corner` class. With the `•••` button claiming the corner, the pill moved into the meta row alongside the "Edited X ago" / "Continue editing" label. The pill sits at the right end of the meta row via `margin-left: auto`, so the bottom of the card now reads like a metadata strip rather than a tag-in-the-corner.

### Status dot on sidebar rows hides on hover so it doesn't fight the `•••`

Sidebar rows already carry a small status dot at their trailing edge (`.cd-sb-dot`). The `•••` button overlays the same region. To avoid double-visual-anchors, the dot fades to `opacity: 0` on `.cd-sb-app-row:hover` / `:focus-within` / `:has(.cd-card-more[data-open='true'])`. The dot keeps doing its passive-status job at rest; it gets out of the way when the user is actively engaging.

### `MenuAnchor` hoisted to a global type so `chrome.ts` and `app.ts` share the contract

`MenuAnchor` was originally declared locally inside `app.ts`. With the sidebar wiring spanning `chrome.ts` (which builds the row and emits the right-click event) and `app.ts` (which consumes the anchor and opens the menu), the type needed to be shared. It's now declared in `apps/desktop/src/renderer/types.d.ts` alongside the other global aliases, so both IIFEs can refer to it without a window-bridge dance.

### `openContextMenu` refactored into a generic `openMenu(items, anchor, onPick)`

The original `openContextMenu` mixed item-list construction, DOM building, positioning, and click handling in one function. The refactor splits it into:

- `openMenu(items, anchor, onPick)` — the generic DOM + positioning primitive. Builds the backdrop, the menu, applies edge-flipping for rect anchors and viewport clamping for point anchors.
- `openContextMenu(app, anchor)` — picks the app-specific item list (drafts vs. published) and delegates.
- `openTemplateContextMenu(tmpl, anchor)` — picks the template-specific item list and delegates.

This kept the existing call sites stable while making it trivial to add the template menu and to keep sidebar/card menus identical.

### `captureTrigger` simplified to find the open trigger directly

`captureTrigger` was originally parameterised by `appId` and walked the DOM to find the corresponding card's `•••` button. With multiple surfaces (home cards, template cards, sidebar rows, builder-sidebar rows) potentially holding `•••` buttons for the same app id, that lookup was ambiguous — `querySelector` would return whichever element came first in the DOM, not the one the user actually clicked. The fix: each `•••` button sets its own `data-open="true"` flag in its `onClick` *before* calling `onOpen`. `captureTrigger()` then just queries `.cd-card-more[data-open='true']` to find the currently-open trigger. Right-click flows skip this step entirely (no trigger to capture, `ctxTrigger` stays null, hover CSS handles visibility for that surface).

### Folder icon added to the shared design-tokens pack

A new `Folder` entry in `packages/design-tokens/icons.ts` (and its compiled `dist`) backs the "Reveal in Finder" menu item. Path data is a standard Lucide-style folder; the renderer picks it up via the generic `Icon[iconKey]` lookup.

## Verification

- Typecheck and lint clean: `bun run typecheck` (`@centraid/desktop`) and `bun run lint` (0 warnings / 0 errors across 120 files).
- `bun run format` — `oxfmt` clean across 200 files.
- Manual: not exercised in this environment (Electron desktop app). Reviewer should spin `bun run dev:desktop` and confirm:
  - Hovering an app card / template card / sidebar row reveals `•••`; clicking opens the action menu under the trigger.
  - Right-clicking the same surfaces opens the menu at the cursor.
  - Rename on an app flips its title to inline-edit; Enter or blur commits, Esc cancels; the home tile and any sidebar row holding that app reflect the new name on next render.
  - Clicking a template card opens the preview modal; "Use this template" clones and routes into the builder; "Cancel" / Esc / backdrop click dismisses without side effects.
  - Reveal in Finder opens the project folder in the OS file manager.
  - Builder's sidebar `•••` actions match the home grid's behaviour exactly (Rename works there too).

## Out of scope (parked from the audit)

- **Duplicate app** — the UX audit also called out a missing Duplicate verb, but implementing it requires a new `duplicateProject` IPC in `apps/desktop/src/main/ipc.ts` and a matching helper in `@centraid/agent-harness` (extending `clone.ts:copyDir`). Easy follow-up, separate PR.
- **Keyboard grid navigation** — arrow keys to move focus across cards would round out the home grid's accessibility. Worth doing as a separate, focused change.
- **Bulk select / shift-click on the home grid** — overkill until app counts grow.
- **List vs. gallery toggle for home / templates** — Notion has it; skip until requested.
