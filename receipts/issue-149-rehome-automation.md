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
- [ ] Phase 3 — in-process cron; delete the OS scheduler (n8n semantics)
- [ ] Phase 4 — confirm execution placement in `agent-runtime`

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

## Decision: gateway-owned in-process cron (n8n semantics)

Scheduling adopts n8n's model: the always-on server owns cron triggers
in-process; there is no OS-level scheduler. Scheduled automations fire
**only while the gateway/app is running**, and missed fires during
downtime are silently skipped with no backfill.

> ⚠️ This reverses the hard rule from #69 ("automations fire even when the
> desktop is closed"). It is a deliberate, accepted trade for a single,
> simpler owner. Captured in Phase 3 below.

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
