# issue-70 — automations: prompt-authored, cron-scheduled deterministic actions

GitHub issue: [#70](https://github.com/srikanth235/centraid/issues/70)

## Checklist

- [x] `AutomationManifest` schema + validator (cron expr, action safety, recursion guard)
- [x] `AutomationStore` mirror table + `gateway-db` migration v1 → v2
- [x] Scaffolding: per-app `automations/` folder
- [x] Automation handler runner with `ctx.tool` / `ctx.agent` surface
- [x] Mock-LLM HTTP server (local path) — Anthropic Messages + OpenAI streaming
- [x] Local automation runner orchestrator (codex/claude subprocess per fire)
- [x] `centraid run-automation <appId> <name>` CLI subcommand
- [x] OS scheduler glue (launchd / Task Scheduler / systemd) + reconcile-on-startup
- [x] Openclaw `centraid-mock` provider plugin
- [x] Openclaw cron registration + reconciliation via `callGatewayTool`
- [x] Builder agent system-prompt update for automations
- [x] App-templates example automation
- [x] Desktop UI per-app automations panel + IPC
- [x] Unit tests across packages, typecheck clean

## What changed

**`AutomationManifest` schema + validator (cron expr, action safety, recursion guard).** New `packages/runtime-core/src/automation-manifest.ts` defines the on-disk JSON shape: `prompt`, `schedule` (5-field cron), `action` (bare `.js` filename, no path traversal), `requires.{mcps,tools,model}`, `costEstimate`, `generated`. `validateManifest` enforces structural shape + cron-field regex + filename safety. Critical: `requires.model` starting with `centraid-mock/` is rejected with `mock_model_disallowed` — pointing `ctx.agent` back at our own mock provider would recurse into the StreamFn that's currently executing the handler.

**`AutomationStore` mirror table + `gateway-db` migration v1 → v2.** New table `automations(app_id, name, prompt, cron_expr, enabled, manifest_json, created_at, updated_at)` with composite primary key `(app_id, name)` lives in `centraid-gateway.sqlite` alongside `users`, `user_prefs`, `chat_sessions`, `chat_messages`. Migration added at index 1 of `MIGRATIONS` in `gateway-db.ts`. `AutomationStore` exposes `upsert/get/listByApp/listAll/setEnabled/remove/removeByApp` with manifest re-parse on read so callers get typed `AutomationRow`. The host scheduler (openclaw cron remote, OS scheduler local) owns runtime telemetry; this table is the registration record + reconciliation source-of-truth.

**Scaffolding: per-app `automations/` folder.** `scaffoldProject` in `packages/builder-harness/src/scaffold.ts` now creates `automations/` next to `queries/`, `actions/`, `migrations/`. The generated `actions/<name>.js` handler still lives under `actions/` so author-side tooling stays uniform — only manifests are folder-scoped. README scaffold brief documents the new convention.

**Automation handler runner with `ctx.tool` / `ctx.agent` surface.** Two new files in `runtime-core`: `worker/automation-runner.ts` (the worker entry) and `automation-handler-runner.ts` (the parent-side orchestrator). The worker exposes `db` (same DbCall proxy idiom as `worker/runner.ts`), `log`, and `ctx.{tool, agent, abortSignal}`. Cold-start amortization comes from per-microtask **batching**: `ctx.tool` calls queued during the same microtask checkpoint collapse into a single `tool-batch` message to the parent, so a `Promise.all([ctx.tool(a), ctx.tool(b), ctx.tool(c)])` produces one host agent turn instead of three. `ctx.agent` is treated as a distinct turn shape (constrained inference, not tool dispatch) — it flushes pending tool batches first, then runs as its own one-shot turn. The parent-side runner takes injected `toolDispatcher` + `agentDispatcher` callables so runtime-core stays transport-agnostic; the local-side `@centraid/agent-runtime` and the openclaw plugin each wire their own. Timeout is cooperative: an `abort` message lands first, then a hard `worker.terminate()` 2s later. The system-prompt update in `builder-harness` teaches the builder agent how to recognize automation prompts and emit a manifest + handler pair.

**Mock-LLM HTTP server (local path) — Anthropic Messages + OpenAI streaming.** `packages/agent-runtime/src/mock-llm-server.ts` stands up an ephemeral HTTP server on 127.0.0.1 with a random port per fire. Bearer-token-as-dispatch-id correlation: every authorized request carries `Authorization: Bearer centraid-mock-<dispatchId>`. The server speaks both wire formats — `POST /v1/messages` (Anthropic streaming SSE for `claude -p`) and `POST /v1/chat/completions` (OpenAI streaming for `codex exec`). Callers stage one turn per dispatch via `stageTurn(dispatchId, {toolUses, text, stopReason})`; tool_result blocks that arrive in subsequent CLI requests are extracted from both protocols and routed to a caller-supplied `onToolResults` callback. Unstaged dispatches get 503 (fail loudly rather than fabricate a response). Test coverage spans bearer auth, both protocol streaming responses for tool_use turns, end_turn acks, and tool_result extraction from both protocol shapes.

**Local automation runner orchestrator (codex/claude subprocess per fire).** `packages/agent-runtime/src/run-automation-local.ts` is the glue between the manifest, the mock-LLM server, the worker-isolated handler runner, and `claude -p` / `codex exec` subprocesses. Each `ctx.tool` batch from the worker triggers: mint dispatch token → stage a `tool_use` turn carrying every call in the batch → spawn a fresh CLI subprocess pointed at the mock's base_url with the bearer token injected (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` for claude; per-invocation `CODEX_HOME` materialized through `materializeCodexHome()` for codex) → wait for tool_result blocks via the mock's `onToolResults` callback → stage an `end_turn` ack so the CLI exits cleanly → map captured results back to the original call order. `ctx.agent` calls route through the same CLI binaries against the user's REAL provider (no mock), with optional JSON schema enforcement post-hoc. The `spawnCli` is a documented injection seam so tests can drive the orchestrator without real CLIs installed. Issue #70's spike items (whether `-c model_providers.X.base_url=...` actually takes effect, whether `stream-json` carries tool events, MCP-level approval bypass) are called out as TODOs at the top of the file.

**`centraid run-automation <appId> <name>` CLI subcommand.** Extended `packages/agent-runtime/src/centraid-cli.ts` with a new top-level subcommand the OS scheduler invokes. Parses `--runner codex|claude-code` and `--timeout-ms <n>` flags, then calls `runAutomationLocal` with the cwd treated as the app dir. Stdout is the structured `AutomationRunRecord` JSON (run id, duration, status, batch / agent-call counts); stderr is a human-friendly one-line summary and the mock-llm log stream. Exit code 0 on success, 1 on handler failure, 2 on bad usage.

**OS scheduler glue (launchd / Task Scheduler / systemd) + reconcile-on-startup.** `packages/agent-runtime/src/os-scheduler.ts` is a per-platform shim with pure-function artifact generators (testable without touching the OS scheduler) plus a shell-out layer factored through an injectable `execShell`. macOS gets a launchd LaunchAgent plist under `~/Library/LaunchAgents/com.centraid.<appId>.<name>.plist` with `StartCalendarInterval` entries derived from the 5-field cron expression (expanded into one entry per `*/N` step, range, or list). Linux gets a systemd user `.service` + `.timer` pair under `~/.config/systemd/user/` with an `OnCalendar=` line. Windows gets a Task Scheduler task via `schtasks /Create` — only the "every N minutes" and "daily at HH:MM" patterns are supported in v1, anything else throws so the desktop UI can surface "not representable." `register/unregister/list` are the public verbs; `currentPlatform()` returns `"unsupported"` on anything else and every public verb throws `UnsupportedOsSchedulerError` (the issue #69 "no NullScheduler" rule). Tests cover the cron-to-launchd / cron-to-systemd / cron-to-schtasks translators and the artifact-text shape.

**Openclaw `centraid-mock` provider plugin.** `packages/openclaw-plugin/src/lib/automations-provider.ts` registers an in-process provider whose `createStreamFn` runs the automation handler instead of calling a real LLM. The wiring lives in the plugin entry: `registerAutomationsProvider(api, {resolveAppDir})` registers the provider on `register()`, and `gateway_start` binds `setOpenClawConfig(api.config)` so the StreamFn can later route `ctx.agent` through `prepareSimpleCompletionModelForAgent`. When openclaw cron fires a `centraid-mock/run-automation` agent turn, the StreamFn parses `<<<centraid:appId:name>>>` from the prompt, loads `<appId>/automations/<name>.json` + `<appId>/actions/<name>.js`, runs the handler via `runAutomationHandler`, and emits a final `AssistantMessage` with non-empty text content and `stopReason: 'stop'` (which is what openclaw's terminal-outcome classifier requires to log the cron run successful). `ctx.tool` routes through `callGatewayTool(name, {}, args)` — the harness MCP routing, before-tool hooks, and audit log come for free. `ctx.agent` uses the user's **real** provider (from `manifest.requires.model`) via the simple-completion runtime — the recursion-guard in the manifest validator (rejecting `requires.model = centraid-mock/*`) prevents infinite loops.

**Openclaw cron registration + reconciliation via `callGatewayTool`.** `packages/openclaw-plugin/src/lib/automations-cron.ts` provides `upsertCronJob` / `removeCronJob` / `listCentraidCronJobs` / `reconcileAutomationCron`. Each automation maps to one openclaw cron job named `centraid:<appId>:<name>` with `payload.kind = "agentTurn"`, `model = "centraid-mock/run-automation"`, the manifest's prompt as the dispatch sentinel, the manifest's `requires.tools` as the `toolsAllow` list, and `sessionTarget: "isolated"`. Registration goes through `callGatewayTool("cron.add", ...)` (not the plugin-cron API which only accepts `kind: "systemEvent"` — see the issue's "Why this isn't Option A" section). The `gateway_start` hook calls `reconcileAutomationCron(automationStore)` which diffs the centraid SQLite mirror against openclaw's `cron.list` output: missing cron jobs get added, existing ones get re-issued via `cron.update` (so an enabled-flag toggle or schedule change made while the plugin was offline still propagates), and centraid-prefixed jobs without a matching SQLite row get removed as zombies. The whole pass soft-fails so a transient cron-store error doesn't block plugin boot.

**Builder agent system-prompt update for automations.** Added an "### Automations" section to `packages/builder-harness/src/system-prompt.ts` that teaches the agent (1) to recognize "every N units, do X" prompts as automations, (2) the manifest schema verbatim, (3) the `AutomationHandler` JSDoc contract, (4) the `ctx.tool` / `ctx.agent` semantics with explicit batching guidance ("`Promise.all([ctx.tool(...), ctx.tool(...)])` = 1 turn, sequential awaits = N turns"), (5) the prohibition on `ctx.fetch` and on routing `requires.model` at the mock provider. Folder layout docs in the prompt updated to include `automations/<name>.json`. `AutomationHandler` was added to the public type exports in `runtime-core/src/types.ts` and re-exported from `@centraid/openclaw-plugin` so the JSDoc `@type` references resolve.

**App-templates example automation.** Added `weekly-recap.json` manifest + `actions/weekly-recap.js` handler + `migrations/0002_recaps.sql` to the **journal** template. The recap fires Sundays at 8 PM, pulls the last 7 days of journal entries, asks `ctx.agent` for a `{summary, mood}` structured response (illustrates the JSON-schema runtime-failure-detector pattern), and writes one row to `journal_recaps`. Template manifest auto-regenerated by `build-manifest.mjs` — both new files appear in `manifest.json#templates[journal].files`.

**Follow-up: ensure automations/ lands on both scaffold and clone paths.** `scaffoldProject` was already creating `automations/`, but `cloneTemplate` only copied what the template source had — so cloning hydrate or todos (which don't ship automations) left the agent with no canonical drop target for cron-scheduled manifests. Fixed by mkdir-ing the canonical subdir list (queries/actions/migrations/automations) idempotently in `cloneTemplate` after `copyDir`, and refactoring `scaffoldProject` to use the same list (kept in sync between the two files). Both paths also drop a brief `automations/README.md` so empty-dir file viewers don't hide it and the agent has an in-folder pointer to the manifest shape — scaffold's is the full spec, clone's is a short pointer that defers to the project README.

**Desktop UI per-app automations panel + IPC.** Added four IPC channels (`AUTOMATIONS_LIST`, `AUTOMATIONS_RUN_NOW`, `AUTOMATIONS_SET_ENABLED`, `AUTOMATIONS_DELETE`) to `preload.ts` and the main-process handler module `apps/desktop/src/main/ipc.ts`. The list handler opens a lazy `AutomationStore` against the same `localRuntimeGatewayDb()` the embedded runtime uses. Run-now invokes `runAutomationLocal` directly in-process for fast iteration (sidesteps the OS scheduler). Renderer-side `CentraidApi` type definitions were extended with `CentraidAutomationRow` / `CentraidAutomationRunResult` and the four corresponding method signatures. The DOM widget layer (sidebar pill activation, per-app panel rendering) is deferred to a follow-up PR — the IPC + types are what's load-bearing for this issue.

**Unit tests across packages, typecheck clean.** Final test run: 222 in runtime-core, 64 in agent-runtime, 21 in openclaw-plugin, 4 in chat-harness, 1 in builder-harness (no test changes there yet) — 312 total, zero failures. Typecheck clean across 16 turbo packages. New test files added in this issue: `automation-manifest.test.ts`, `automation-store.test.ts`, `mock-llm-server.test.ts`, `os-scheduler.test.ts`. Worker-thread integration testing of the automation handler runner is deferred to e2e flows — the worker boundary is hard to drive without compiled output and the dispatcher contracts are well-typed.

## Out of scope (per issue)

- Secret management (host owns it).
- OAuth broker for third-party services (host owns it).
- Hand-editing generated action JS — re-prompting regenerates it.
- `ctx.fetch`, `ctx.cli`, `ctx.llm` (pi-ai removed; `ctx.agent` replaces).
- Multi-turn `ctx.agent` with tool use surfaced to JS.
- Mobile-side automations.
- TypeScript authoring for automations.
- Cross-app automation dependencies.

## Verification

- `npm test` clean across all packages (312 tests passing, 0 failures).
- `npm run typecheck` clean across all 16 turbo packages.
- `npm run lint` clean (oxlint + oxfmt all pass via pre-commit hook).

## Out-of-scope follow-ups

Items that the design depends on but require live external systems to
verify (called out per issue spike list):

- **`codex exec -c model_providers.X.base_url=...` actually takes
  effect.** Documented as the primary spike item in
  `run-automation-local.ts`. Fallback path (materialized CODEX_HOME)
  already used in the codex branch of `defaultSpawnCli`.
- **`claude -p --output-format stream-json` emits tool_use AND
  tool_result events.** Pin the claude version once verified.
- **Non-interactive permission bypass also bypasses MCP-level
  prompts**, not just CLI-level.
- **`callGatewayTool` works as a loopback call from inside the
  openclaw plugin process.** Confirmed via in-tree precedent (the
  openclaw cron tool itself uses this); end-to-end smoke test still
  TBD.
- **`augmentModelCatalog` + `resolveDynamicModel` pass the
  `agents.defaults.models` allowlist check** at cron-fire time.

The DOM widget layer for the desktop automations panel (sidebar entry
activation, list rendering, run-now button wiring) is a follow-up PR.
The IPC channels + types here are what's load-bearing for the rest of
the architecture.
