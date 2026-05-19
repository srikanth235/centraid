# issue-70 — automations: prompt-authored, cron-scheduled deterministic actions

GitHub issue: [#70](https://github.com/srikanth235/centraid/issues/70)

## Checklist

- [x] `AutomationManifest` schema + validator (cron expr, action safety, recursion guard)
- [x] `AutomationStore` mirror table + `gateway-db` migration v1 → v2
- [x] Scaffolding: per-app `automations/` folder
- [x] Automation handler runner with `ctx.tool` / `ctx.agent` surface
- [ ] Mock-LLM HTTP server (local path) — Anthropic Messages + OpenAI streaming
- [ ] Local automation runner orchestrator (codex/claude subprocess per fire)
- [ ] `centraid run-automation <appId> <name>` CLI subcommand
- [ ] OS scheduler glue (launchd / Task Scheduler / systemd) + reconcile-on-startup
- [ ] Openclaw `centraid-mock` provider plugin
- [ ] Openclaw cron registration + reconciliation via `callGatewayTool`
- [ ] Builder agent system-prompt update for automations
- [ ] App-templates example automation
- [ ] Desktop UI per-app automations panel + IPC
- [ ] Unit tests across packages, typecheck clean

## What changed

**`AutomationManifest` schema + validator (cron expr, action safety, recursion guard).** New `packages/runtime-core/src/automation-manifest.ts` defines the on-disk JSON shape: `prompt`, `schedule` (5-field cron), `action` (bare `.js` filename, no path traversal), `requires.{mcps,tools,model}`, `costEstimate`, `generated`. `validateManifest` enforces structural shape + cron-field regex + filename safety. Critical: `requires.model` starting with `centraid-mock/` is rejected with `mock_model_disallowed` — pointing `ctx.agent` back at our own mock provider would recurse into the StreamFn that's currently executing the handler.

**`AutomationStore` mirror table + `gateway-db` migration v1 → v2.** New table `automations(app_id, name, prompt, cron_expr, enabled, manifest_json, created_at, updated_at)` with composite primary key `(app_id, name)` lives in `centraid-gateway.sqlite` alongside `users`, `user_prefs`, `chat_sessions`, `chat_messages`. Migration added at index 1 of `MIGRATIONS` in `gateway-db.ts`. `AutomationStore` exposes `upsert/get/listByApp/listAll/setEnabled/remove/removeByApp` with manifest re-parse on read so callers get typed `AutomationRow`. The host scheduler (openclaw cron remote, OS scheduler local) owns runtime telemetry; this table is the registration record + reconciliation source-of-truth.

**Scaffolding: per-app `automations/` folder.** `scaffoldProject` in `packages/builder-harness/src/scaffold.ts` now creates `automations/` next to `queries/`, `actions/`, `migrations/`. The generated `actions/<name>.js` handler still lives under `actions/` so author-side tooling stays uniform — only manifests are folder-scoped. README scaffold brief documents the new convention.

**Automation handler runner with `ctx.tool` / `ctx.agent` surface.** Two new files in `runtime-core`: `worker/automation-runner.ts` (the worker entry) and `automation-handler-runner.ts` (the parent-side orchestrator). The worker exposes `db` (same DbCall proxy idiom as `worker/runner.ts`), `log`, and `ctx.{tool, agent, abortSignal}`. Cold-start amortization comes from per-microtask **batching**: `ctx.tool` calls queued during the same microtask checkpoint collapse into a single `tool-batch` message to the parent, so a `Promise.all([ctx.tool(a), ctx.tool(b), ctx.tool(c)])` produces one host agent turn instead of three. `ctx.agent` is treated as a distinct turn shape (constrained inference, not tool dispatch) — it flushes pending tool batches first, then runs as its own one-shot turn. The parent-side runner takes injected `toolDispatcher` + `agentDispatcher` callables so runtime-core stays transport-agnostic; the local-side `@centraid/agent-runtime` and the openclaw plugin each wire their own. Timeout is cooperative: an `abort` message lands first, then a hard `worker.terminate()` 2s later. The system-prompt update in `builder-harness` teaches the builder agent how to recognize automation prompts and emit a manifest + handler pair.

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

Pending per-slice; receipt updated as commits land.
