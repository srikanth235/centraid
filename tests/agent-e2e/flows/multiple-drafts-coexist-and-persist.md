# Flow: Three independent drafts coexist and persist

> **⚠️ Stale premise — verify before running.** Commit `4397329` ("'Use
> template' installs app templates directly as published apps") removed the
> draft stage for app templates entirely: `installAppTemplate`
> ([templatesData.ts](../../../packages/client/src/react/shell/routes/templatesData.ts))
> now clones with `publish: true` and pins the result straight onto Home as a
> `UserAppMeta`, never a `__draft`; `DiscoverRoute.tsx`'s `applyAppTemplate`
> confirms there is no builder detour. `loadAppTemplates` also no longer
> excludes installed templates (filters only `!isAutomationTemplate`), so the
> "Only Publish removes a template from the available list" claim below is
> unverified against current code. This flow's scenario (clone → builder →
> draft tile → delete) describes a stage that no longer exists for app
> templates; the underlying steps need a live-rig rewrite before reuse. Left
> as historical record rather than silently deleted or guessed at — flag for
> a follow-up pass with real e2e-live verification.

## Goal
Multiple template clones produce independent drafts on disk and on home. The
TEMPLATES section is NOT consumed by cloning — `loadAvailableTemplates`
([templatesData.ts](../../../packages/client/src/react/shell/routes/templatesData.ts) at line 15) filters by
**published** `userApps`, not by drafts. Only Publish removes a template from
the available list. All three drafts (and the three template tiles) must
survive a full restart.

## Setup
Fresh `userData` and `appsDir`. TEMPLATES section shows
Hydrate / Todos / Journal.

## Steps
1. Verify all three templates appear under TEMPLATES on fresh launch.
2. Clone each template in turn: click tile → builder opens → Back to home.
3. Verify TEMPLATES still shows all three tiles (no consumption by clone).
4. Verify APPS section now holds three draft tiles (`data-draft="true"`).
5. Verify three app directories exist under `appsDir`.
6. Restart Electron.
7. Verify all three drafts and all three templates are still present.

## Expectations
- After step 3: TEMPLATES still complete.
- After step 4: 3 drafts under APPS.
- After step 5: 3 app dirs on disk.
- After step 7: all of above hold post-restart (drafts hydrate from disk).

## Verdict
PASS if every expectation holds. FAIL with the specific tile / dir that's
missing or unexpectedly present.
