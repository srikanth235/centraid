# Runners (coding-agent harnesses)

A **runner** is a coding-agent CLI Centraid can drive to produce a turn — `codex`, `claude-code`, `gemini`, `qwen`, `opencode`, `grok`, `kimi`, `copilot`, `cursor`, `kilo`, `cline`, `goose`, `auggie`, `vibe`, `droid`, `pi`, or a custom `acp` binary. The user-facing ids (`RunnerKind`) are stable; how we talk to them is not.

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
| `copilot` | GitHub Copilot CLI | `copilot` | `--acp` | 1.0.71 | `curl -fsSL https://gh.io/copilot-install \| bash` (or `brew install copilot-cli`) + `/login` (paid Copilot subscription) |
| `cursor` | Cursor | `cursor-agent` | `acp` | 2026.7.16 | `curl https://cursor.com/install -fsS \| bash` + `cursor-agent login` (paid Cursor plan) |
| `kilo` | Kilo | `kilo` | `acp` | 7.4.11 | `npm i -g @kilocode/cli` + `kilo auth` |
| `cline` | Cline | `cline` | `--acp` | 3.0.46 | `npm i -g cline` + `cline auth` |
| `goose` | goose | `goose` | `acp` | 1.43.0 | `brew install block-goose-cli` + `goose configure` |
| `auggie` | Auggie CLI | `auggie` | `--acp` | 0.33.0 | `npm i -g @augmentcode/auggie` + terminal sign-in (paid Augment plan) |
| `vibe` | Mistral Vibe | `vibe-acp` | *(none — dedicated binary)* | 2.21.0 | `uv tool install mistral-vibe` (Python 3.12+) + a Mistral API key |
| `droid` | Factory Droid | `droid` | `exec --output-format acp-daemon` | 0.175.1 | `curl -fsSL https://app.factory.ai/cli \| sh` (or `brew install --cask droid`) + browser sign-in or `FACTORY_API_KEY` |
| `pi` | pi | `pi-acp` | *(none — dedicated binary)* | 0.0.31 | `npm i -g pi-acp` + sign in |
| `acp` | Custom ACP agent | — | user-supplied `extraArgs` | — | configure `binPath` in Settings → Agents |

Per-kind notes worth not rediscovering:

