# issue-84 — split gateway SQLite into per-domain files

GitHub issue: [#84](https://github.com/srikanth235/centraid/issues/84)

## Checklist

- [x] Three migration ladders in `gateway-db.ts`
- [x] Foreign keys preserved in-file; cross-file FK dropped
- [x] Consumers rewired
- [x] Tests
- [x] `npm run typecheck` — 16/16 packages pass
- [x] `npm run test` — 12/12 package tasks pass, 420 tests green
- [x] `npm run lint` — 0 warnings, 0 errors

## What changed

**Three migration ladders in `gateway-db.ts`.** The single `MIGRATIONS` array and `openGatewayDb`/`makeGatewayDbProvider` pair were replaced by three migration constants — `GATEWAY_MIGRATIONS` (`users` + `user_prefs`), `CHAT_MIGRATIONS` (`chat_sessions` + `chat_messages`), `AUTOMATION_MIGRATIONS` (the `automations` mirror + `automation_runs` / `automation_run_nodes` / `automation_state`) — and three `open*`/`make*Provider` function pairs over a shared generic `openDb`/`makeProvider` core. Each file carries its own `PRAGMA user_version` and migrates independently; the version-mismatch error names the offending domain. The three files are `centraid-gateway.sqlite`, `centraid-chat.sqlite`, and `centraid-automations.sqlite`.

**Why.** Every per-user record previously lived in one `centraid-gateway.sqlite`. A schema drift in one domain (a missing `automations.origin_app_id` column) could only be recovered by wiping the whole file, taking users + prefs + chat history down with it. The single file also serialized every write — chat turns, automation runs, prefs saves — against one SQLite write lock. Splitting by domain isolates blast radius, removes cross-domain write contention, and lets each domain migrate without risking the others.

**Foreign keys preserved in-file; cross-file FK dropped.** In-file FK cascades are kept: `user_prefs → users`, `chat_messages → chat_sessions`, and the automation self-FKs (`automation_runs.parent_run_id`, `automation_run_nodes.run_id`). The one cross-domain FK — `chat_sessions.user_id → users.id ON DELETE CASCADE` — was dropped, because SQLite cannot enforce a foreign key across files (not even with `ATTACH`). `user_id` stays as a column but is now application-enforced. Deleting a user no longer cascades their chat sessions/messages; no current code path deletes users, so nothing regresses, but a future user-deletion path must clean the chat file explicitly.

**Consumers rewired.** Each store now receives the provider for its domain: `UserStore` ← gateway, `ChatHistoryStore` ← chat, `AutomationStore` + `AutomationRunsStore` ← automations. `packages/openclaw-plugin/src/index.ts` and `apps/desktop/src/main/local-runtime.ts` build three sibling-path providers; the desktop gains `localRuntimeChatDb()` / `localRuntimeAutomationDb()` helpers. `apps/desktop/src/main/ipc.ts` swaps its automation-only provider closure to `getAutomationDbProvider`. The `Runtime` constructor option `gatewayDb` (only ever used to build `AutomationRunsStore`) was renamed `automationDb`; `automations-provider.ts`'s `gatewayDbProvider` option became `automationDbProvider`; `run-automation-local.ts`'s `gatewayDb` option became `automationDb`. `os-scheduler-host.ts` renamed its `gatewayDbPath` config to `automationDbPath` and the env var it bakes into launchd/systemd/Task-Scheduler artifacts from `CENTRAID_GATEWAY_DB` to `CENTRAID_AUTOMATION_DB`; `centraid-cli.ts` reads the new env var and falls back to `<appDir>/centraid-automations.sqlite`.

**Tests.** `gateway-db.test.ts` was rewritten to exercise each of the three ladders separately — fresh-DB version advance, table set, version-too-new throw, and FK behavior — including an assertion that `chat_sessions` declares no foreign key. The old users↔chat cascade test was removed (that FK no longer exists); per-file cascades (`user_prefs` from `users`, `chat_messages` from `chat_sessions`) are tested in place. The `seedUsers` helper in `chat-history.test.ts` was deleted — with no FK there's nothing to satisfy — and chat/automation test files were repointed to `makeChatDbProvider` / `makeAutomationDbProvider`.

## Out of scope

- **Migrating existing data** out of an old single-file `centraid-gateway.sqlite` into the three new files. No migration shim is provided — pre-1.0 the DB is recreated on next access; the only live install was reset before this change landed.
- **Multi-user / multi-tenant** support. `chat_sessions.user_id` stays a single-user-model column; the split neither adds nor blocks a future multi-tenant move.
- **A user-deletion cleanup path** for the chat file. Dropping the cross-file FK means deleting a user no longer cascades their chat data — but no code path deletes users today, so no cleanup routine was added.
- **Per-app automation DB files.** The automations domain stays one shared `centraid-automations.sqlite` so the cross-app `ctx.invoke` `parent_run_id` self-FK keeps working (a self-FK can't cross SQLite files).

## Verification

- `npm run typecheck` — 16/16 packages pass
- `npm run test` — 12/12 package tasks pass, 420 tests green (incl. the rewritten `gateway-db.test.ts` and repointed chat/automation suites)
- `npm run lint` — 0 warnings, 0 errors
