# Issue #171 — retire journal, drop ctx.invoke, consolidate chat-runner-core

Two automation-runtime simplifications, then the consolidation that follows from
treating chat and automation as two runners over one ledger.

## Checklist

- [x] Retire the crash-resume journal
- [x] Remove the ctx.invoke API surface
- [x] Relocate the agent-turn contract to app-engine
- [x] Consolidate chat-runner-core into @centraid/conversation-engine
- [x] Rename automation-engine to conversation-engine
- [x] Split src into chat and automation subfolders
- [x] Full typecheck and test suite green

## What changed

**Retire the crash-resume journal.** Deleted `automation-handler-journal.ts` +
its test, removed the replay branches and `journal` field from the handler ctx
and runner, and stripped `resumeFromRunId` / `retryOf` threading from
`automation-fire`, agent-runtime's `run-automation-local`, and openclaw's
`openclaw-fire`, plus the barrel exports. A crashed fire now re-runs from the
top — resume was opt-in and unwired, so no caller lost a capability.

**Remove the ctx.invoke API surface.** Removed the worker `ctx.invoke` method +
the `invoke` worker-protocol message, `handleInvokeMessage`,
`AutomationInvokeDispatcher`/`Result`, and the fire-spine `invokeDispatcher`.
Updated the scaffolder template, ten blueprint handler doc-comments, the skills
docs, and the public automations docs. The `'invoke'` node kind, `child_run_id`,
and `listChildRuns` stay as dormant plumbing — `parent_run_id` / `listChildRuns`
are still populated by the `onFailure` cascade, so only the node-level
`child_run_id` goes idle; stale comments naming `ctx.invoke` were retagged to
`onFailure`.

**Relocate the agent-turn contract to app-engine.** New `app-engine/agent-turn.ts`
holds the host-agnostic `ToolContext`, `AgentTurnInput/Config/Result`,
`RunnerPrefs/Kind`, `OpenAICompatProvider`, and a structural `RunTurnFn`.
agent-runtime's `runtime.ts` and `types.ts` became re-export shims so their many
internal importers stayed untouched. The codex/claude `runAgentTurn` stays in
agent-runtime.

**Consolidate chat-runner-core into @centraid/conversation-engine.** Moved
`chat-runner-core.ts` down out of agent-runtime to sit beside the automation
fire spine in one backend-agnostic engine; `runTurn` is now a required injected
seam (no `runAgentTurn` default). The two injection sites (`makeChatRunner`,
`makeUnifiedChatRunner`) pass `runAgentTurn` explicitly, and the gateway imports
`makeChatRunnerCore` directly from the engine — agent-runtime is now a pure
backend with no downward engine re-export.

**Rename automation-engine to conversation-engine.** Renamed
`@centraid/automation-engine` → `@centraid/conversation-engine` across the
package name, directory, every importer, and the lockfile; reframed the README
and barrel header to describe both runners.

**Split src into chat and automation subfolders.** Reorganized the package
`src/` into `chat/` (the chat-runner core) and `automation/` (the fire spine +
manifest/scheduler/webhook/mock-LLM/worker domain), with `index.ts` as the only
barrel at the root.

## Out of scope

- The dormant `'invoke'` node kind + `child_run_id` schema columns are kept, not
  torn out (the API-surface-only choice for the ctx.invoke removal).
- The desktop run-tree's `kind === 'invoke'` nesting branch is left as dead-but-
  harmless UI; wiring `onFailure` sub-runs into the trace view is a separate change.
- agent-runtime's pre-existing back-compat re-export of `startMockLlmServer` +
  scheduling types from the engine package was left as-is.
- The builder's replay-safe handler emission (#167) is unaffected.

## Verification

- Full typecheck green across the monorepo (`turbo run typecheck`, 19/19 packages
  including desktop, mobile, openclaw).
- Full test suite green (`turbo run test`): 588 tests, 0 failures — app-engine
  307, gateway 83, conversation-engine 81, agent-runtime 40, app-blueprints 37,
  worktree-store 28, skills 6, openclaw-plugin 6.
- Lint + format clean (oxlint, oxfmt --check) on the changed files.
- `openclaw-plugin` confirmed to have no `@centraid/agent-runtime` import — it
  consumes `@centraid/conversation-engine` directly, so the rename + consolidation
  keep it backend-agnostic.
- Clean `tsc` rebuild of conversation-engine: `dist/` mirrors `index`, `chat/`,
  `automation/` with no stale flat artifacts.
