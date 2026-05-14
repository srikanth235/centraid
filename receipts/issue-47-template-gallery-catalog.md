# issue-47 — Template gallery behaves like a Notion catalog

GitHub issue: [#47](https://github.com/srikanth235/centraid/issues/47)

## Checklist

- [x] Templates stay in the gallery after a clone (drop the `installedIds` filter)
- [x] Cloned app id never collides with the template's bare id (`alwaysSuffix`)
- [x] Builder auto-focuses + selects the inline title after a clone
- [x] `focusName` is one-shot — not persisted into the nav route
- [x] Typecheck and tests clean

## What changed

**Templates stay in the gallery after a clone (drop the `installedIds` filter).** `loadAvailableTemplates` in `apps/desktop/src/renderer/app.ts` used to build a `installedIds = new Set(userApps.map(u => u.id))` and filter the template list against it; cloning Todos therefore made Todos disappear from the strip. Removed the filter — `loadAvailableTemplates` now returns the full catalog. Comment updated to spell out the Notion mental model ("cloning never depletes the list") so the next reader doesn't reintroduce the filter.

**Cloned app id never collides with the template's bare id (`alwaysSuffix`).** `suggestAppId` in `packages/agent-harness/src/clone.ts` gains an `{ alwaysSuffix?: boolean }` option. When set, the search loop starts at `i = 2` instead of `i = 1`, so the bare `preferred` candidate is skipped and the first suggested id is `${preferred}-2`. The template-clone IPC in `apps/desktop/src/main/ipc.ts` opts in whenever no explicit `newAppId` was passed (`{ alwaysSuffix: !input.newAppId }`): first clone of Todos is `todos-2`, second `todos-3`, and so on. Callers that pass an explicit id keep the existing first-fit behavior.

**Builder auto-focuses + selects the inline title after a clone.** `BuilderOptions` in `apps/desktop/src/renderer/types.d.ts` gains a `focusName?: boolean` flag. The clone path in `apps/desktop/src/renderer/app.ts` (`cloneTemplate → enterBuilder({ appContext: draft, focusName: true })`) sets it. `apps/desktop/src/renderer/builder.ts` reads the flag and, immediately after `root.append(shell)`, calls `requestAnimationFrame` to focus the inline title element (`projNameEl`) and select its text via a `Range` so the user can type to replace the inherited template name, press Enter to commit, or Esc to keep it — matching Notion's "Duplicate" UX.

**`focusName` is one-shot — not persisted into the nav route.** `enterBuilder` in `apps/desktop/src/renderer/app.ts` destructures `{ focusName, ...routeOpts } = opts` and records only `routeOpts` via `recordRoute({ kind: 'builder', ...routeOpts })`. `focusName` is conditionally spread back onto the `openBuilder` call (`...(focusName ? { focusName: true } : {})`) so it reaches the builder on this entry but is dropped from the history entry. Back/forward replays therefore don't re-focus the title every time the user returns to the route.

## Out of scope (parked from the audit)

The audit surfaced additional Notion-style gaps deliberately left for follow-up:

- Search / categories / filters on the gallery (premature with only 3 templates; the manifest should grow a `category` field before retrofitting).
- Preview-before-clone (wiring the existing `previewUrl` IPC to template cards).
- "Save my app as a template" — implies an authoring flow, data stripping, and a destination, not a polish pass.
- Draft → "local" relabel — separate UX clarity change.
- Lineage tracking (`clonedFromTemplateId`) — Notion deliberately doesn't do this; skipped unless template-update propagation becomes a goal.

## Verification

**Typecheck and tests clean.** `npm run typecheck` reports 12/12 tasks successful across the workspace. `cd packages/agent-harness && npm test` passes the existing `publish.test.ts` suite (no tests cover `suggestAppId` directly; the new `alwaysSuffix` branch is exercised by the desktop clone path which calls it on every template-clone IPC). Manual: clicking a template tile on home still creates a draft, the template stays visible in the strip afterward, and the builder opens with the title text focused and pre-selected.
