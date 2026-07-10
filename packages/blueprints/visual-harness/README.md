# Visual verification harness (dev-only)

Serves `docs`/`photos`/`tasks` through the real `serveStatic` (esbuild JSX
transform, kit shared-asset fallback, CSP+nonce) with a mocked
`window.centraid` — zero gateway/vault. Never wired into the shipped runtime.

Run:

```
bun packages/blueprints/visual-harness/server.mjs
```

or via the `visual-harness` launch.json config (port 4173).

URLs:

- http://localhost:4173/centraid/docs/
- http://localhost:4173/centraid/photos/
- http://localhost:4173/centraid/tasks/

Knobs (combine freely):

- `?empty=1` — every collection empty (empty-state verification)
- `?denied=1` — every read returns `{ vaultDenied: { message: 'Grant revoked.' } }` (consent-banner verification)
- `#theme=dark&bgL=10` — read by the app's own inline settings bridge already baked into `index.html`, not by this harness

Tasks-specific: any add/edit/set-status/attach/detach touching a task whose
title contains `(park)` returns a `parked` outcome instead of executing —
type e.g. `Renew passport (park)` in the capture bar, or open the seeded
"Sign the lease renewal (park)" task and edit it, to see the accent-rail +
spinning pending-chip treatment. The fixture board covers overdue/today/this-
week/later/anytime buckets, an in-process task, a recurring task, a task with
subtasks (1/3 done), a task with an attachment, and a logbook (completed +
cancelled).

Devtools escape hatch: `window.__fixtures.state` (current store), `.reset()`, `.fireChange()`.
