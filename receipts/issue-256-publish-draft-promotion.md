# issue-256 — Publish reliably promotes an app out of draft

GitHub issue: [#256](https://github.com/srikanth235/centraid/issues/256)

There is no server-side draft/published stage: a Home tile reads as a
"draft" purely because its app id is not in the local `home.userApps`
store (`app.ts` `isDraft`/`hydrateDrafts`), and draft tiles always route
to the builder (`app-cards.ts` `renderAppCard` onClick). The only code
that promotes an app into `userApps` is the builder's `onAddToHome`
callback, which previously fired only on the publish success path — so
two publish outcomes stranded an already-live app as a permanent draft.

## Checklist

- [x] Commit 1 — builder: promote to Home on `no_changes`; make the
      live-URL fetch best-effort

## What changed

`apps/desktop/src/renderer/builder.ts` (`handlePublish`), two paths:

1. **Unedited scaffold/clone → `no_changes`.** A clone/scaffold already
   lands a baseline on the gateway's `main`, so publishing before any
   edit throws `no_changes` from the gateway. The catch branch now
   treats this as "already live" and calls `onAddToHome` (guarded on
   `appId`), exactly like a successful publish. Status line + toast now
   say "Already up to date — added to Home."

2. **Successful publish, then `appLiveUrl()` throws.** The live-URL
   fetch sat between `publish()` and `onAddToHome` on the success path;
   a failure there diverted to catch *after* the publish had committed
   on the gateway. The fetch is now wrapped in its own try/catch (it
   only feeds the preview iframe) so post-publish bookkeeping cannot be
   derailed.

## Out of scope

- A real server-side stage field (draft-ness stays a client-side
  `userApps` membership test).
- The draft-tile → builder routing itself (`app-cards.ts:128`) — correct
  once promotion works.

## Verification

- `tsc -p apps/desktop/tsconfig.json --noEmit` clean.
- `bun run build` green across all packages.
- Manual repro of the reported symptom: scaffolded app → Publish →
  previously stayed "DRAFT" and its tile reopened the editor; with the
  fix the `no_changes` branch promotes it to Home and the tile opens
  the app view.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-d38d2e7f-444-1783076423-1 | claude-code | d38d2e7f-4443-4586-8d36-7f30f661b9e7 | #256 | claude-fable-5 | 45974 | 1104961 | 14216312 | 134688 | 1285623 | 35.2225 | 45974 | 1104961 | 14216312 | 134688 | fix(desktop): publish promotes the app out of draft on no_changes + live-URL hic |
| claude-code-12ab1d75-8d3-1783081426-1 | claude-code | 12ab1d75-8d3a-454e-aa62-56c104e22ec5 | #256 | claude-opus-4-8 | 28686 | 43199 | 335923 | 3071 | 74956 | 0.6582 | 28686 | 43199 | 335923 | 3071 | fix(desktop): promote scaffolded apps to Home on no-op publish (#256)Treat "no c |
