# Visual verification harness (dev-only)

Serves `docs`/`photos`/`tasks`/`notes`/`agenda`/`people`/`tally`/`locker`
through the real `serveStatic` (esbuild JSX transform, kit shared-asset
fallback, CSP+nonce) with a mocked `window.centraid` — zero gateway/vault.
Never wired into the shipped runtime.

Run:

```
bun packages/blueprints/visual-harness/server.mjs
```

or via the `visual-harness` launch.json config (port 4173).

URLs:

- http://localhost:4173/centraid/docs/
- http://localhost:4173/centraid/photos/
- http://localhost:4173/centraid/tasks/
- http://localhost:4173/centraid/notes/
- http://localhost:4173/centraid/agenda/
- http://localhost:4173/centraid/people/
- http://localhost:4173/centraid/tally/
- http://localhost:4173/centraid/locker/

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

People-specific: the same `(park)` marker parks a write when it appears in
any typed text (note/task/gift/journal text, circle name, person name…) or
in the *target person's* name — the seeded "Priya Nair (park)" parks every
drawer write against her. The fixture covers three circles, two favorites,
an overdue person (Reconnect), a due-soon person, a never-contacted person
with no stored avatar colour (hash-fallback path), reminder dates for the
Upcoming view, owner journal entries folded with auto interaction entries,
and one rich profile (Dadu: contact, relationships, dates, notes, tasks,
gifts, interactions; the open debt lives on Arjun).

Tally-specific: `(park)` in an expense description or a friend/group name
parks the write. Currency is INR (the vault's base currency drives
formatting). The fixture ships two groups — the seed.js "Goa Trip" scenario
(equal splits with payer remainder, one partial-participation expense, a
partial settlement from Sana) and "Flat 4B" with exact- and percent-style
uneven splits — producing non-zero balances in both directions (you-owe and
you-are-owed).

Locker-specific: `(park)` in an item title parks every write against it
(seeded: "Netbanking (park)"). The fixture covers all six categories —
including a login with password + `JBSWY3DPEHPK3PXP` TOTP seed so the OTP
ticker computes live codes — a favorite, tags, a weak+reused login and a
breached login (Watchtower), and a trashed item with a purge date. The
single-`item` query returns secrets in plaintext (there is no reveal round
trip to mock).

Devtools escape hatch: `window.__fixtures.state` (current store), `.reset()`, `.fireChange()`.