- **opencode** — never pass `--mdns` (ours or a user's `extraArgs`): it defaults the listen hostname to `0.0.0.0`, publishing an unauthenticated code-execution agent to the LAN. opencode also reports the richest usage of any kind (tokens including cache read/write, plus a server-priced USD cost); the generic reader in the ACP backend picks it up with no kind-specific code.
- **grok** — xAI's first-party Grok Build CLI (Apache-2.0). `0.2.106`, not `0.2.11`: the two are only adjacent under a string sort, and the older one predates ACP entirely. A paid subscription is required, which is why the install hint says so — otherwise an installed-but-failing runner looks like our bug.
- **kimi** — the `acp` **subcommand**, not the deprecated `--acp` flag. They are not synonyms: the flag is single-session with no session list/load, and we resume via `session/load`. Kimi CLI is a Python tool (`uv`, not npm) — the only kind whose install hint isn't an `npm i -g`. The project is mid-rename to "Kimi Code" (new repo, Apache-2.0 → MIT), but the `kimi` binary and `kimi acp` invocation survive it.

- **copilot** — the npm package is `@github/copilot`, but the **binary is `copilot`**; those differ, unlike every other kind. Do not confuse it with `@github/copilot-language-server` (bin `copilot-language-server`), which is an editor-completion LSP, speaks no ACP, and is not a runner. `--acp` also takes a `--port` for TCP mode; we speak stdio, so `--port` must never be passed.
- **cursor** — versions are **CalVer** (`2026.07.16` = year.month.day), not semver. They flow through the same numeric `compareSemver` and order correctly, so no special case is needed — but do not "normalise" the major down to a semver-shaped number. The installer creates **both** `agent` and `cursor-agent` symlinks; we deliberately use `cursor-agent`, because a bare `agent` on PATH is a dangerously generic name.
- **goose** — Homebrew's formula is `block-goose-cli`, but the binary is `goose`. With no provider configured it fails `session/new` with an opaque **`-32603 Internal error`**, *not* ACP's `AUTH_REQUIRED`, so the backend's auth handling cannot turn it into an actionable message. Telling the user to run `goose configure` first is the only fix available from here — keep it in the hint.
- **vibe** — `defaultBin` is **`vibe-acp`**, a separate binary from `vibe`: the ACP server is its own entrypoint, not a mode of the main CLI. That is why `acpArgs` is empty. `vibe acp` does not exist. Like kimi it is a Python tool (`uv`), not npm.
- **pi** — `defaultBin` is **`pi-acp`**, a standalone ACP server binary (npm package `pi-acp`, bin `pi-acp`), not a mode of a `pi` CLI — the same shape as `vibe`, so `acpArgs` is empty too.
- **droid** — the ACP invocation is a **subcommand plus a value-bearing flag** (`exec --output-format acp-daemon`), not a mode flag; the three tokens are inseparable.
- **auggie / droid** — both ship self-updating CLIs, which can swap the binary out from under a running turn. Each carries launch env to suppress it (`AUGMENT_DISABLE_AUTO_UPDATE=1`; `DROID_DISABLE_AUTO_UPDATE=true` + `FACTORY_DROID_AUTO_UPDATE_ENABLED=false`).
- **Devin is deliberately NOT a kind.** Its `session/new` times out with no response at all in the ACP registry's daily probe, it reports its version as `0.0.0-dev`, and its own docs document no `acp` subcommand. It would ship as a broken runner. It remains reachable through the custom `acp` kind if someone wants to try it.

## One integration path: ACP

Since issue #479 there is **exactly one** turn-driving transport: the generic Agent Client Protocol client in [`packages/agent-runtime/src/backends/acp/backend.ts`](../packages/agent-runtime/src/backends/acp/backend.ts). The bespoke `runCodexTurn` (codex `app-server` JSON-RPC) and `runClaudeTurn` (in-process `@anthropic-ai/claude-agent-sdk`) backends are **deleted**. Anything that branches on runner kind above the registry is a bug.

Runners come in two flavours, and the difference is confined to *how the ACP-speaking process is launched*:

| Flavour | Kinds | Launch |
| --- | --- | --- |
| Speaks ACP natively | `gemini`, `qwen`, `opencode`, `grok`, `kimi`, `copilot`, `cursor`, `kilo`, `cline`, `goose`, `auggie`, `vibe`, `droid`, `pi`, custom `acp` | spawn the CLI with its ACP flag or subcommand (`--acp`, `acp`, `agent stdio`, `exec --output-format acp-daemon`) — or, for `vibe` and `pi`, its dedicated `vibe-acp` / `pi-acp` binary with no args at all |
| Needs an adapter | `codex`, `claude-code` | spawn the official first-party adapter, which drives the CLI underneath |

Native is the overwhelming majority and the cheap case; the adapter flavour exists only because Claude Code and Codex have no ACP mode of their own.

Both flavours read **one** launch-env field, `AcpTurnConfig.env` (`env` on the registry spec), applied to whatever process is spawned. A headless preset (codex's `INITIAL_AGENT_MODE`) and a self-update suppressor (auggie's `AUGMENT_DISABLE_AUTO_UPDATE`) are the same fact — "this kind needs these vars at launch" — so there is no adapter-only env path to keep in sync. It is applied *after* `agentSpawnEnv`, so a kind can override an inherited var but never the sanitized `PATH`.

Neither Claude Code nor Codex has an ACP mode of its own, so each is driven through its Apache-2.0 adapter — `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`. Both are **pinned dependencies** of `@centraid/agent-runtime`, resolved from `node_modules` by [`adapter-bin.ts`](../packages/agent-runtime/src/backends/acp/adapter-bin.ts). Never `npx -y` an adapter at run time: that puts a network fetch and an unpinned version in the middle of every turn and every test.

`defaultBin` always names the **user-facing CLI** (`claude`, `codex`), even for adapter-backed kinds. That is what the user installs and authenticates, what preflight probes with `--version`, and what the install hint talks about. The adapter is our implementation detail and is never surfaced.

Likewise, `RunnerPrefs.binPath` means **"the agent CLI"**, not "the process we spawn". For adapter-backed kinds it is forwarded through the adapter's own env var (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`) rather than used as the spawn target.

## Adding a new harness

One registry entry in [`registry.ts`](../packages/agent-runtime/src/registry.ts), plus its `RunnerKind` literal in `@centraid/app-engine`. Nothing else branches on the kind — `runTurn`, preflight, model enumeration, the gateway's status route, the daemon config validator, the providers console cards, and the per-subsystem pins all read the registry or the gateway's list. Adding `opencode`, `grok` and `kimi` needed exactly those two edits, and so did the later batch of eight (`copilot`, `cursor`, `kilo`, `cline`, `goose`, `auggie`, `vibe`, `droid`) — the only extra work was generalising the adapter-only launch-env field into the shared `env` above, because `auggie` and `droid` are the first *native* kinds that need launch env. This section is accurate because it was followed.

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
                        // or [] when the ACP server is its own binary (vibe)
  minVersion: { major: 1, minor: 0, patch: 0 },
  installHint: 'Install Foo CLI (`npm i -g foo`) and run `foo` once to authenticate.',
  env: { FOO_DISABLE_AUTO_UPDATE: '1' },   // optional; native kinds too
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
  env: { BAR_HEADLESS: '1' },   // same field as above — not adapter-specific
  adapter: {
    packageName: '@vendor/bar-acp',       // pinned dep; bin resolved from node_modules
    binPathEnvVar: 'BAR_PATH',            // where RunnerPrefs.binPath lands
    sessionModeId: 'bypassPermissions',   // headless policy expressed as an ACP mode
  },
});
```

An adapter-backed kind also needs the adapter added with `bun add` in `packages/agent-runtime` (pinned dep, never a runtime `npx -y`). Either way, assert the launch config in `registry.test.ts` — `acpConfigFor` returns it without spawning anything, so the tests stay hermetic and need no real binary.

### Headless policy

Gateway turns have no approval UI wired to them, so a runner that prompts for permission deadlocks on the first file write. Centraid's own consent layer (vault grants, outbox) is the gate that matters. Every kind must therefore reach a non-interactive posture, expressed one of two ways:

- **launch env** — codex: `INITIAL_AGENT_MODE=agent-full-access` (equivalent to `approvalPolicy:'never'` + a full-access sandbox), applied at startup with no client round-trip. This is the same `env` field native kinds use for their self-update suppressors.
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

## ACP client surface (what Centraid implements)

Centraid is a **headless turn driver + vault MCP host**, not a full IDE ACP client. Current behaviour:

| Area | Behaviour |
| --- | --- |
| Core turn | `initialize` → `session/resume` (preferred) → `session/load` → `session/new` → `session/prompt` → optional `session/close` |
| `stopReason` | Mapped: `refusal` → error (no success final); `max_tokens` / `max_turn_requests` → warn + final; `cancelled` → notice |
| System / policy prompt | Prepended on **every** turn (including load/resume), not only fresh sessions |
| Permissions | Auto-allow least-destructive option **and** emit `permission_auto_allowed` audit notice |
| Model pin | `session/set_config_option` each turn; failed pins are **warn** notices |
| Vault MCP | HTTP when agent advertises it; otherwise **stdio bridge** (`vault-mcp-stdio-proxy.mjs`) to the same loopback HTTP endpoint |
| Session continuity | Resume/load notices; short warm process pool (same kind+cwd+session, ~2 min idle) |
| Capabilities | Settings **Refresh models & capabilities** probes ACP `initialize` and shows chips (vault / resume / models / sign-in) |
| Plans / diffs | `phase: plan` with normalized `plan[]`; tool results may carry `diffs[]` + `phase: diff` |
| `additionalDirectories` | Passed on session lifecycle when the agent advertises the capability and the turn supplies paths |

Still **not** product features (intentional):

- Agent **slash commands** (`available_commands_update`) — Centraid owns `/` UX
- Interactive permission UI, client `fs/*` / `terminal/*`
- Protocol `authenticate` / `logout` (CLI login + install hints instead)
- `session/list` / `session/delete` (Centraid ledger is source of truth)
- Arbitrary user MCP servers beyond vault
- ACP v2 draft

## What ACP does not carry (protocol gaps)

Recorded honestly so nobody rediscovers them as bugs:

- **`ctx.agent` structured output.** The retired codex arm handed `call.json` to `codex exec --output-schema`. ACP has no equivalent, so `call.json` is now enforced by `coerceAgentAnswer` alone for every kind — which is what the claude arm always did.
- **Codex `localImage` paths.** The retired codex arm passed image attachments by path and let codex read them; ACP has no path-based image block, so images are base64-inlined into the prompt for every kind. Functionally equivalent, marginally more bytes on the wire.

## Automations ride the same single ACP path

The bespoke automation `ctx.tool` rail — a per-fire mock-LLM endpoint that pointed a native claude/codex CLI at a deterministic handler — was **removed** (#484). There is no automation-only agent path left; automations use the same transport as chat.

An automation fire now has exactly two cost profiles:

- **Deterministic rails** — `ctx.vault` (SQL + invoke + content), `ctx.state`, `ctx.runs`, `ctx.fetch`, `ctx.input` — run **parent-side, in-process** in the gateway. Zero model tokens, zero child processes, zero HTTP servers, on every runner kind. A fire whose handler never calls `ctx.agent` cannot spawn anything or bill anything.
- **Billed rail** — `ctx.agent(prompt, { json, model })` — a bounded one-shot turn against the user's real provider, routed through the **same single ACP backend as chat** (`getRunnerBackend(kind).runTurn`), so it works on all runner kinds like everything else.
