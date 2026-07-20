# Runners (coding-agent harnesses)

A **runner** is a coding-agent CLI Centraid can drive to produce a turn — `codex`, `claude-code`, `gemini`, `qwen`, `opencode`, `grok`, `kimi`, or a custom `acp` binary. The user-facing ids (`RunnerKind`) are stable; how we talk to them is not.

## Supported harnesses

| Kind | Label | `defaultBin` | ACP launch | Min version | Install |
| --- | --- | --- | --- | --- | --- |
| `codex` | Codex | `codex` | via `@agentclientprotocol/codex-acp` | 0.128.0 | Codex CLI + `codex login` |
| `claude-code` | Claude Code | `claude` | via `@agentclientprotocol/claude-agent-acp` | 2.1.126 | Claude Code + `claude login` |
| `gemini` | Gemini CLI | `gemini` | `--acp` | 0.50.0 | `npm i -g @google/gemini-cli` |
| `qwen` | Qwen Code | `qwen` | `--acp` | 0.20.0 | `npm i -g @qwen-code/qwen-code` |
| `opencode` | opencode | `opencode` | `acp` | 1.18.4 | `npm i -g opencode-ai` + `opencode auth login` |
| `grok` | Grok | `grok` | `agent stdio` | 0.2.106 | `npm i -g @xai-official/grok` (paid SuperGrok / X Premium+) |
| `kimi` | Kimi | `kimi` | `acp` | 1.17.0 | `uv tool install kimi-cli` + `kimi login` |
| `acp` | Custom ACP agent | — | user-supplied `extraArgs` | — | configure `binPath` in Settings → Agents |

Per-kind notes worth not rediscovering:

