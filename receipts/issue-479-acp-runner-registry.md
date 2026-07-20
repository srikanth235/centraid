# issue-479 — ACP as the single runner integration path

GitHub issue: [#479](https://github.com/srikanth235/centraid/issues/479)

The assistant supported exactly two agent CLIs, and that pair was hardcoded in
four parallel unions, a two-arm dispatch, bespoke `codex*`/`claude*` wire field
pairs, and a two-entry client table. Adding a third CLI meant editing eight
sites.

This change makes the Agent Client Protocol (ACP) the **single** integration
path. Every runner kind is now one registry entry. `codex` and `claude-code`
kept their user-facing ids but lost their bespoke backends: neither CLI speaks
ACP, so both launch through their official Apache-2.0 adapters. Five kinds
became eight, and the per-agent tools listing — superseded by connections — is
gone.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5e7d278e-75e-1784571219-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #479 | claude-opus-4-8 | 440 | 1084114 | 35152990 | 262944 | 1347498 | 30.9280 | 440 | 1084114 | 35152990 | 262944 | feat(agent-runtime): make ACP the single runner integration path (#479) -m The r |
| claude-code-5e7d278e-75e-1784571956-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #479 | claude-opus-4-8 | 62 | 55267 | 9384530 | 49486 | 104815 | 6.2751 | 502 | 1139381 | 44537520 | 312430 | feat(agent-runtime): make ACP the single runner integration path (#479) -m The r |
| claude-code-5e7d278e-75e-1784572003-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #479 | claude-opus-4-8 | 6 | 14841 | 952854 | 714 | 15561 | 0.5871 | 508 | 1154222 | 45490374 | 313144 | feat(agent-runtime): make ACP the single runner integration path (#479) |
| claude-code-5e7d278e-75e-1784572082-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #479 | claude-opus-4-8 | 12 | 14722 | 1946089 | 5951 | 20685 | 1.2139 | 520 | 1168944 | 47436463 | 319095 | feat(agent-runtime): make ACP the single runner integration path (#479) -m The r |
| claude-code-5e7d278e-75e-1784572126-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #479 | claude-opus-4-8 | 6 | 31710 | 988503 | 1362 | 33078 | 0.7265 | 526 | 1200654 | 48424966 | 320457 | wip (#479) |
| claude-code-5e7d278e-75e-1784572209-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #479 | claude-opus-4-8 | 14 | 7523 | 2393351 | 7105 | 14642 | 1.4214 | 540 | 1208177 | 50818317 | 327562 | feat(agent-runtime): make ACP the single runner integration path (#479) -m The r |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Checklist

- [x] Runner registry replaces the hardcoded dispatch
- [x] Generic ACP client as the single integration path
- [x] Claude Code and Codex folded onto their ACP adapters
- [x] Automation dispatch routed through the registry
- [x] Vault tools restored over a loopback MCP server
- [x] Attachments mapped to ACP content blocks
- [x] Auth-required surfaced as an actionable message
- [x] opencode, grok, and kimi added as runner kinds
- [x] Agents status is list-shaped
- [x] Per-agent tools listing retired

## What changed

**Runner registry replaces the hardcoded dispatch.** `packages/agent-runtime/src/registry.ts`
holds `RUNNER_BACKENDS: Record<RunnerKind, RunnerBackend>` — per kind: label,
user-facing default binary, minimum verified version, install hint, turn driver,
model enumerator. `RunnerKind` derives from a single `RUNNER_KINDS` list in
`packages/app-engine/src/conversation/turn.ts`, with an `isRunnerKind` guard for
validation sites. `runTurn`, `preflight.ts`, and `models/enumerators.ts` all read
the table instead of switching on the kind. The `Record` type makes a missing
backend a compile error.

**Generic ACP client as the single integration path.**
`packages/agent-runtime/src/backends/acp/` drives JSON-RPC 2.0 over stdio,
hand-authored against the public spec with no SDK dependency, with `backend.ts`
orchestrating a turn across focused modules (transport, session setup, stream
mapping, permissions, usage, launch planning): initialize →
`session/new` or `session/load` → `session/prompt`, mapping `session/update`
notifications onto the existing normalized `TurnStreamEvent` union. Permission
requests are auto-allowed least-destructively, matching the headless policy the
retired backends pinned. Model pinning uses `session/set_config_option`, echoing
only values the agent itself advertised, so no provider model ids are hardcoded.

**Claude Code and Codex folded onto their ACP adapters.** Neither CLI has an ACP
mode — verified against Claude Code's CLI reference and by dumping Codex's clap
subcommand enum. Both now launch through pinned dependencies
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, both
Apache-2.0), resolved from node_modules rather than fetched at runtime. Each
adapter wraps the same transport we previously drove by hand. `defaultBin` still
names the user-facing CLI, because that is what preflight probes and what the
install hint is about; `RunnerPrefs.binPath` reaches the underlying CLI through
`CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`. `backends/claude/backend.ts` and
`backends/codex/backend.ts` are deleted.

