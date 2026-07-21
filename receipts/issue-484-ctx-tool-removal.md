# issue-484 — remove the ctx.tool rail; deterministic fires are zero-token/zero-spawn

Automation handlers had three cost rails: deterministic parent-side `ctx.*`,
the billed `ctx.agent` turn, and `ctx.tool` — which puppeted a claude/codex CLI
against a per-fire mock-LLM server. Post-#479 (ACP as the single turn transport)
`ctx.tool` was the last claude/codex-only branch, it worked on only 2 of 16
runner kinds, and an audit found **zero** shipped templates used it. This change
removes the rail and the machinery that existed only to serve it, and makes the
invariant structural: a fire whose handler never calls `ctx.agent` starts zero
child processes and zero HTTP servers, on every runner kind.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5e7d278e-75e-1784608446-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | claude-opus-4-8 | 38 | 97205 | 5939418 | 48808 | 146051 | 4.7976 | 1242 | 2707698 | 119972115 | 752135 |  |
| claude-code-5e7d278e-75e-1784608516-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | claude-opus-4-8 | 6 | 5376 | 991683 | 4425 | 9807 | 0.6401 | 1248 | 2713074 | 120963798 | 756560 |  |
| claude-code-5e7d278e-75e-1784608576-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | claude-opus-4-8 | 6 | 6768 | 997059 | 1914 | 8688 | 0.5887 | 1254 | 2719842 | 121960857 | 758474 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-5e7d278e75e-1-1 | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | correction | classifier | ctx.tool not promised; zero-token automations priority | feat(agent-runtime): remove ctx.tool rail (#484) | 855 | 2026-07-21T02:50:27.618Z |
| steer-5e7d278e75e-1-2 | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | interrupt | structural |  | feat(agent-runtime): remove ctx.tool rail (#484) | 916 | 2026-07-21T03:03:43.923Z |
| steer-5e7d278e75e-1-3 | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | correction | classifier | proceed with changes; use orchestrator pattern with subagents | feat(agent-runtime): remove ctx.tool rail (#484) | 981 | 2026-07-21T03:09:53.869Z |

## Checklist

- [x] A fire whose handler uses only `ctx.vault`/`ctx.state`/`ctx.fetch`/`ctx.input` starts zero child processes and zero HTTP servers, on every runner kind (test asserts no mock session is constructed).
- [x] `ctx.tool(` in a handler fails at publish time with an actionable lint message; no `tool-batch` path remains in the handler runner.
- [x] `ctx.agent` fires still work through the ACP backend on all kinds (existing dispatch tests, re-pointed).
- [x] `grep -r "@anthropic-ai/claude-agent-sdk" packages/` returns nothing; `backends/claude/` is gone; the only codex/claude-specific code left in `packages/agent-runtime` is their registry entries (adapter specs).
- [x] Model enumeration for claude-code and codex returns a non-empty list via the ACP-generic enumerator.
- [x] `requires.tools` no longer exists in the manifest schema, scaffold output, or fire path.
- [x] `packages/mock-llm` is deleted with zero production imports.
- [x] Docs/skills no longer teach `ctx.tool`; `docs/runners.md` reflects the new dispatch story.

## What changed

**The `ctx.tool` rail is gone, end to end.** The worker-side `ctx.tool` surface
(`packages/automation/src/worker/runner.ts`), the `tool-batch` route and its
`requires.tools` connector-allowlist gate (`packages/automation/src/handler/runner.ts`),
`dispatchToolBatch` (`packages/automation/src/handler/ctx.ts`), and the
`ToolDispatcher`/`ToolCall`/`ToolResult` types and their exports
(`packages/automation/src/index.ts`) were removed. `ctx.tool` is not a stub —
the property simply does not exist on `ctx`, so a call fails naturally.

**A fire whose handler never calls `ctx.agent` now starts zero child processes
and zero HTTP servers, on every runner kind.** `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
no longer constructs the persistent mock-LLM session or the eager per-fire mock
HTTP server; the scratch dir is created lazily and only when a `ctx.agent` call
carries attachments. `packages/agent-runtime/src/automation/run-automation.ts`
no longer threads a host agent. `ctx.agent` still routes through the single ACP
seam `getRunnerBackend(kind).runTurn` — the same path chat uses — so pinning a
vault to any of the 16 kinds drives that agent. `packages/agent-runtime/src/automation/run-automation-host-agent.ts`
(the `MOCK_HOST_AGENTS` table, the in-process Claude SDK `query()` arm, the
`codex exec` arm) is deleted.

**Publish-time gate.** `packages/automation/src/handler/lint.ts` gains a
`no-ctx-tool` rule matching `ctx.tool(` (and `ctx['tool'](`), message: "ctx.tool
was removed: handlers do deterministic work with ctx.vault / ctx.fetch /
ctx.state, and delegate judgment to ctx.agent." Sibling replay-safety rule
messages that steered authors toward `ctx.tool` were re-pointed at
`ctx.fetch`/`ctx.vault`/`ctx.agent`.

**`requires.tools` retired** from `packages/automation/src/manifest/manifest.ts`,
the scaffold starter manifest (`packages/automation/src/scaffold/scaffold.ts`),
the fire path (`packages/automation/src/fire/fire.ts`), the six connector
template manifests under `packages/blueprints/automations/*/automations/*/automation.json`,
and the client automation editor/builder (`packages/client/src/react/screen-contracts.ts`,
`packages/client/src/react/shell/routes/automationEditorData.ts`,
`packages/client/src/react/shell/routes/builder/useBuilder.ts`,
`packages/client/src/react/shell/routes/builder/BuilderAutomationConfigView.tsx`,
`packages/client/src/react/screens/AutomationEditorScreen.tsx`,
`packages/client/src/centraid-api.d.ts`) — including the "Tools" chip group the
editor rendered.

**Host-tool grounding removed.** `packages/agent-runtime/src/host-tools.ts`
(the claude/codex tool-enumeration probe that grounded `ctx.tool` authoring) and
`packages/skills/src/dynamic.ts` (`buildToolsGroundingBlock`) are deleted, along
with the `CatalogEntry.tools`/`toolsEnumeratedAt` fields and the warmer's
`enumerateTools` surface (`packages/agent-runtime/src/models/catalog.ts`,
`packages/agent-runtime/src/models/catalog-warmer.ts`), the `enumerateHostTools`
wiring and `invalidateToolCatalog` in `packages/gateway/src/serve/build-gateway.ts`,
the `onConnectionChanged` tool-catalog hook in
`packages/gateway/src/routes/connections-routes.ts`, and the tool resolution in
`packages/gateway/src/runs/unified-conversation-runner.ts`,
`packages/skills/src/authoring-prompt.ts`, and `packages/skills/src/index.ts`.

**ACP-generic model enumeration.** `packages/agent-runtime/src/backends/acp/enumerate-models.ts`
opens an ACP session and reads the model `configOptions` the agent advertises
(both first-party adapters emit them), mapping the offered `{value, name}` pairs
to `RunnerModel[]`; it is best-effort (`[]` on missing binary, `AUTH_REQUIRED`,
timeout, or no model option) and never leaves a child running. New helpers
`readOfferedModels`/`OfferedModel` live in `packages/agent-runtime/src/backends/acp/session-config.ts`.
`packages/agent-runtime/src/registry.ts` wires it via an opt-in `probeModels`
flag set on codex + claude-code (kept under the 500-line cap). The bespoke
`packages/agent-runtime/src/backends/claude/model-list.ts` and
`packages/agent-runtime/src/backends/codex/model-list.ts` are deleted (the
`backends/claude/` and `backends/codex/` directories are now gone), along with
the now-unimported `packages/agent-runtime/src/backends/codex/provider-config.ts`.
`packages/agent-runtime/src/backends/codex/safe-stdin-write.ts` (a dependency of
the ACP JSON-RPC client) was relocated to `packages/agent-runtime/src/backends/acp/safe-stdin-write.ts`,
import updated in `packages/agent-runtime/src/backends/acp/json-rpc.ts`.
`packages/agent-runtime/src/models/enumerators.ts` docs rewritten to the generic
story; `packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs` gained a
`--pid-marker` for the child-liveness test.

**`packages/mock-llm` deleted** (whole package — `package.json`, `src/index.ts`,
`src/mock-llm-server.ts`, `src/mock-llm-writers.ts`, `src/persistent-mock-session.ts`,
`tsconfig.json`), its two workspace deps dropped from
`packages/automation/package.json` and `packages/test-kit/package.json`, the
dead `./mock-llm` facade (`packages/test-kit/src/mock-llm.ts`) and its two
self-tests (`packages/test-kit/src/mock-llm-server.test.ts`,
`packages/test-kit/src/persistent-mock-session.test.ts`) removed, and the
back-compat re-exports dropped from `packages/automation/src/index.ts` and
`packages/agent-runtime/src/index.ts`. **`@anthropic-ai/claude-agent-sdk`** was
its last importer's dependency and is removed from `packages/agent-runtime/package.json`
(and `bun.lock`).

**Scaffold + docs.** `packages/automation/src/scaffold/scaffold.ts` and
`packages/blueprints/src/scaffold-defaults.ts` drop the `ctx.tool` placeholder
and the "two cost rails" framing for the honest deterministic-vs-`ctx.agent`
story. Docs write-back: `docs/runners.md`, `TESTING.md`,
`packages/automation/README.md`, `packages/skills/skills/automation-authoring/SKILL.md`,
`packages/skills/skills/authoring-centraid-apps/SKILL.md`, and two stale code
comments (`packages/app-engine/src/conversation/run-stream-event.ts`,
`packages/app-engine/src/conversation/schema.ts`).

### Files

- `packages/agent-runtime/package.json`
- `packages/agent-runtime/src/automation/run-automation-dispatch.test.ts`
- `packages/agent-runtime/src/automation/run-automation-host-agent.ts` (deleted)
- `packages/agent-runtime/src/automation/run-automation-live-dispatch.ts`
- `packages/agent-runtime/src/automation/run-automation.ts`
- `packages/agent-runtime/src/backends/acp/enumerate-models.ts` (added)
- `packages/agent-runtime/src/backends/acp/enumerate-models.test.ts` (added)
- `packages/agent-runtime/src/backends/acp/fake-acp-agent.mjs`
- `packages/agent-runtime/src/backends/acp/json-rpc.ts`
- `packages/agent-runtime/src/backends/acp/safe-stdin-write.ts` (relocated from backends/codex)
- `packages/agent-runtime/src/backends/acp/safe-stdin-write.test.ts` (relocated from backends/codex)
- `packages/agent-runtime/src/backends/acp/session-config.ts`
- `packages/agent-runtime/src/backends/claude/model-list.ts` (deleted)
- `packages/agent-runtime/src/backends/claude/model-list.test.ts` (deleted)
- `packages/agent-runtime/src/backends/codex/model-list.ts` (deleted)
- `packages/agent-runtime/src/backends/codex/model-list.test.ts` (deleted)
- `packages/agent-runtime/src/backends/codex/provider-config.ts` (deleted)
- `packages/agent-runtime/src/backends/codex/provider-config.test.ts` (deleted)
- `packages/agent-runtime/src/host-tools.ts` (deleted)
- `packages/agent-runtime/src/host-tools.test.ts` (deleted)
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/models/catalog.ts`
- `packages/agent-runtime/src/models/catalog.test.ts`
- `packages/agent-runtime/src/models/catalog-warmer.ts`
- `packages/agent-runtime/src/models/catalog-warmer.test.ts`
- `packages/agent-runtime/src/models/enumerators.ts`
- `packages/agent-runtime/src/registry.ts`
- `packages/app-engine/src/conversation/run-stream-event.ts`
- `packages/app-engine/src/conversation/schema.ts`
- `packages/automation/README.md`
- `packages/automation/package.json`
- `packages/automation/src/fire/connector.test.ts`
- `packages/automation/src/fire/fire-vault.test.ts`
- `packages/automation/src/fire/fire.test.ts`
- `packages/automation/src/fire/fire.ts`
- `packages/automation/src/handler/ctx.ts`
- `packages/automation/src/handler/lint.ts`
- `packages/automation/src/handler/lint.test.ts`
- `packages/automation/src/handler/runner.ts`
- `packages/automation/src/index.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/automation/src/scaffold/scaffold.ts`
- `packages/automation/src/scaffold/scaffold-files.test.ts`
- `packages/automation/src/worker/runner.ts`
- `packages/blueprints/automations/github-pull/automations/github-pull/automation.json`
- `packages/blueprints/automations/google-calendar-invite-send/automations/google-calendar-invite-send/automation.json`
- `packages/blueprints/automations/google-calendar-pull/automations/google-calendar-pull/automation.json`
- `packages/blueprints/automations/google-contacts-pull/automations/google-contacts-pull/automation.json`
- `packages/blueprints/automations/google-gmail-pull/automations/google-gmail-pull/automation.json`
- `packages/blueprints/automations/google-gmail-send/automations/google-gmail-send/automation.json`
- `packages/blueprints/src/scaffold-defaults.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.test.tsx`
- `packages/client/src/react/shell/routes/automationEditorData.ts`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationConfigView.tsx`
- `packages/client/src/react/shell/routes/builder/useBuilder.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/routes/connections-routes.ts`
- `packages/gateway/src/runs/unified-conversation-runner.ts`
- `packages/gateway/src/runs/unified-conversation-runner.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/validate-automation-handler.test.ts`
- `packages/mock-llm/package.json` (deleted)
- `packages/mock-llm/src/index.ts` (deleted)
- `packages/mock-llm/src/mock-llm-server.ts` (deleted)
- `packages/mock-llm/src/mock-llm-writers.ts` (deleted)
- `packages/mock-llm/src/persistent-mock-session.ts` (deleted)
- `packages/mock-llm/tsconfig.json` (deleted)
- `packages/skills/src/authoring-prompt.ts`
- `packages/skills/src/dynamic.ts` (deleted)
- `packages/skills/src/dynamic.test.ts` (deleted)
- `packages/skills/src/index.ts`
- `packages/skills/skills/automation-authoring/SKILL.md`
- `packages/skills/skills/authoring-centraid-apps/SKILL.md`
- `packages/test-kit/package.json`
- `packages/test-kit/src/mock-llm.ts` (deleted)
- `packages/test-kit/src/mock-llm-server.test.ts` (deleted)
- `packages/test-kit/src/persistent-mock-session.test.ts` (deleted)
- `docs/runners.md`
- `TESTING.md`
- `tests/matrix.json`
- `bun.lock`

## Out of scope

- **Token/cost accounting for ACP runners** — the per-turn usage/cost surface is
  a separate exercise (recorded against #479), not touched here.
- **The chat-turn ACP path** — unchanged beyond housing the relocated
  `safe-stdin-write` util and the new model enumerator.
- **`HandlerOutcome.toolBatches` / `RunRecord.toolBatches`** — deliberately kept
  (pinned to 0) so run-record consumers don't break; the field is vestigial but
  removing it touches the run ledger schema, out of scope for this change.
- **`docs/plans/skills-package-plan.md`** — a historical point-in-time plan,
  left as a frozen record.

## Decisions

- **Delete `ctx.tool`, don't port it to 16 CLIs.** The mock-LLM machinery
  existed only because `ctx.tool` needed a real CLI to execute tool batches
  deterministically. A handler touching `ctx.vault`/`ctx.state`/`ctx.fetch` has
  no reason to leave the gateway process. With zero template consumers, deleting
  the rail (rather than generalizing it) is what makes the zero-spawn invariant
  structural instead of incidental.
- **Explicit `probeModels` wiring, not a universal ACP-enumeration default.** A
  universal probe default would turn the `registry.test.ts` "native kinds
  enumerate no models without spawning" assertion into a real process spawn per
  kind, and make the catalog warmer spawn one agent per installed kind at boot
  (many just answering `AUTH_REQUIRED`). The flag is set only on codex +
  claude-code, preserving behavior; it is a clean seam to enable a native kind
  later.
- **Verified both adapters advertise model `configOptions` before deleting the
  bespoke enumerators** — the hard precondition. `claude-agent-acp`
  (`MODEL_CONFIG_ID`, `buildConfigOptions`) and `codex-acp`
  (`createModelConfigOption`) both emit the option in the shape `session-config.ts`
  reads, so neither flagship kind loses its model list.
- **`ctx.fetch` is the sanctioned deterministic HTTP path.** The old authoring
  guidance ("ctx.fetch does not exist — use ctx.tool for external data") was
  inverted: deterministic external HTTP now goes through `ctx.fetch`, billed
  judgment through `ctx.agent`.

## Verification

Per-package suites run sequentially (this environment flakes on repo-wide
parallel runs); then the PR gate.

```sh
# agent-runtime — dispatch routing, model enumeration, registry, vault-tools guard
cd packages/agent-runtime && bun run vitest run src/backends src/automation src/models src/registry.test.ts   # 78 passed
cd packages/agent-runtime && bun run typecheck                                                                 # exit 0

# automation — ctx.tool removal, lint gate, scaffold, fire path
cd packages/automation && bun run test                                                                         # 215 passed

# client — requires.tools + Tools chip retirement
cd packages/client && bun run typecheck                                                                        # exit 0
cd packages/client && bun run vitest run src/react/screens/AutomationEditorScreen.test.tsx \
  src/react/shell/routes/builder src/react/shell/routes/automationEditorData                                   # 45 passed

# invariant checks
grep -r "@anthropic-ai/claude-agent-sdk" packages/ --include="*.ts" --include="*.json" | grep -v /dist/        # (empty)
ls packages/agent-runtime/src/backends                                                                         # acp  (claude/ codex/ gone)
ls packages/mock-llm 2>&1                                                                                       # No such file or directory

# full PR gate
bun run check:pr
```

`ctx.agent` fires still route through the single ACP backend
(`run-automation-dispatch.test.ts`, re-pointed); the dispatch test asserts via
the seam that the surface exposes no `toolDispatcher`, i.e. a deterministic fire
constructs no mock session. Authoring a handler with `ctx.tool(` is rejected by
the `no-ctx-tool` publish-time lint. Model enumeration for claude-code and codex
returns the adapter-advertised list via the generic ACP probe.

Checklist crosswalk — each checked item and where it is realized:

- A fire whose handler uses only `ctx.vault`/`ctx.state`/`ctx.fetch`/`ctx.input` starts zero child processes and zero HTTP servers, on every runner kind (test asserts no mock session is constructed). — `run-automation-live-dispatch.ts` no longer constructs the mock session; `run-automation-dispatch.test.ts` asserts the seam exposes no `toolDispatcher`.
- `ctx.tool(` in a handler fails at publish time with an actionable lint message; no `tool-batch` path remains in the handler runner. — the `no-ctx-tool` rule in `lint.ts` and the `tool-batch` route removed from `handler/runner.ts`.
- `ctx.agent` fires still work through the ACP backend on all kinds (existing dispatch tests, re-pointed). — routed via `getRunnerBackend(kind).runTurn`; `run-automation-dispatch.test.ts` re-pointed and green.
- `grep -r "@anthropic-ai/claude-agent-sdk" packages/` returns nothing; `backends/claude/` is gone; the only codex/claude-specific code left in `packages/agent-runtime` is their registry entries (adapter specs). — verified by the Verification grep + `ls packages/agent-runtime/src/backends` showing only `acp`.
- Model enumeration for claude-code and codex returns a non-empty list via the ACP-generic enumerator. — `enumerate-models.ts` reads adapter-advertised `configOptions`, wired via `probeModels` in `registry.ts`.
- `requires.tools` no longer exists in the manifest schema, scaffold output, or fire path. — removed from `manifest.ts`, `scaffold.ts`, `fire.ts`, six blueprint manifests, and the client editor/builder.
- `packages/mock-llm` is deleted with zero production imports. — the package directory and its two workspace deps are removed; re-exports dropped from both index barrels.
- Docs/skills no longer teach `ctx.tool`; `docs/runners.md` reflects the new dispatch story. — `docs/runners.md`, `TESTING.md`, `packages/automation/README.md`, and both SKILL.md files rewritten.

## Audit

**PASS.**

1. **`## What changed` faithfully describes the diff.** Every claim maps to a
   named file in `### Files`: the `ctx.tool` surface removal (automation worker/
   handler/index), the zero-spawn seam (live-dispatch, run-automation, deleted
   host-agent), the lint gate (lint.ts), `requires.tools` excision (manifest,
   scaffold, fire, six blueprint manifests, five client files), host-tool
   removal (host-tools, dynamic, catalog, build-gateway, connections-routes,
   unified-conversation-runner, authoring-prompt), the generic enumerator
   (enumerate-models, session-config, registry, deleted model-lists +
   provider-config, relocated safe-stdin-write), and the mock-llm/SDK deletion.
2. **Each `- [x]` item is realized in the diff.** Zero-spawn → live-dispatch has
   no `startPersistentMockSession`, scratch dir is lazy; publish lint → `no-ctx-tool`
   rule + test; `ctx.agent` on all kinds → dispatch test green; no SDK → grep
   empty + package.json drop; model enumeration → enumerate-models + probeModels
   wiring; `requires.tools` gone → manifest/scaffold/fire/client; mock-llm gone
   → directory deleted, deps dropped; docs → runners.md/TESTING.md/SKILLs.
3. **`## Checklist` mirrors issue #484's acceptance criteria** (verbatim item
   text, one-to-one).

No item's evidence was missing or contradicted; verdict PASS.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5e7d278e-75e-1784607926-1 | claude-code | 5e7d278e-75e6-4ac4-a4a5-1cba173c5d98 | #484 | claude-opus-4-8 | 630 | 1357023 | 57163002 | 345338 | 1702991 | 45.6995 | 1204 | 2610493 | 114032697 | 703327 |  |

## Steering

Verdict: **PASS**

Evidence for rubric checks:

1. **Every human-steering event in the transcript is recorded as a row in this
   receipt's `### Steering` table under `## Accounting`.**
   - Identified three steering events, all recorded:
     - (a) Line 855 (ordinal 855, 2026-07-21T02:50:27.618Z): User correction
       stating that ctx.tool is not a promised surface and the focus should be on
       making sure automations that don't invoke real agents consume zero tokens.
       Recorded as `steer-5e7d278e75e-1-1`, type=correction, tier=classifier.
     - (b) Line 916 (ordinal 916, 2026-07-21T03:03:43.923Z): User interrupt
       `[Request interrupted by user]` in the middle of an explanation about
       zero-cost automations. Recorded as `steer-5e7d278e75e-1-2`, type=interrupt,
       tier=structural.
     - (c) Line 981 (ordinal 981, 2026-07-21T03:09:53.869Z): User correction
       instructing the agent to "go ahead with your changes...act as orchestrator
       and spawn opus subsagents" — redirecting the approach to use subagent
       orchestration. Recorded as `steer-5e7d278e75e-1-3`, type=correction,
       tier=classifier.
   - **Check: PASS**

2. **No non-steering message is recorded as a steering event.**
   - The remaining user messages in the transcript are task instructions,
     clarifying questions, and information requests: asking about insights/token
     consumption, asking about ACP capabilities, asking about provider support
     (Pi, Kimi, OpenCode, Cursor, GitHub Copilot), asking about vault
     reachability, asking whether the Claude Agent SDK is still present, asking
     about zero-cost automation mechanics, asking whether every automation is a
     chat, asking if agents are still running, and asking for continuation
     (`continue`). These are answered with assessments or progress updates; none
     redirect work in progress or correct the agent's approach, and none appear in
     the steering table.
   - **Check: PASS**