- **opencode** — never pass `--mdns` (ours or a user's `extraArgs`): it defaults the listen hostname to `0.0.0.0`, publishing an unauthenticated code-execution agent to the LAN. opencode also reports the richest usage of any kind (tokens including cache read/write, plus a server-priced USD cost); the generic reader in the ACP backend picks it up with no kind-specific code.
- **grok** — xAI's first-party Grok Build CLI (Apache-2.0). `0.2.106`, not `0.2.11`: the two are only adjacent under a string sort, and the older one predates ACP entirely. A paid subscription is required, which is why the install hint says so — otherwise an installed-but-failing runner looks like our bug.
- **kimi** — the `acp` **subcommand**, not the deprecated `--acp` flag. They are not synonyms: the flag is single-session with no session list/load, and we resume via `session/load`. Kimi CLI is a Python tool (`uv`, not npm) — the only kind whose install hint isn't an `npm i -g`. The project is mid-rename to "Kimi Code" (new repo, Apache-2.0 → MIT), but the `kimi` binary and `kimi acp` invocation survive it.

## One integration path: ACP

Since issue #479 there is **exactly one** turn-driving transport: the generic Agent Client Protocol client in [`packages/agent-runtime/src/backends/acp/backend.ts`](../packages/agent-runtime/src/backends/acp/backend.ts). The bespoke `runCodexTurn` (codex `app-server` JSON-RPC) and `runClaudeTurn` (in-process `@anthropic-ai/claude-agent-sdk`) backends are **deleted**. Anything that branches on runner kind above the registry is a bug.

Runners come in two flavours, and the difference is confined to *how the ACP-speaking process is launched*:

| Flavour | Kinds | Launch |
| --- | --- | --- |
| Speaks ACP natively | `gemini`, `qwen`, `opencode`, `grok`, `kimi`, custom `acp` | spawn the CLI with its ACP flag or subcommand (`--acp`, `acp`, `agent stdio`) |
| Needs an adapter | `codex`, `claude-code` | spawn the official first-party adapter, which drives the CLI underneath |

Neither Claude Code nor Codex has an ACP mode of its own, so each is driven through its Apache-2.0 adapter — `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`. Both are **pinned dependencies** of `@centraid/agent-runtime`, resolved from `node_modules` by [`adapter-bin.ts`](../packages/agent-runtime/src/backends/acp/adapter-bin.ts). Never `npx -y` an adapter at run time: that puts a network fetch and an unpinned version in the middle of every turn and every test.

`defaultBin` always names the **user-facing CLI** (`claude`, `codex`), even for adapter-backed kinds. That is what the user installs and authenticates, what preflight probes with `--version`, and what the install hint talks about. The adapter is our implementation detail and is never surfaced.

Likewise, `RunnerPrefs.binPath` means **"the agent CLI"**, not "the process we spawn". For adapter-backed kinds it is forwarded through the adapter's own env var (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`) rather than used as the spawn target.

## Adding a new harness

One registry entry in [`registry.ts`](../packages/agent-runtime/src/registry.ts), plus its `RunnerKind` literal in `@centraid/app-engine`. Nothing else branches on the kind — `runTurn`, preflight, model enumeration, the gateway's status route, the daemon config validator, the providers console cards, and the per-subsystem pins all read the registry or the gateway's list. Adding `opencode`, `grok` and `kimi` needed exactly those two edits; this section is accurate because it was followed.

Two **cosmetic, optional** client-side lists exist. Neither gates anything — a kind absent from both still renders a complete card off the gateway's wire `label`/`version`/`hint`:

- `ACCENT_BY_KIND` in [`settingsProvidersData.ts`](../packages/client/src/react/shell/routes/settingsProvidersData.ts) — the card accent, defaulting to neutral. Accent only; do **not** vendor third-party icon artwork.
- `AGENT_RUNNER_KINDS` in [`screen-contracts.ts`](../packages/client/src/react/screen-contracts.ts) — "kinds this build knows by name". `AgentRunnerKind` is deliberately an open `string` (docs/protocol.md C1a), so this never validates or filters.

A natively ACP-speaking CLI:

```ts
const fooBackend = makeAcpBackend({
  kind: 'foo',
  label: 'Foo CLI',
  defaultBin: 'foo',
  acpArgs: ['--acp'],   // or a subcommand: ['acp'], ['agent', 'stdio'], …
  minVersion: { major: 1, minor: 0, patch: 0 },
  installHint: 'Install Foo CLI (`npm i -g foo`) and run `foo` once to authenticate.',
});
```

Omit `adapter` (the CLI is the ACP process), `enumerateModels` (models are an ACP session concern — the default returns `[]` and the picker stays on "Gateway default"), and `resolveModel` (capability tiers are Claude vocabulary).

A CLI that needs an adapter adds an `AcpAdapterSpec`:

```ts
const barBackend = makeAcpBackend({
  kind: 'bar',
  label: 'Bar',
  defaultBin: 'bar',          // the CLI the USER installs — preflight probes this
  acpArgs: [],                // the adapter is the process; no CLI flag
  minVersion: { major: 0, minor: 9, patch: 0 },
  installHint: 'Install Bar and run `bar login`.',
  adapter: {
    packageName: '@vendor/bar-acp',       // pinned dep; bin resolved from node_modules
    env: { BAR_HEADLESS: '1' },           // startup preset (no approval round-trips)
    binPathEnvVar: 'BAR_PATH',            // where RunnerPrefs.binPath lands
    sessionModeId: 'bypassPermissions',   // headless policy expressed as an ACP mode
  },
});
```

An adapter-backed kind also needs the adapter added with `bun add` in `packages/agent-runtime` (pinned dep, never a runtime `npx -y`). Either way, assert the launch config in `registry.test.ts` — `acpConfigFor` returns it without spawning anything, so the tests stay hermetic and need no real binary.

### Headless policy

Gateway turns have no approval UI wired to them, so a runner that prompts for permission deadlocks on the first file write. Centraid's own consent layer (vault grants, outbox) is the gate that matters. Every kind must therefore reach a non-interactive posture, expressed one of two ways:

- **launch env** — codex: `INITIAL_AGENT_MODE=agent-full-access` (equivalent to `approvalPolicy:'never'` + a full-access sandbox), applied at startup with no client round-trip.
- **session mode** — claude: `session/set_mode` with `bypassPermissions` once the session exists.

The claude adapter computes `ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX` at load and silently downgrades the mode when it is false. Running as root is the only case that trips it, so the backend opts in explicitly (`IS_SANDBOX=1`) **and emits a `notice`** rather than letting the user discover it as a mysteriously stalled tool call. Prefer running the gateway as a normal user.

As a backstop for agents that prompt anyway, the ACP client auto-allows the least-destructive `session/request_permission` option.

### Model pinning

ACP has no per-prompt model field. An agent advertises `configOptions` on the `session/new` / `session/load` result; the client pins one with `session/set_config_option { sessionId, configId, value }`. The model selector is the option whose `id` is `model` or whose `category` is `model`, and its values are **concrete provider model ids supplied by the agent** — we only ever echo back what it offered, so no model ids are hardcoded (`no-hardcoded-model-ids`).

Kinds whose picker offers capability tiers (`smart`/`balanced`/`fast`) set `resolveModel` to map a tier to the runtime's native alias before matching. When the agent advertises no model option, or offers nothing matching, the turn emits a `notice` — never a silent drop.

### Usage

`usage_update` carries only context-window `used`/`size` plus a **cumulative** `cost { amount, currency }`; the token breakdown rides on the `session/prompt` result as `PromptResponse.usage`. Both are cumulative per session, which equals per turn here because every turn spawns a fresh agent process whose counters start at zero.

The backend folds these into **one** `usage` event at the end of the turn, stamped with `model` and `provider`. Stamping the model is load-bearing: the repricing pipeline can only revisit ledger rows whose `items.model` is non-NULL. A cost is mapped to `costUsd` only when its ISO 4217 currency is `USD`; otherwise it is withheld rather than mislabelled.

### Vault tools

`vault_sql` / `vault_invoke` / `vault_content` reach the agent as a **real MCP server over loopback HTTP**, named in the `mcpServers` array of `session/new` / `session/load` ([`vault-mcp-server.ts`](../packages/agent-runtime/src/backends/acp/vault-mcp-server.ts)). This replaces the retired per-CLI wiring (a Claude in-process MCP server; codex `dynamicTools`) with one mechanism, so **every** kind gets vault access — including `gemini` and `qwen`, which never had it.

The client-hosted `type: "acp"` MCP transport would avoid the socket entirely, but it is flagged experimental in the spec and **neither** first-party adapter implements it (`mcpCapabilities.acp: false` in both). `mcpCapabilities.http` is what they do advertise, so HTTP it is. The wire entry is ACP's `McpServerHttp`: `{ type: 'http', name, url, headers: [{ name, value }] }` — both adapters map it identically (claude → `claude-agent-sdk` `mcpServers`, codex → a `[mcp_servers.*]` config entry with `http_headers`).

Because the endpoint serves owner-credentialed SQL plus the typed write path:

- it binds **127.0.0.1** on an ephemeral port, never `0.0.0.0`;
- every request must carry a per-turn 256-bit `Authorization: Bearer` token, compared in constant time, passed only through the `mcpServers` headers and never logged;
- it is closed — sockets included — in the turn's `finally`, before the child is torn down, on every path including abort.

The server is hand-rolled (a tools-only Streamable-HTTP surface: `initialize`, `ping`, `tools/list`, `tools/call`) rather than pulling in `@modelcontextprotocol/sdk`, which would add express, hono, cors and jose for one POST route. Tool names, descriptions and schemas still come verbatim from `vault-sql-tool.ts`, and the server is still called `centraid`, so prompts and skills naming `vault_sql` (or `mcp__centraid__vault_sql`) keep working.

An agent that surfaces its MCP calls as ACP `tool_call` updates already renders the call, so the backend suppresses its own `tool.start` / `tool.result` for it. Agents that keep MCP calls private get our events instead — either way the transcript shows the call exactly once.

A turn with no vault runners advertises **no** MCP server. An agent without `mcpCapabilities.http` gets a `vault_tools_unavailable` notice rather than silently losing the vault.

### Attachments

Mapped to ACP prompt content blocks by [`multimodal.ts`](../packages/agent-runtime/src/multimodal.ts), gated on the `promptCapabilities` the agent advertised in `initialize`. Text is baseline and ungated; images need `image`; audio needs `audio`; any other binary (PDFs, archives) rides an `EmbeddedResource`, which needs `embeddedContext`. Both first-party adapters advertise `{ image: true, embeddedContext: true }`, so images and PDFs reach codex and claude-code.

Note the field names are ACP's, not Anthropic's: `ImageContent { data, mimeType }`, **not** a nested `source.media_type`. Only attachments the agent genuinely can't accept (or that can't be read) produce an `attachment_unsupported` notice, and the notice **names** them.