**Automation dispatch routed through the registry.** `ctx.agent` previously
branched claude-vs-codex with codex as the `else`, so a fire pinned to any new
kind silently ran on Codex — a different agent than the owner chose. It now
resolves through `RUNNER_BACKENDS` for every kind. The `ctx.tool` mock-LLM
harness deliberately keeps invoking the CLIs natively: it works by pointing a CLI
at a per-fire fake LLM endpoint, and an ACP agent owns its own model loop and
exposes no base URL to redirect. ACP kinds fail `ctx.tool` loudly instead.

**Vault tools restored over a loopback MCP server.** Folding onto ACP dropped
`TurnInput.toolContext`, leaving `vault_sql` / `vault_invoke` / `vault_content`
unreachable by every runner — the assistant's core capability, silently dark,
with typecheck green because the field is optional. `backends/acp/vault-mcp-server.ts`
serves the same tool contract (names, schemas, and the `centraid` server name are
preserved verbatim) over a per-turn loopback HTTP MCP server, advertised in the
`mcpServers` array at session creation. It binds `127.0.0.1:0`, requires a
256-bit per-turn bearer compared in constant time, and closes in the turn's
`finally` on every path including abort. Because the mechanism is generic, gemini
and qwen gain vault access they never had.

**Attachments mapped to ACP content blocks.** The fold had reduced attachments to
a skip-notice for all kinds, a regression on codex and claude-code where they
previously worked. `multimodal.ts` now emits ACP image and embedded-resource
blocks, gated on the `promptCapabilities` the agent advertised at initialize; the
notice survives only for genuinely unsupported attachments and names the file.

**Auth-required surfaced as an actionable message.** ACP's `AUTH_REQUIRED`
(`-32000`, confirmed in the SDK rather than assumed) previously reached the user
as a raw JSON-RPC error. It now becomes a message naming the fix, sourced from
the backend's own hint so no per-kind branching returns to the ACP client.

**opencode, grok, and kimi added as runner kinds.** All three speak ACP natively
and each cost exactly one registry entry plus the kind literal — the design's
own test. All three launch by subcommand rather than the `--acp` flag every
earlier kind used: `opencode acp`, `grok agent stdio`, `kimi acp`. Kimi's flag
form is deprecated *and* semantically different (single-session, no
`session/load`), so the subcommand is required for resume; that is recorded in a
comment. Gemini and Qwen were also moved off the now-deprecated
`--experimental-acp` onto `--acp`.

**Agents status is list-shaped.** `AgentsStatus` moved from bespoke
`codexAvailable` / `claudeModels` field pairs to `{ agents: AgentStatusEntry[] }`,
derived by iterating the registry. The client renders cards from that list with a
cosmetic accent map and a neutral default, so an unknown kind from a newer
gateway renders rather than crashes. Daemon config validation and the
per-subsystem runner pins validate against `RUNNER_KINDS`.

**Per-agent tools listing retired.** The `ToolGroups` drawer, the "Refresh tools"
control, `AgentToolDTO`, `AgentCardDTO.tools`, the `*Tools`/`*ToolsStatus` wire
fields and the `?refreshTools=1` path are gone, along with 16 orphaned CSS rules.
`enumerateHostTools` itself is kept: it has live non-display consumers in skills
grounding and per-turn tool resolution. Inline tool-call rendering in the
transcript is untouched.

Architecture is documented in `docs/runners.md`, indexed from `AGENTS.md`, with
the layout tables in `ARCHITECTURE.md` and `README.md` updated to match.

### Files

**Runner registry and kinds** — `packages/app-engine/src/conversation/turn.ts`
(`RUNNER_KINDS`, `isRunnerKind`), `packages/app-engine/src/conversation/turn.test.ts`,
`packages/app-engine/src/index.ts`, `packages/app-engine/src/runtime.ts`
(`RunnerStatus.kind` derives from `RunnerKind`),
`packages/agent-runtime/src/registry.ts`, `packages/agent-runtime/src/registry.test.ts`,
`packages/agent-runtime/src/runtime.ts`, `packages/agent-runtime/src/index.ts`,
`packages/agent-runtime/src/preflight.ts`, `packages/agent-runtime/src/preflight.test.ts`,
`packages/agent-runtime/src/models/enumerators.ts`,
`packages/agent-runtime/src/models/tiers.ts` (capability-tier vocabulary, moved
here from the deleted claude backend because it is tier naming, not transport),
`packages/agent-runtime/src/models/tiers.test.ts`.

