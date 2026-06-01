# issue-158 — stream automation runs end-to-end

GitHub issue: [#158](https://github.com/srikanth235/centraid/issues/158)

Automations run on the same agent engines as chat, but their runs are
**not streamed** — `run-now` returns `202 {runId}` and detaches, the run
viewer loads the node timeline once, and the standing-order panel polls
the ledger every 1.5s. Chat, by contrast, streams token-level
`ChatStreamEvent`s over SSE.

This issue streams automation runs end-to-end with **full chat parity**
(the same `ChatStreamEvent` union, nested per run-node) using a
**ledger-tail hybrid** (durable nodes + ephemeral token deltas). It also
captures a **priority prerequisite**: codex `ctx.tool` couldn't reach the
user's MCP servers, undercutting the "ride on top of the user's
claude/codex/openclaw" model.

v0 pre-release: no backward compatibility, no migrations.

## Checklist (suggested sequence)

- [x] **1 — codex `ctx.tool` `-c` MCP fix** (priority prerequisite; small,
      unblocks the MCP value prop)
- [ ] **2 — Streaming Phase 1**: live node lifecycle (runner-agnostic
      foundation; durable timeline, late-join, parallel lanes)
- [ ] **3 — Streaming Phase 2**: per-runner `ctx.agent` token parity
      (claude SDK → codex app-server → openclaw ACP)
- [ ] **4 — Streaming Phase 3**: mock per-call tool timing

## What changed

### 1 — codex `ctx.tool` `-c` MCP fix

Deterministic `ctx.tool` dispatch routed codex through a redirected
`CODEX_HOME` (`materializeCodexHome`), which writes a bare `config.toml`
declaring only the mock provider — and thereby **drops** the user's
`[mcp_servers.*]`. So during the deterministic tool turn, the agent could
not reach the user's MCP servers, defeating the "ride on top" model.

- New `codexProviderOverrideArgs(provider)` in `codex-provider-config.ts`
  renders `-c key=value` provider overrides (model_provider + the
  `[model_providers.<id>]` table) as TOML basic strings. These layer on
  top of the user's real `~/.codex/config.toml` instead of replacing it,
  so the user's MCP servers survive. Honored by `codex exec` since
  codex-cli 0.128.0 (our pinned `MIN_VERSIONS` minimum) — POC-proven.
- `run-automation-cli-spawn.ts` (the `ctx.tool` codex path) now spawns
  `codex exec` with those overrides and **no `CODEX_HOME` redirect**. The
  bearer token still flows via env under `env_key`, never on disk.
- Corrected the stale `codex-app-server.ts` comment claiming app-server
  doesn't honor `-c` (it does in 0.128.0). The chat custom-provider path
  still uses `materializeCodexHome`; moving it to `-c` (to preserve MCP in
  chat too) is noted as a follow-up needing a live-turn validation.

`materializeCodexHome` is retained — still used by the chat app-server
custom-provider path and `host-tools.ts`.

## Out of scope (this commit)

- Streaming Phases 1–3 (live node lifecycle, `ctx.agent` token parity,
  mock per-call tool timing) land in follow-up commits on this branch.
- Moving the chat custom-provider codex path off `materializeCodexHome`
  onto `-c` overrides — noted in the `codex-app-server.ts` comment, needs
  a live custom-provider chat turn to validate before flipping.

## Verification

- `@centraid/agent-runtime`: `codex-provider-config.test.ts` 12 → 15 tests
  pass (3 new pinning `codexProviderOverrideArgs` output, env_key omission,
  and that the API key is never an arg). Package typecheck clean.
- Repo `format:check` + `lint` clean.
