# Quality Tracker

## Open

- Nothing tracked yet.

## Resolved

- #171 — Retired the crash-resume journal, dropped the `ctx.invoke` API surface, and consolidated `chat-runner-core` down beside the automation fire spine in one backend-agnostic engine: relocated the agent-turn contract to app-engine, renamed `@centraid/automation-engine` → `@centraid/conversation-engine`, and split its `src/` into `chat/` + `automation/`.
- #162 — Consolidated sibling packages: folded `@centraid/analytics` into app-engine's `insights/` sub-module and renamed `@centraid/automation` → `@centraid/automation-engine`.
