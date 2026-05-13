# issue-28 — Wire back/forward nav + sidebar toggle states

GitHub issue: [#28](https://github.com/srikanth235/centraid/issues/28)

## Checklist

- [x] Renderer history stack covering home / app / builder routes
- [x] Back/forward toolbar buttons wired through `ChromeBuildWindowOpts`
- [x] ⌘[ / ⌘] keyboard shortcuts
- [x] Sidebar toggle glyph swaps based on open/closed state
- [x] Traffic-light spacer widened 52→64px

## What changed

**Renderer history stack covering home / app / builder routes.** `app.ts` gains a `ShellRoute` union (`home` | `app` | `builder`) plus a `navStack` array and `navIndex`. `recordRoute` is called from `renderHomeAsync`, `openApp`, and `enterBuilder` — guarded by an `applyingNav` flag so back/forward navigations don't re-push. `routeKey` collapses duplicate consecutive entries so re-entering the same app doesn't pollute history. `goBack` / `goForward` walk the stack and re-apply the recorded route via `applyRoute`.

**Back/forward toolbar buttons wired through `ChromeBuildWindowOpts`.** `chrome.ts` extends `ChromeBuildWindowOpts` with `canGoBack` / `canGoForward` / `onBack` / `onForward`. `backButton()` and `forwardButton()` factories build the toolbar icons with `disabled` reflecting the current stack position; the sidebar-toggle rebuild path also rebuilds these so transitions stay in sync. `builder.ts` forwards the same four options through to `Chrome.buildWindow` so the builder shell participates in the same history. `types.d.ts` adds the matching fields on both the builder-entry opts and `ChromeBuildWindowOpts`.

**⌘[ / ⌘] keyboard shortcuts.** The existing global `keydown` handler in `app.ts` now intercepts `⌘[` / `⌘]` (and `Ctrl+[` / `Ctrl+]` on non-mac) and routes them to `goBack` / `goForward`. Escape-to-close-context-menu behaviour is preserved.

**Sidebar toggle glyph swaps based on open/closed state.** `chrome.ts` introduces `Glyph.sidebarOpen` (rect with the divider hugging the left edge) and `Glyph.sidebarClosed` (divider on the right). A `sidebarToggle(open)` factory picks the right glyph plus matching `title` / `ariaLabel` ("Hide sidebar" vs "Show sidebar"). The sidebar-toggle rebuild path uses the same factory so the icon flips in lockstep with the animated grid.

**Traffic-light spacer widened 52→64px.** `styles.css` widens the spacer in both `.cd-tl-side` and `.cd-tl-main` so the first toolbar icon clears the native macOS controls with the same calm gap as Codex's chrome. `.cd-tl-side`, `.cd-window`, and `.cd-tl-main` lose `overflow: hidden` so the tooltip layer paints outside the strip; `.cd-tl-main` picks up `position: relative` + `z-index: 4`. Toolbar buttons get a `translateY(2px)` nudge inside both strips for vertical centring against the 44px titlebar.

## Out of scope

- Persisting history across reloads. The stack lives in renderer memory only; a full reload returns to home with an empty stack.
- Per-app deep linking (the recorded `app` route uses the app's `id` but the in-app state is whatever the iframe currently shows).
- Mouse forward/back buttons / trackpad swipe gestures. Keyboard + toolbar only for now.

## Verification

- Manual: navigate home → open app → enter builder; back walks builder → app → home with buttons disabling at the ends. Forward replays the same path.
- Manual: ⌘[ / ⌘] mirror the toolbar buttons.
- Manual: sidebar toggle swaps glyph and tooltip text when toggling open/closed.
- Visual: first toolbar icon now sits ~12px further from the macOS traffic lights (52→64px spacer); vertical centring matches the design.
