# issue-149 — re-home automation across the stack

GitHub issue: [#149](https://github.com/srikanth235/centraid/issues/149)

`automation` had no single, well-named home: the domain lived in
`app-engine` alongside a mislabeled agent-run ledger; local execution and
an OS scheduler were bundled into `agent-runtime` with the interactive
turn engine; the gateway wired it together. This re-homes automation into
one module, folds the headless executor in beside the interactive
backends, and converges scheduling on a single always-on in-process owner.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Phase 1 — rename the agent-run ledger off the `automation-` prefix
- [x] Phase 2 — extract `@centraid/automation` (the domain)
- [x] Phase 3 — in-process cron; delete the OS scheduler (n8n semantics)
- [x] Phase 4 — confirm execution placement in `agent-runtime`

## What changed

### Phase 1 — rename the agent-run ledger off the `automation-` prefix

No behavior change.

The `automation-runs-*` files are the unified agent-run ledger — a chat
turn, an automation fire, and a builder iteration are all the same row,
discriminated by `RunKind`. The `automation-` prefix mislabeled shared
cross-cutting run infrastructure as automation-domain code, manufacturing
a fake chat→automation edge.

- Renamed `automation-runs-{schema,store,store-sql}.ts` → `agent-runs-*`,
  and the row symbols `AutomationRunsStore` / `AutomationRunRow` /
  `AutomationRunNodeRow` / `AutomationRunNodeKind` → `AgentRuns*`. The
  automation-trigger taxonomy (`AutomationTriggerKind` / `…Origin`) and the
  `automation_state` KV keep their honest automation names.
- Moved the general `isValidAppId` out of `automation-ref` (domain) into
  `app-paths` (neutral app-identity), so `chat-history` no longer imports
  from the automation domain. The ledger is now an isolated, clearly-named
  module and the automation domain is ready to extract.
- `analytics-store` / `insights-store` keep their names, documented as
  shared run infra.

### Phase 2 — extract `@centraid/automation` (the domain)

New package `@centraid/automation`, depending on `@centraid/app-engine`.
The automation footprint that app-engine was carrying for historical
reasons moved out wholesale; app-engine keeps the per-app engine + the
shared agent-run ledger.

- Moved the 12 domain modules (`automation-manifest`(+`-output`/`-errors`),
  `automation-app`, `automation-fire` — the spine + `OpenAutomationDispatch`,
  `automation-host`, `automation-webhook`, `automation-handler-runner`/`-ctx`/
  `-audit`, `scaffold-automation`, `automation-ref`) and the worker entry
  `worker/automation-runner.ts` into `@centraid/automation`. Their imports of
  app-engine core (ledger store, schema, gateway-db, log-store, app-paths,
  scaffold-files/-types) repoint to `@centraid/app-engine`; intra-domain
  imports stay relative.
- Removed the domain re-exports from app-engine's barrel and proved
  acyclicity: no app-engine *core* module imports the domain (only the barrel
  did, for re-export). `@centraid/automation` never imports `agent-runtime`.
- Repointed every consumer (`gateway`, `openclaw-plugin`, `agent-runtime`,
  `desktop`) from the app-engine barrel to `@centraid/automation` for domain
  symbols, splitting mixed import statements and adding the `workspace:*`
  dependency. The automation-trigger taxonomy and the agent-run ledger stay
  imported from `@centraid/app-engine`.
- Moved the file-map scaffolder tests off app-engine's `scaffold-files.test.ts`
  (app-engine can't depend on the domain) into the new package.
- Incidental: dropped a pre-existing unused `runAgentTurn` import in the
  gateway's `unified-chat-runner` that full-repo lint surfaced.

### Phase 3 — in-process cron; delete the OS scheduler (n8n semantics)

Scheduling converges on one always-on owner per deployment.

- Added `InProcessScheduler` (implements `AutomationHost` + `start`/`stop`)
  and a pure `cronMatches` matcher to `@centraid/automation`. The scheduler
  keeps an in-memory registry keyed by automation ref and a single
  minute-boundary timer; on each tick it fires enabled cron automations whose
  5-field expr matches the current minute. A `lastFiredMinute` guard means
  each wall-clock minute runs at most once and minutes slept through are not
  backfilled. Clock + fire effect are injected, so firing is unit-tested.
- `gateway`: `serve()` now constructs **one** persistent `InProcessScheduler`
  and wires its `fire(ref)` to the **same** `runAutomationLocal` closure as
  "run now" (a shared `fireAutomation` helper; scheduled fires carry
  `triggerKind: 'scheduled'` / `triggerOrigin: 'cron'` and respect the user's
  runner pref). `reconcileScheduler()` drives that one instance on boot + every
  publish/delete; `serve()` starts it on boot and `handle.close()` stops it
  before the HTTP server. The `schedulerHostFactory` injection is replaced by
  an optional `scheduler` (for test spies).
- Deleted the OS scheduler entirely: `os-scheduler.ts` + `os-scheduler-host.ts`
  (+ tests) and every launchd/systemd/Task-Scheduler export from
  `agent-runtime`. Dropped the `centraid run-automation` subcommand (its only
  caller was the OS scheduler); the CLI keeps `sql` + `preview snapshot`.
- `desktop`: removed the `OsSchedulerHost` / `schedulerHostFactory` wiring
  (and the now-dead path helpers) — the gateway owns scheduling internally.
- Tests: rewrote `serve-scheduler-reconcile` to inject a spy scheduler; added
  `cron-match` and `in-process-scheduler` unit tests (minute-match, reconcile
  diff, fire-once-per-minute / no-backfill).
- Updated the stale OS-scheduler docs (the scaffolded automations brief, the
  `AutomationHost` interface, `app-paths`, `apps-store`) to describe the
  in-process model.

> ⚠️ This reverses the hard rule from #69 ("automations fire even when the
> desktop is closed"): scheduled automations now fire **only while the gateway
> runs**, and missed fires during downtime are silently skipped — identical to
> n8n's Schedule Trigger. A deliberate, accepted trade for one simpler owner.

### Phase 4 — confirm execution placement in `agent-runtime`

No code change beyond Phase 2's repointing. The headless executor
(`run-automation-local`, `run-automation-cli-spawn`, `run-automation-live-dispatch`,
`mock-llm-server`/`-writers`, `host-tools`, `centraid-cli`/`-dir`) stays in
`agent-runtime` beside the interactive backends; `runAutomationLocal` implements
`@centraid/automation`'s `OpenAutomationDispatch`, importing the fire spine and
dispatch types from `@centraid/automation`. The WIP `@centraid/automation-runtime`
extraction was never created — this branch started from a clean `main`.

## Out of scope

- **`openclaw-plugin` (the cloud host)** is not re-architected here. It stays
  an injected implementation; it only repoints imports once `@centraid/automation`
  exists (Phase 2) and keeps owning its own in-process scheduling on cloud.
- **The automation-trigger taxonomy and `automation_state` KV** keep their
  `Automation*` names — they are genuinely automation concepts that the shared
  ledger records, not mislabels.

## Verification

- Phase 1: `@centraid/app-engine` 405 tests pass; `gateway`, `openclaw-plugin`,
  `agent-runtime` typecheck clean.
- Phase 2: `turbo run typecheck` green (19/19); `turbo run test` green
  (app-engine 356, automation 49, gateway 62, agent-runtime 86, openclaw 6,
  skills 6); `turbo run build` green; lint clean.
- Phase 3/4: `turbo run typecheck` green (19/19); `turbo run test` green
  (automation 59 incl. cron-match + scheduler unit tests, agent-runtime 59
  after the OS-scheduler test deletion, gateway 62); `turbo run build` green;
  lint clean.
