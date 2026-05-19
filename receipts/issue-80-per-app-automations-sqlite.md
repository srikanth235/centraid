# issue-80 — per-app automations.sqlite with run audit, run_nodes, ctx.state, and richer manifest

GitHub issue: [#80](https://github.com/srikanth235/centraid/issues/80)

## Checklist

- [x] Per-app `automations.sqlite` store (runs, run_nodes, state) with lazy file creation + own migration ladder
- [x] Manifest reshape: `trigger:{kind,expr}` canonical with legacy `schedule` back-compat, `outputSchema`, `onFailure`, `history.keep`
- [ ] Instrument `runAutomationHandler` to commit `runs` + `run_nodes` rows around handler execution (incl. batch_id, attempt)
- [ ] `ctx.state.{get,set}`, `ctx.runs.{last,list}`, `ctx.invoke(name, {input})` against the per-app file
- [ ] `opts.retry: { max, backoff }` and `opts.onError: 'fail'|'continue'` on `ctx.tool`
- [ ] `onFailure` dispatch (incl. timeout/crash) with depth-3 recursion cap
- [ ] `outputSchema` validation of handler return; failures land in `runs.error`, `runs.ok=0`
- [ ] Retention pruning at end-of-run per `history.keep`
- [ ] System-prompt `### Run audit & state` block under `### Automations`
- [ ] Desktop UI: per-automation run list + per-run node timeline
- [ ] Boundary test: `centraid_sql_*` agent tools cannot reach `automations.sqlite`
- [ ] Unit tests across runtime-core / agent-runtime; typecheck + lint green

## What changed

**Per-app `automations.sqlite` store (runs, run_nodes, state) with lazy file creation + own migration ladder.** New `packages/runtime-core/src/automation-runs-schema.ts` defines the on-disk shape: three tables — `runs` (run_id PK, automation_name, trigger_kind one of `scheduled|manual|replay|on_failure`, optional `parent_run_id` self-FK for sub-invocations, `input_json`, terminal `summary` + `output_json` validated against manifest `outputSchema`), `run_nodes` (CASCADE-from-runs, with `ordinal` + `attempt` so retries land as distinct rows sharing one ordinal, and `batch_id` shared across nodes in one Promise.all frontier), and `state` (per-(automation_name, key) KV for `ctx.state`). Indexes on `(automation_name, started_at DESC)` for the UI run list and `(name, started_at DESC)` for run-nodes tool-usage queries. Migration ladder is separate from the gateway DB ladder so the per-app file can evolve independently. `automation-runs-store.ts` wraps the file in a lazy `AutomationRunsStore` — the DB handle isn't opened until the first method call, which means the file stays absent on disk until an automation actually fires.

The store exposes `insertRun` / `finishRun` (parent state-machine for one fire), `insertNode` (per ctx.tool/ctx.agent call with batch_id + attempt), `listRuns({name?, status?, since?, limit?})` for the UI and `ctx.runs.list` surfaces, `lastRun(name, status?)` for the "since last successful run" cursor pattern, `listNodes(runId)` for the per-run timeline view, `stateGet/stateSet/stateDelete` for `ctx.state`, and `prune({count|days|errorsOnly|all})` so the manifest's `history.keep` policy can run at end-of-run with CASCADE pulling orphaned `run_nodes` along. The handle is opened with WAL + `foreign_keys=ON` for the same reasons as `data.sqlite`.

**Manifest reshape: `trigger:{kind,expr}` canonical with legacy `schedule` back-compat, `outputSchema`, `onFailure`, `history.keep`.** `packages/runtime-core/src/automation-manifest.ts` grew four field surfaces. Canonical trigger is now `trigger: { kind: 'cron', expr: '<cron>' }`; only `kind: 'cron'` is wired — `webhook` / `event` will land later without a second migration. Bare `schedule: "<cron>"` manifests still parse via `validateManifest` and normalize to the new shape in memory; the parsed manifest keeps both `schedule` and `trigger.expr` populated and identical so existing consumers (mirror table, cron registration, UI display) need no change. When both are present, `trigger` wins.

`outputSchema` declares the shape of the handler's optional `return { summary, output }`. The validator accepts the JSON-Schema subset that issue #80 calls out (object root, scalar/object/array property types, `required`). `validateOutputAgainstSchema(schema, output)` returns `null` on pass or a human-readable error string on fail; the runtime feeds that into `runs.error` + `runs.ok=0` when the shape doesn't match. Full JSON-Schema support stays out of scope.

`onFailure` names a sibling automation to dispatch on handler failure. The validator enforces `isValidAutomationName` shape; cross-reference validation (the named automation actually exists) happens at sync-time in `sync-automations.ts` rather than at manifest-parse time, since the parser sees one manifest at a time.

`history.keep` is one of `{count: N}` | `{days: N}` | `"all"` | `"errors"`, defaulting to `{count: 100}` when omitted. The retention shape is parsed here so the runtime can hand it straight to `AutomationRunsStore.prune` at end-of-run; the prune predicate itself was already wired in the previous commit.

## Out of scope

- Webhook / event triggers — the manifest's `trigger` shape will be expanded later but only `kind: 'cron'` is wired in this issue.
- Pinned data during builder iteration. Filed separately.
- Available-tools grounding block in the system prompt. Filed separately.
- Cross-app `ctx.invoke`. Intra-app only here.
- Per-run-node DAG visualisation beyond a flat timeline list (Promise.all batching surfaces via `batch_id` grouping, not a rendered graph).
- Token cost rollups across runs / UI cost dashboards.

## Verification

- `bun run test` — 255/255 in runtime-core (new 9-case `AutomationRunsStore` suite + existing 246).
- `bun run typecheck` — 16/16 packages clean.
- Lint + format clean (oxlint + oxfmt).
- Lazy file-creation behavior asserted: `automations.sqlite` is absent on disk until the first method call (`insertRun`); test inspects `fs.existsSync` both before and after.
- Migration ladder is independent of the gateway DB ladder and idempotent across reopens (verified with `openAutomationsDb` x2 + `PRAGMA user_version`).
