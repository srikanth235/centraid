# issue-80 — per-app automations.sqlite with run audit, run_nodes, ctx.state, and richer manifest

GitHub issue: [#80](https://github.com/srikanth235/centraid/issues/80)

## Checklist

- [x] Per-app `automations.sqlite` store (runs, run_nodes, state) with lazy file creation + own migration ladder
- [x] Manifest reshape: `trigger:{kind,expr}` canonical with legacy `schedule` back-compat, `outputSchema`, `onFailure`, `history.keep`
- [x] Instrument `runAutomationHandler` to commit `runs` + `run_nodes` rows around handler execution (incl. batch_id, attempt)
- [x] `ctx.state.{get,set}`, `ctx.runs.{last,list}`, `ctx.invoke(name, {input})` against the per-app file
- [x] `opts.retry: { max, backoff }` and `opts.onError: 'fail'|'continue'` on `ctx.tool`
- [x] `onFailure` dispatch (incl. timeout/crash) with depth-3 recursion cap
- [x] `outputSchema` validation of handler return; failures land in `runs.error`, `runs.ok=0`
- [x] Retention pruning at end-of-run per `history.keep`
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

**Instrument `runAutomationHandler` to commit `runs` + `run_nodes` rows around handler execution (incl. batch_id, attempt).** The runner now takes an optional `runsStore: AutomationRunsStore` plus `triggerKind`, `input`, `parentRunId`, `outputSchema`, and `history`. On run start it writes the `runs` row with `trigger_kind` defaulting to `'scheduled'`. Every `ctx.tool` batch from the worker mints one batch_id when N > 1 (solo calls get `batchId: null` so the timeline UI can tell them apart) and one `ordinal` per call; the dispatcher result lands as a `run_nodes` row with `attempt: 1`. Every `ctx.agent` call is its own ordinal as a separate `kind: 'agent'` row. At end-of-run the `runs` row is updated with `ok`, `error`, `summary`, `output_json`, and retention runs against the manifest's `history.keep`. Args + output JSON above 64 KB are replaced with a `{_truncated: true, bytes, head}` envelope so a tool that returns 50 KB of PRs serialized per fire doesn't balloon the file.

**`ctx.state.{get,set}`, `ctx.runs.{last,list}`, `ctx.invoke(name, {input})` against the per-app file.** Worker side: each method flushes any pending tool batch first (these are different turn shapes so they don't ride along), then round-trips through new `state`/`runs`/`invoke` worker→parent message types. Parent side: `state.get` returns the JSON-parsed value (falling back to the raw string if it isn't valid JSON), `state.set` accepts any JSON-serializable value (undefined → null), `state.delete` is a single-row drop. `runs.last({name?, status?})` and `runs.list({name?, status?, since?, limit?})` query the per-app store; the in-progress self-run is filtered out so the handler doesn't see its own incomplete row. `ctx.invoke` routes through a new host-supplied `invokeDispatcher` callback the handler-runner takes as a constructor parameter — runtime-core can't load and execute a sibling automation by name, but it can hand the child run's parent_run_id back via the callback so the host's recursive `runAutomationHandler` call links the audit chain.

**`opts.retry: { max, backoff }` and `opts.onError: 'fail'|'continue'` on `ctx.tool`.** The optional third argument to `ctx.tool` rides along in the worker's batch message. The parent's retry loop is sequential per failing call (the worker batches by microtask, retries don't naturally fit) and writes one `run_nodes` row per attempt sharing the call's ordinal with ascending `attempt`. Default backoff is exponential with a 5s cap on the inter-attempt delay; `backoff: 'fixed'` is also accepted. `onError: 'continue'` swallows the final failure and resolves the handler's Promise with `undefined`; the audit row still records `ok=0` so the run timeline shows what happened.

Outsized growth of `automation-handler-runner.ts` is held in check by a new `automation-handler-audit.ts` (truncation, retention, envelope extraction, node-row writers) and `automation-handler-ctx.ts` (the `ctx.state` / `ctx.runs` / `ctx.invoke` message handlers + retrying tool-batch dispatcher). The runner itself just owns Worker lifecycle, the timeout/abort plumbing, and the message router.

**`onFailure` dispatch (incl. timeout/crash) with depth-3 recursion cap.** Both hosts now own the failure cascade. `packages/agent-runtime/src/run-automation-local.ts` (local OS-scheduler path) and `packages/openclaw-plugin/src/lib/automations-provider.ts` (remote openclaw cron path) each opt-in to the new ctx surface by constructing an `AutomationRunsStore` keyed off the app's data dir, wiring an `invokeDispatcher` that recursively re-enters the host (intra-app only, per issue #80 § Out), and inspecting the handler outcome at end-of-fire. When `outcome.ok === false` and `manifest.onFailure` names a sibling automation, the host fires it with `triggerKind: 'on_failure'`, `parentRunId` linked to the failed run, and an input payload carrying the failed runId, automation name, error message, and node summary (ordinal/attempt/kind/name/ok/error). A `failureDepth` counter threaded through the recursive call refuses to dispatch beyond depth 3, logging an `aborted at depth N (cap=3)` warning instead — that's the issue's "Open question — onFailure recursion" resolution. Timeout-triggered failures and worker crashes go through the same path because `runAutomationHandler` always returns an outcome with `ok=false`/`error` set, regardless of the failure mode.

**`outputSchema` validation of handler return; failures land in `runs.error`, `runs.ok=0`.** Wired in the previous commit's `runAutomationHandler` change. After the handler returns successfully, the runner extracts the `{summary, output}` envelope and validates `output` against `manifest.outputSchema` via `validateOutputAgainstSchema`. A validation failure flips the outcome to `ok=false` with a `outputSchema validation failed: <reason>` error message; the audit row sees `ok=0` and the error. Five new agent-runtime tests cover the local path end-to-end including this rejection.

**Retention pruning at end-of-run per `history.keep`.** Also threaded in the previous commit. The runner reads `manifest.history.keep` and calls `AutomationRunsStore.prune(name, { count | days | errorsOnly | all })` after `finishRun`. CASCADE on the `run_nodes` foreign key drops the orphaned node rows so the file stays bounded. Default `{count: 100}` applies when the manifest doesn't declare a policy.

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
