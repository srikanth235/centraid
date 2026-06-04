# Issue #194 — rename conversation-engine → automation, relocate chat-runner core

## Checklist

- [x] Move `makeConversationRunnerCore` into `@centraid/app-engine`
- [x] Rename the package to `@centraid/automation`
- [x] Update all consumers (agent-runtime, gateway, openclaw-plugin, app-blueprints, desktop)
- [x] De-stutter the package layout: flatten `src/automation/*` and drop the `automation-` filename prefix
- [x] Drop the `Automation*` prefix from the public API; consumers import the package namespaced
- [x] Typecheck and tests green across affected packages

## What changed

The package was ~96% automation domain (fire spine, in-process cron scheduler,
webhook ingress, manifest, worker-thread handler runner, scaffolders) and ~4%
the per-turn chat spine. The name no longer described the package.

**Move `makeConversationRunnerCore` into `@centraid/app-engine`.** The
chat-runner core moved from the engine package to
`packages/app-engine/src/conversation-runner-core.ts`, next to the
`ConversationRunner` interface (`conversation-runner.ts`) and the `RunTurnFn`
turn contract (`turn.ts`) it already wired together. Its imports were rebased
to relative paths, and it is exported from app-engine's `index.ts`. The two
consumers now import it from app-engine: `@centraid/agent-runtime`'s
`conversation-adapter.ts` and the gateway's `unified-conversation-runner.ts`.
The old `src/conversation/` directory and its barrel export were removed.

**Rename the package to `@centraid/automation`.** `git mv` from
`packages/conversation-engine` → `packages/automation` (history preserved as
renames). Chosen over `automation-engine` to match the namespaced import style
below; the `name`/`description`, `README.md`, and `src/index.ts` header were
rewritten to describe the automation engine built around the fire spine.

**Update all consumers (agent-runtime, gateway, openclaw-plugin,
app-blueprints, desktop).** Every package reference — `package.json` workspace
deps, import specifiers, and comments — was rewritten to `@centraid/automation`.
`bun install` rewired the workspace symlink
(`node_modules/@centraid/automation → packages/automation`) and refreshed
`bun.lock`.

**De-stutter the package layout: flatten `src/automation/*` and drop the
`automation-` filename prefix.** With the chat sibling gone, the package holds a
single domain, so the `src/automation/` subfolder and the `automation-` filename
prefix were pure stutter. Flattened every module up to `src/` and dropped the
prefix — `automation-fire.ts` → `fire.ts`, `automation-manifest.ts` →
`manifest.ts`, `scaffold-automation.ts` → `scaffold.ts`, etc. The worker-thread
subfolder stays a real distinction: `worker/automation-runner.ts` →
`worker/runner.ts`, with the two runtime string-path literals in
`handler-runner.ts` (`resolveWorkerFile`) and stale doc-comment filenames
updated to match.

**Drop the `Automation*` prefix from the public API; consumers import the
package namespaced.** Inside `@centraid/automation` the package name already
carries the domain, so the prefix on exported symbols was stutter too
(`AutomationManifest`, `runAutomationFire`, `listAutomations`, …). Renamed the
exports to bare names (`Manifest`, `runFire`, `list`, `Host`, `Trigger`, `Ref`,
`OpenDispatch`, …). To keep call sites unambiguous without the prefix,
consumers now import the package as a namespace — `import * as automation from
'@centraid/automation'` — and read `automation.Manifest`, `automation.runFire()`,
`automation.list()`. Type-only importers use `import type * as automation`.
Already-unprefixed exports (`startMockLlmServer`, `provisionAppPendingWebhooks`,
`makeWebhookRouteHandler`, `WEBHOOK_ROUTE_PREFIX`, …) stay named imports — no
stutter to remove. Two re-export boundaries keep their own stable public names
by aliasing back: agent-runtime re-exports `AutomationRunRecord` (=
`automation.RunRecord`) from `run-automation-local.ts`, and openclaw-plugin
re-exports `AutomationManifest`/`AutomationManifestRequires` (= `Manifest`/
`ManifestRequires`).

## Out of scope

- Historical `receipts/*.md` and `QUALITY.md` entries that document the prior
  issue #171 rename (which went automation-engine → conversation-engine) are
  left untouched — editing them would falsify the audit trail.
- No behavioural change: the moves, rename, and symbol renames are mechanical;
  injected seams, the fire spine, and the chat runner's logic are unchanged.

## Verification

- Typecheck and tests green across affected packages: `turbo run typecheck`
  across app-engine, automation, agent-runtime, gateway, openclaw-plugin, and
  desktop reported 16/16 tasks successful; `turbo run test` across automation
  (95), app-engine (312), agent-runtime (60), gateway (121), and openclaw-plugin
  (16) reported all passing, 0 failures — including the automation fire suite
  that spawns the relocated `worker/runner.ts` worker thread.
- No live `@centraid/conversation-engine` or `automation-engine` references
  remain in source (repo-wide grep, excluding historical receipts, `QUALITY.md`,
  and the lockfile); no consumer still imports an `Automation*`-prefixed symbol
  from the package.
- Workspace link resolves: `node_modules/@centraid/automation` points at
  `packages/automation`, and `bun.lock` no longer mentions `conversation-engine`
  or `automation-engine`.