### Auth

An agent that hasn't been signed in answers session creation with ACP's `AUTH_REQUIRED` — JSON-RPC code **-32000** (`RequestError.authRequired` in the SDK). This is the single most common first-run failure: 18 of the 31 agents in the ACP registry's daily probe return it. The backend detects the code and emits an error built from the registry's own `label` + `installHint`, so the per-kind "how do I log in" string lives in `registry.ts` with the kind's other metadata and never becomes a branch inside the ACP client.

## What ACP does not carry (known gaps)

Recorded honestly so nobody rediscovers them as bugs:

- **`ctx.agent` structured output.** The retired codex arm handed `call.json` to `codex exec --output-schema`. ACP has no equivalent, so `call.json` is now enforced by `coerceAgentAnswer` alone for every kind — which is what the claude arm always did.
- **Codex `localImage` paths.** The retired codex arm passed image attachments by path and let codex read them; ACP has no path-based image block, so images are base64-inlined into the prompt for every kind. Functionally equivalent, marginally more bytes on the wire.

## The one thing that is deliberately NOT ACP

Automation `ctx.tool` dispatch ([`run-automation-host-agent.ts`](../packages/agent-runtime/src/automation/run-automation-host-agent.ts)) still invokes the claude and codex CLIs **natively**. It is not a user-facing runner: it works by pointing a CLI at a per-fire mock LLM endpoint so the deterministic handler dictates every turn at ~0 real model tokens. An ACP agent drives its own model loop and exposes no base URL to redirect, so the mechanism cannot move to ACP — a fire pinned to any other kind fails loudly instead of silently running a different agent.

`ctx.agent`, by contrast, is a real billed turn and goes through the registry like everything else.
