# issue-218 — Fix the blank-frame flicker on sidebar navigation

GitHub issue: [#218](https://github.com/srikanth235/centraid/issues/218)

Clicking a sidebar destination flashed an empty window before the new
view painted. The affected renders cleared the DOM up front and then
awaited IPC before building anything, so the window sat blank for the
duration of the round-trips. Home awaited three IPCs (`hydrateDrafts` +
two `listTemplates`), Discover one (`loadAvailableTemplates`), and
Settings one (`listGateways`). Insights and Automations already dodged
this by painting a synchronous "Loading…" placeholder before awaiting,
and Starred is fully synchronous — those three async renders were the
outliers.

## Checklist

- [x] Split clear() into teardownCurrent() (no DOM wipe) plus the wipe
- [x] Home — defer the DOM wipe and swap the shell atomically
- [x] Discover — defer the DOM wipe and swap the shell atomically
- [x] Settings — defer the DOM wipe and swap the shell atomically
- [x] Shared mountShellPage swaps with replaceChildren instead of append

## What changed

**Split clear() into teardownCurrent() (no DOM wipe) plus the wipe.**
`clear()` in
`apps/desktop/src/renderer/app.ts` previously ran the view teardown
(current cleanup, close context-menu / app-settings / command-palette,
reset `currentSetSidebarOpen`), bumped the `renderSeq` stale-render
guard, and wiped `root.innerHTML`. The teardown + seq-bump are now
factored into a `teardownCurrent()` helper; `clear()` calls it and then
does the DOM wipe. Synchronous renders keep using `clear()` unchanged —
all thirteen existing call sites are untouched.

**Home — defer the DOM wipe and swap the shell atomically.**
`renderHomeAsync` now calls `teardownCurrent()` instead of `clear()`, so
the old view stays on screen while `hydrateDrafts()` and the two
`listTemplates()` IPCs resolve. The built shell is swapped in with
`root.replaceChildren(shell)` — a single mutation, so there is never a
blank frame.

**Discover — defer the DOM wipe and swap the shell atomically.**
`renderDiscoverAsync` calls `teardownCurrent()` instead of `clear()`
before `await loadAvailableTemplates()`; the shell is mounted through
the shared `mountShellPage`, which now swaps atomically. The existing
`isCurrentRender(seq)` bail in `mountShellPage` is unchanged, so a render
superseded mid-load leaves the DOM to whichever render won.

**Settings — defer the DOM wipe and swap the shell atomically.**
`renderSettingsAsync` calls `teardownCurrent()` instead of `clear()`
before `await listGateways()`, and its final `root.append(shell)` becomes
`root.replaceChildren(shell)`. It already carried the `isCurrentRender`
bail guard.

**Shared mountShellPage swaps with replaceChildren instead of append.**
`mountShellPage`'s `root.append(shell)` is now `root.replaceChildren(
shell)`. For synchronous callers (Insights, Starred, Automations) the
root is already empty after their `clear()`, so this is equivalent to
append; for Discover's deferred-wipe path it is the atomic swap.

## Out of scope

- `openApp` keeps its synchronous `clear()` + `root.append(shell)`: it
  builds and appends the app shell synchronously (the `mountUserApp`
  awaits come *after* the shell is on screen), so there is no blank-frame
  gap to close.
- No new loading-placeholder UI was added; the fix is purely to stop the
  blank frame by keeping the prior view up until the replacement is ready.

## Verification

- `npm run -w apps/desktop typecheck` passes clean.
- Manual: `npm run -w apps/desktop dev` and click between Home, Discover,
  and Settings — the prior view stays up until the new one is ready, with
  no intervening blank frame. (Electron renderer; no browser-preview
  harness applies.)
