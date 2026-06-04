# Issue #194 — rename conversation-engine → automation-engine, relocate chat-runner core

## Checklist

- [x] Move `makeConversationRunnerCore` into `@centraid/app-engine`
- [x] Rename `@centraid/conversation-engine` to `@centraid/automation-engine`
- [x] Update all consumers (agent-runtime, gateway, openclaw-plugin, app-blueprints, desktop)
- [x] Typecheck and tests green across affected packages

## What changed

The package was ~96% automation domain (fire spine, in-process cron scheduler,
webhook ingress, manifest, worker-thread handler runner, scaffolders) and ~4%
the per-turn chat spine. The name no longer described the package, so two
things happened together.

**Move `makeConversationRunnerCore` into `@centraid/app-engine`.** The
chat-runner core moved from the engine package to
`packages/app-engine/src/conversation-runner-core.ts`, next to the
`ConversationRunner` interface (`conversation-runner.ts`) and the `RunTurnFn`
turn contract (`turn.ts`) it already wired together. Its imports were rebased
from `@centraid/app-engine` to relative paths, and it is exported from
app-engine's `index.ts`. The two consumers now import it from app-engine:
`@centraid/agent-runtime`'s `conversation-adapter.ts` and the gateway's
`unified-conversation-runner.ts`. The old `src/conversation/` directory and its
barrel export were removed. Doc comments in `agent-runtime/src/index.ts` and the
gateway's unified runner were corrected to point at the new app-engine home.

**Rename `@centraid/conversation-engine` to `@centraid/automation-engine`.**
`git mv packages/conversation-engine packages/automation-engine` (history
preserved as renames). The package's `name`/`description`, `README.md`, and
`src/index.ts` header were rewritten to describe the automation engine built
around the fire spine.

**Update all consumers (agent-runtime, gateway, openclaw-plugin,
app-blueprints, desktop).** Every `@centraid/conversation-engine` reference —
`package.json` workspace deps, import specifiers, and comments — was rewritten
to `@centraid/automation-engine` across agent-runtime, gateway, openclaw-plugin,
app-blueprints, and apps/desktop. `bun install` rewired the workspace symlink
(`node_modules/@centraid/automation-engine → packages/automation-engine`) and
refreshed `bun.lock`.

## Out of scope

- Historical `receipts/*.md` and `QUALITY.md` entries that document the prior
  issue #171 rename (which went automation-engine → conversation-engine) are
  left untouched — editing them would falsify the audit trail.
- No behavioural change: the move and rename are mechanical; injected seams,
  the fire spine, and the chat runner's logic are unchanged.

## Verification

- Typecheck and tests green across affected packages: `turbo run typecheck` for
  app-engine, automation-engine, agent-runtime, gateway, openclaw-plugin, and
  desktop reported 16/16 tasks successful; `turbo run test` for
  automation-engine, app-engine, and gateway reported 9/9 tasks successful
  (gateway 121/121 passing).
- No live `@centraid/conversation-engine` references remain (repo-wide grep,
  excluding historical receipts and `QUALITY.md`).
- Workspace link resolves: `node_modules/@centraid/automation-engine` points at
  `packages/automation-engine`, and `bun.lock` no longer mentions
  `conversation-engine`.