**ACP client** — turn orchestration in
`packages/agent-runtime/src/backends/acp/backend.ts`, with the public contract in
`packages/agent-runtime/src/backends/acp/types.ts`, stdio transport in
`packages/agent-runtime/src/backends/acp/json-rpc.ts`, handshake / session setup /
model pinning / session modes in
`packages/agent-runtime/src/backends/acp/session-config.ts`, `session/update`
mapping in `packages/agent-runtime/src/backends/acp/stream-events.ts`, and
supporting concerns in `packages/agent-runtime/src/backends/acp/permissions.ts`,
`packages/agent-runtime/src/backends/acp/usage.ts`,
`packages/agent-runtime/src/backends/acp/launch.ts` (native-vs-adapter spawn plan,
root/`IS_SANDBOX`), `packages/agent-runtime/src/backends/acp/content.ts`,
`packages/agent-runtime/src/backends/acp/turn-vault-tools.ts`,
`packages/agent-runtime/src/backends/acp/vault-mcp-server.ts`, and
`packages/agent-runtime/src/backends/acp/adapter-bin.ts` (resolves an adapter's
bin from its installed package). Tests:
`packages/agent-runtime/src/backends/acp/backend.test.ts`,
`packages/agent-runtime/src/backends/acp/backend.model-usage.test.ts`,
`packages/agent-runtime/src/backends/acp/backend.vault-tools.test.ts`,
`packages/agent-runtime/src/backends/acp/backend.attachments.test.ts`,
`packages/agent-runtime/src/backends/acp/test-fixtures.ts`, and the scripted
`packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`. Attachment mapping
lives in `packages/agent-runtime/src/multimodal.ts` and
`packages/agent-runtime/src/multimodal.test.ts`.

**Deleted with the fold** — `packages/agent-runtime/src/backends/claude/backend.ts`,
`packages/agent-runtime/src/backends/claude/host-tools.ts`,
`packages/agent-runtime/src/backends/codex/backend.ts`,
`packages/agent-runtime/src/backends/codex/host-tools.ts`,
`packages/agent-runtime/src/backends/codex/host-tools.test.ts`. The last two
served only the retired codex backend's `dynamicTools` surface, so that behaviour
genuinely no longer exists and its test was deleted rather than weakened.
Adapters are pinned in `packages/agent-runtime/package.json` / `bun.lock`.

