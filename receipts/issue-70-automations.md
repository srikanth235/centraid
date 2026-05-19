# issue-70 — automations: prompt-authored, cron-scheduled deterministic actions

GitHub issue: [#70](https://github.com/srikanth235/centraid/issues/70)

## Checklist

- [ ] `AutomationManifest` schema + validator (cron expr, action safety, recursion guard)
- [ ] `AutomationStore` mirror table + `gateway-db` migration v1 → v2
- [ ] Scaffolding: per-app `automations/` folder
- [ ] Automation handler runner with `ctx.tool` / `ctx.agent` surface
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

In progress — see commits anchored at `(#70)` on this branch for the
current slice. The receipt will be filled in fully when implementation
lands.

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
