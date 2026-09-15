# The scheduler host, and exactly what it must call (#1020, lane automations)

`crates/automations` decides what should run. **Nothing in it decides when**: there is no timer, no task and no process, because a seat that is asleep must simply not tick rather than tick into a queue nobody drains. This is the list of calls the gateway owes, in order, with the reason each order matters.

## On boot

1. **`centraid_vault::ledger::automation_cursor::pending()`** first, before any tick. A pending write-ahead batch is authoritative: a gateway that started ticking before draining these would re-read sources whose elements are already owed, and cron would collapse to a newer due instant.
2. **`centraid_automations::fire::register(ref, triggers, vault_zone, signals)`** per automation, from the manifests on disk. A refusal returns no registration and raises `Signal::ZoneUnset` — the automation is **not** registered, and that is the point.
3. **`fire::arm_capability(lock, runtime_dir, capability, fetcher, signals)`** per capability the release is provisioning. It answers a boolean and never an error: the gateway boots either way and an unarmed capability's automation stays unavailable until the next boot.
4. **`automation_cursor::retain(&slots)`** with every DECLARED slot, enabled or not. An **empty** set is refused rather than treated as "delete everything", because the only caller that could pass one is a reconcile that read no automations.

## Once a minute

5. **`fire::cursor::CursorEngine::is_due(&registration, at)`**, then **`tick(&registration, at, paused, read)`** for each due one. `paused` is the owner's background pause, and it is applied HERE rather than at the fire: a pause that read a cursor and threw the element away would cost a delivery.
6. **`fire::scheduler_ledger::record_scheduler_tick(&ledger, now, &entries, grace)`**. The missed windows are computed and written **before** the tick moves `last_tick_at`, so a crash between the two leaves the gap discoverable again rather than erased.

## On a doorbell

7. **`webhook::accept(&delivery, target, secret, store, limiter)`**, then a nudge of the matching registration. A webhook trigger is reached by neither `is_due` nor a change nudge, so without the nudge the delivery sits in `trigger_ingress` until the next reconcile.
8. On a vault change, nudge the `data` registrations whose watched entities are in the change set. `Watchable::logical()` is the name to match on.

## What the host must NOT do

- **Fire from two places.** `centraid automations deliver` is a client: it hands a delivery over and the gateway stores and fires it. A CLI that fired would be a second scheduler with its own idea of what is due.
- **Re-derive a backfill class or a zone.** Both are resolved once at registration, in `registrations_for`; a host that re-read them per tick could change a schedule's meaning mid-catch-up.
- **Prune a live cursor.** The band's retention pass is `crates/assist`'s; `trigger_ingress` prunes on its own `expires_at` through `automation_ingress::prune_expired`.