**Automation** — `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
(`ctx.agent` through the registry),
`packages/agent-runtime/src/automation/run-automation-host-agent.ts` (the
`ctx.tool` mock-host table, kept native),
`packages/agent-runtime/src/automation/run-automation.ts`, and the new
`packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`.
`packages/agent-runtime/src/host-tools.ts` is
untouched except for a guard: it has live consumers in skills grounding and
per-turn tool resolution, so only the settings-display path was removed.

**Gateway** — `packages/gateway/src/routes/agents-routes.ts` and
`packages/gateway/src/routes/agents-routes.test.ts` (list
shape, tools fields removed), `packages/gateway/src/serve/build-gateway.ts`
(`isRunnerKind`, boot warm over `RUNNER_KINDS`, `resolveCatalogTools` deleted),
`packages/gateway/src/serve/serve.test.ts`, `packages/gateway/src/cli/config.ts`,
`packages/gateway/src/index.ts`.

**Client** — `packages/client/src/react/shell/routes/settingsProvidersData.ts` and
the new `packages/client/src/react/shell/routes/settingsProvidersData.test.ts`,
`packages/client/src/react/screen-contracts.ts`,
`packages/client/src/centraid-api.d.ts`,
`packages/client/src/gateway-client-conversation.ts`,
`packages/client/src/react/shell/routes/SettingsRoute.tsx`,
`packages/client/src/react/screens/SettingsProvidersAgents.tsx`,
`packages/client/src/react/screens/SettingsProvidersScreen.tsx`,
`packages/client/src/react/screens/SettingsProvidersScreen.test.tsx`, and
`packages/client/src/react/screens/SettingsProvidersScreen.module.css` (16
orphaned tools-drawer rules removed).

## Out of scope

- **Token usage and cost accounting** — deferred to its own exercise at the
  owner's direction. Findings recorded for it: ACP's stable `usage_update`
  carries context-window occupancy and cumulative cost, not per-turn deltas;
  per-turn `Usage` is specified but UNSTABLE; neither Gemini nor Qwen emits
  `usage_update`, each using a different vendor `_meta` shape on a different
  channel. Our repricing backfill only visits rows with a non-NULL `items.model`,
  which is why this change stamps the model on every usage event. Insights
  aggregations coalesce NULL to zero, so unpriced work reads as $0 behind a bare
  counter, and cost rows carry no runner dimension.
- **Connector/MCP passthrough to agents** — `mcpServers` now carries the vault
  server, and is the seam where broker-owned connections would reach agents. Which
  connections are exposed to which runner, under what consent, is a design
  question in the consent model rather than a backend patch.
- **Slash commands and session-mode switchers** — considered and declined. Both
  are harness cockpit features; surfacing per-harness command sets and mode
  vocabularies contradicts the assistant's abstraction over the runner.
- **Filesystem and terminal delegation** — we advertise neither, so agents do
  their own I/O. Delegation serves editor-hosted scenarios that are not our shape.
- **Pi as a first-class kind** — it has no ACP mode (verified: zero matches
  repo-wide), only `--mode text|json|rpc`. The available bridge is a community
  single-maintainer MVP, a month stale, without filesystem or terminal
  delegation, against a CLI that ships breaking changes in minor bumps. Upstream
  has an active native-ACP proposal with maintainer engagement; if it lands, Pi
  becomes a one-line entry. Until then it is reachable through the custom `acp`
  kind via config, with no code from us.
- **A binPath/extraArgs settings UI** — the custom `acp` kind is configured
  through the daemon config file; no new settings surface was invented.

## Decisions

**ACP over per-harness adapters.** The alternative — a bespoke adapter per CLI —
is what the two retired backends were, and it priced every new harness at days of
work plus permanent maintenance. ACP inverts that to one entry. The cost is a
process hop for Claude, which previously ran the SDK in-process.

**The fold was initially resisted on cost-fidelity grounds, and that resistance
was wrong.** The objection was that ACP's usage channel is weaker than the native
protocols. Verification refuted it: the Claude adapter emits token counts *and*
USD over ACP's own `usage_update.cost`, model pinning survives via session config
options, and `ANTHROPIC_BASE_URL` passthrough — load-bearing for the deterministic
automation rig — is not merely preserved but first-class in the adapter, which
partitions its cache by it. Both adapters wrap the identical transports we already
maintained. Usage got *better*: `cacheWriteTokens` and `costUsd` are now captured
and the model is stamped in all cases.

**The vault-tools regression was caught by review, not by tests.** Nothing failed:
`toolContext` is optional, so dropping it typechecked and every suite stayed
green. Only reading the fold's own loss list surfaced it. That a product's central
capability can go dark under a full green board is the most useful thing this
change learned; the new tests close that specific hole.

**Third-party catalogs are leads, not configuration.** Launch commands were taken
from each project's own arg-parsing source. A public ACP catalog consulted during
research pins Kimi at 0.11.0 against an actual 1.49.0, and Grok at 0.2.11 — a
release predating ACP support entirely, adjacent to the correct 0.2.106 only under
a string sort. Both would have shipped broken runners.

**MCP transport chosen by adapter capability, not preference.** Both adapters
advertise `mcpCapabilities.http` and neither supports the experimental
client-hosted `acp` transport — codex's adapter throws on it. HTTP over loopback
was the only option that works for both, and it happens to generalize to all kinds.

**The loopback MCP endpoint is authenticated.** It exposes vault SQL and invoke to
anything that can reach the port. A per-turn bearer is cheap; an unauthenticated
localhost port carrying vault write access is not a defensible default.

## Verification

```sh
bun run check:pr
bun run test
```

`bun run check:pr` green: `format:check`, `oxlint`, turbo `lint`, `typecheck`
(**32 successful, 32 total**), `lint:types` (9 packages ok), `lint:css` (307
module imports across 570 files, no dead classNames), and the test-matrix
validators.

Per-package suites, run sequentially:

```
agent-runtime  Tests  140 passed (140)
app-engine     Tests  490 passed (490)
automation     Tests  219 passed (219)
gateway        Tests  799 passed | 6 skipped (805)
client         Tests 1028 passed (1028)
```

**Generic ACP client as the single integration path** is tested against a
scripted fake ACP agent spawned as a real subprocess, driven entirely by protocol
messages with no fixed sleeps: handshake, streamed message and thought chunks,
tool-call lifecycle, a `session/request_permission` round-trip asserting the
least-destructive option is chosen, resume via `session/load` with replayed
history swallowed, cancellation (abort mid-stream → agent observes
`session/cancel` → `aborted` emitted, no `final`), and spawn/exit failures
surfaced as actionable errors.

**Vault tools restored over a loopback MCP server** is covered end-to-end: the
fake agent receives the `mcpServers` entry, calls back with the bearer, invokes a
vault tool, and the turn emits `tool.start`/`tool.result` with the SQL surfaced.
Separate tests assert an unauthenticated request is rejected with 401, that the
listener is closed after a normal turn *and* after abort mid-tool-call, and that
a vault call is not rendered twice when the agent also streams it as an ACP tool
call.

**Attachments mapped to ACP content blocks**: an image-capable agent receives an
image block; a non-capable agent gets a notice naming the skipped file; a PDF
becomes an embedded resource. **Auth-required surfaced as an actionable message**
asserts the message is actionable rather than a raw RPC string. **Runner registry
replaces the hardcoded dispatch** and **opencode, grok, and kimi added as runner
kinds** are pinned by registry tests covering per-kind default binaries, ACP args
(including Grok's numeric `0.2.106` floor, so a future "cleanup" to a string
cannot reintroduce the sort trap), and routing through the ACP backend;
**Automation dispatch routed through the registry** asserts every kind resolves
through it and that ACP kinds fail `ctx.tool` with a named constraint.
**Claude Code and Codex folded onto their ACP adapters** is asserted through an
exported launch-config seam, so env and adapter resolution are checked without
spawning. **Agents status is list-shaped** and **Per-agent tools listing retired**
are covered by rewritten route tests asserting the list shape, tolerance of an
unknown future kind (rendered disabled, not crashed), and the absence of tools
fields.

Adapter behaviour was verified against installed artifacts rather than
documentation: bin entry points read from each package manifest (the Claude
adapter's `main` is a library, so the `bin` must be resolved); the config-option
wire method read from the SDK's `AGENT_METHODS`; the MCP HTTP entry shape from
`McpServerHttp`; `AUTH_REQUIRED = -32000` from the SDK's `jsonrpc.js`; and each
adapter's MCP transport support and permission-mode gating from its own dist.

**Not verified:** no turn has been driven against a real installed CLI for any of
the eight kinds — all runner coverage is against the scripted fake agent, so
version floors and launch flags are verified from upstream sources rather than by
execution. Repo-wide parallel `bun run test` produced two load-dependent failures
in packages this change does not touch (`client/App.test.tsx`, then
`vault/stream-ingress.test.ts` on a re-run, plus a known
`gateway/lifecycle-automation-routes` timeout flake); each passes in isolation and
the failures differ per run, so they are attributed to contention, not to this
change.

## Audit

Recon and implementation ran as independent sub-agents, with review, gates, and
commits held in the main session. Three claims made during the work were refuted
by later verification and corrected before shipping: that Claude and Codex would
lose cost fidelity behind ACP (the adapters preserve tokens, and USD for Claude);
that ACP's `usage_update` might not exist (it is stable spec, though the wrong
shape for per-turn pricing and unemitted by both target CLIs); and that OpenCode
and Pi were equivalent non-ACP cases (OpenCode is ACP-native; only Pi is not).

The vault-tools regression was self-reported by the wave that caused it, in its
own loss list, and confirmed by grep before being treated as blocking. The ACP
backend's `usage_update` handler shipped in the first wave untested and
unexercised by the fake agent — plausible-looking code that nothing proved; it is
now exercised.

## Steering

Verdict: **PASS**

Evidence for rubric checks:

1. **Every human-steering event in the transcript is recorded as a row in this
   receipt's `### Steering` table under `## Accounting`.**
   - Identified three steering events, all corrections: (a) a directive to stop
     maintaining special code branches for Claude and Codex and fold both behind
     ACP, reversing the recommendation to keep native adapters for those two;
     (b) a directive to take token consumption up separately and proceed with the
     fold, deferring work that was being scoped into this change; (c) a
     correction that kimi, opencode, and pi had not been covered, expanding scope
     beyond the gemini/qwen pair originally implemented.
   - **Check: PASS**

2. **No non-steering message is recorded as a steering event.**
   - The remaining user messages are questions rather than redirections: asking
     what happens to insights and token consumption, asking which ACP
     capabilities the chat assistant actually needs, asking whether slash
     commands and other ACP features are supported, and a message supplying a
     reference URL. Each was answered with an assessment; none redirected work in
     progress, and none appears in the steering table.
   - **Check: PASS**
