# issue-181 — Persist builder runs as kind='build'

GitHub issue: [#181](https://github.com/srikanth235/centraid/issues/181)

Builder chat and data chat were unified in #141 — both flow through the same
`/_chat` route and the same `makeChatRunnerCore` spine, and persistence went
through `recordTurn`, which **hardcoded `kind: 'chat'`**. So builder iterations
landed in the run ledger indistinguishable from data chats, and the defined
`RunKind = '... | 'build'` enum value had no writer (it was referenced only by
the insights "Builds" label, for rows that were never produced).

This wires the ledger kind to the chat *surface*: the builder-capable unified
runner (draft worktree + native file-edit tools + authoring prompt) reports
`runKind: 'build'`; the data-only runner leaves it unset, so a pure-data
deployment's turns still record as `'chat'`. The kind is read statically off the
runner by the route, so an errored turn (which returns no `ChatRunResult`) is
still tagged correctly.

## Checklist

- [x] Thread a runKind seam through chat-runner-core into recordTurn instead of the hardcoded chat kind
- [x] The builder draft-worktree authoring path supplies kind build while data chat keeps kind chat
- [x] insights-store Builds grouping now reflects real rows
- [x] Transcript reconstruction from runs and run_nodes is unaffected by the new kind

## What changed

### Thread a runKind seam through chat-runner-core into recordTurn instead of the hardcoded chat kind

`ChatRunner` (`packages/app-engine/src/chat-runner.ts`) gains a `readonly
runKind?: RunKind` — a property of the surface, not the turn. `makeChatRunnerCore`
(`packages/conversation-engine/src/chat/chat-runner-core.ts`) gains a matching
`runKind?` option and surfaces it on the built runner. `RecordTurnInput`
(`packages/app-engine/src/chat-history.ts`) gains an optional `kind?: RunKind`,
and `recordTurn` now passes `kind: input.kind ?? 'chat'` to `insertRun` (was a
hardcoded `'chat'`). The chat route (`packages/app-engine/src/chat-routes.ts`)
reads `ctx.runner?.runKind` and forwards it into `recordTurn`.

### The builder draft-worktree authoring path supplies kind build while data chat keeps kind chat

`makeUnifiedChatRunner` (`packages/gateway/src/unified-chat-runner.ts`) — the
draft-worktree authoring surface — now passes `runKind: 'build'` to the core.
The data-only `makeChatRunner` (`packages/agent-runtime/src/chat-adapter.ts`)
leaves it unset, so its turns default to `'chat'`. No data migration: the `kind`
column already exists on `runs` and already defaults appropriately (Centraid is
pre-release).

## Out of scope

- **Distinguishing build turns that *edit code* from build turns that only read
  data.** Under the unified surface a single turn can both author code and
  answer a data question; this change tags by surface, not by whether the
  draft worktree was actually dirtied. Content-level attribution (diffing the
  worktree before/after the turn) is a larger, separate change.
- **Backfilling historical `kind='chat'` rows that were really builds.** Pre-release,
  no migration — existing rows stay as recorded.
- **Surfacing the build/chat split in the desktop insights UI** beyond the
  existing "Builds" bucket label.

## Verification

- `npx turbo run typecheck` — all 17 package typecheck tasks pass (after a
  worktree-local `bun install` so cross-package `@centraid/*` types resolve to
  the worktree, not main's stale dist).
- `npx turbo run test` for `@centraid/app-engine` and `@centraid/gateway` — green.
- New test in `packages/app-engine/src/chat-history.test.ts`: a default turn
  persists as `kind='chat'` and an explicit `kind: 'build'` turn persists as
  `'build'`, read back through a fresh `AgentRunsStore` on the same
  `runtime.sqlite`. The same test confirms **transcript reconstruction from runs
  and run_nodes is unaffected by the new kind** — a build turn round-trips
  through `getSession` to the same user/ai message shape as a chat turn
  (`listRunsByConversation` is not kind-filtered).
- New assertion in `packages/gateway/src/unified-chat-runner.test.ts`:
  `runner.runKind === 'build'`.
- **insights-store Builds grouping now reflects real rows**: `bucketLabel` in
  `packages/app-engine/src/insights/insights-store.ts` already maps
  `kind === 'build'` → `'Builds'`, and the recent-runs query is not
  kind-filtered, so builder runs now surface under that label instead of the
  enum value being dead.
