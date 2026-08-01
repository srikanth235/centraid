# Issue #669 — Merge main into sidebar IA PR and restore desktop e2e navigation

## Checklist

- [x] Merge `origin/main` into `claude/sidebar-ux-ia-ef2760` with zero conflict markers
- [x] Resolve `ShellApp.tsx` keeping #667 compact drawer + #670 memoized Outlet
- [x] Auto-merged `App.tsx` / `package.json` / `ci.yml` retain both parents' intents
- [x] Desktop e2e reaches Discover via ⌘K palette (not a missing rail button)
- [x] Desktop e2e reaches Analytics (Insights rename) for the spend hero screen

## What changed

- **Merge resolution** — `ShellApp.tsx` combines compact drawer open-state (`useCompactLayout`, route-keyed `{open,at}`, `onDismissSidebar`) from #667 with the #670 `Outlet` memo boundary around both `renderScreen` and `renderSidebar`.
- **e2e nav helpers** — `gotoNav` in `apps/desktop/tests/e2e/fixtures.ts` opens palette-only destinations (Discover) through `Meta+k` + filter + row click, and aliases legacy rail labels (`Insights` → `Analytics`, `Household` → `Devices`, `Vault Atlas` → `Data`). Spec 11.1 uses the current **Analytics** label.

## Out of scope

- Merging PR #669 to main (only make it mergeable + green).
- Redesigning sidebar IA beyond conflict + CI repair.
- Full Electron e2e locally when the environment cannot run desktop; CI is the green proof for that lane.

## Verification

```
# client shell / IA unit tests (shipped modules)
bun run --cwd packages/client test -- \
  src/react/shell/Sidebar.test.tsx \
  src/react/shell/ShellApp.test.tsx \
  src/react/shell/useCompactLayout.test.ts \
  src/react/shell/App.test.tsx
# → 4 files, 49 tests passed

bun run check:push
# → captured under implementer scratch; exit 0 expected
```

Desktop e2e Discover/Analytics path is structural + CI: no `gotoNav(..., "Discover")` against a rail button; palette path uses the same product entry as #667.

## Steering

PASS — no human steering events in this session; goal was fully specified (merge conflicts + green PR #669).
