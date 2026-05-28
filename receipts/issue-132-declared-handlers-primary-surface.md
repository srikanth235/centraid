# issue-132 — Declared actions/queries are the agent's primary surface; `_sql` is a built-in escape hatch

GitHub issue: [#132](https://github.com/srikanth235/centraid/issues/132)

The per-app chat used to expose two parallel tool families to the agent
— `centraid_{describe,read,write}` for handler dispatch and
`centraid_sql_{describe,read,write}` for raw SQL — toggled by a `mode`
flag where `"data"` collapsed the agent down to SQL only. The defaults
were inverted: declared actions/queries are the UX the app author
designed, and raw SQL should be the escape hatch for asks the author
didn't predict, not a primary surface for an entire chat mode.

This change collapses the two families into one. The agent always has
the three structured tools; SQL is reachable as a built-in `_sql`
handler dispatched through the same three-tool entry points. There is
one chat mode.

## Checklist

- [x] Built-in handler dispatch in runtime-core
- [x] Reserved-name validation at manifest load
- [x] `centraid_describe` returns schema alongside manifest
- [x] Remove SQL tool family from both hosts and collapse chat-runner mode
- [x] Collapse `build-extra-prompt` to one prompt
- [x] Drop ChatMode end-to-end (v0 / no migration)

## What changed

### Built-in handler dispatch in runtime-core

`packages/runtime-core/src/dispatcher.ts`'s `write` and `read` branch
on `isReservedHandlerName(name)` before manifest lookup. Built-in
implementations live in a sibling
`packages/runtime-core/src/dispatcher-builtins.ts` so the dispatcher
stays under the 500-line repo-hygiene cap.

`_sql` via `centraid_read` accepts a single SELECT or EXPLAIN; via
`centraid_write` accepts a single INSERT/UPDATE/DELETE/REPLACE.
DDL (CREATE/ALTER/DROP), PRAGMA, ATTACH/DETACH, VACUUM, REINDEX are
refused. Guards are the same `isSelectOnly` / `isWriteDml` already
exported from `packages/runtime-core/src/sql-ops.ts`; they used to live
in `openclaw-plugin/src/lib/tools.ts` and are now one layer in. Writes
fire the dispatcher's existing `onWriteFor(appId)` change-bus closure
so iframe re-renders and chat-UI correlations stay precise — no
behavioral change for downstream listeners.

### Reserved-name validation at manifest load

`packages/runtime-core/src/manifest.ts` exports
`RESERVED_HANDLER_PREFIX = '_'` and adds a `reserved_handler_name`
`ManifestValidationCode`. `validateManifest` refuses any action or
query whose name starts with `_` so a collision with the runtime's
built-in surface surfaces at manifest load time with a clear message,
not as silent shadowing at call time.

### `centraid_describe` returns schema alongside manifest

A whole-app describe (`{ app }` with neither `action` nor `query`) now
returns `{ manifest, schema }`. The schema comes from `readAppSchema`
on the app's `data.sqlite` and falls back to an empty schema on read
failure. Agents almost always need both — the manifest to match an
utterance against declared handlers and the schema to compose a `_sql`
fallback — so bundling them avoids the round-trip.

### Remove SQL tool family from both hosts and collapse chat-runner mode

`packages/openclaw-plugin/src/lib/tools.ts` drops
`centraid_sql_describe`, `centraid_sql_read`, `centraid_sql_write` and
the `isSelectOnly`/`isWriteDml` guards (which moved to runtime-core in
an earlier slice). The scope guard covers only the three structured
tools and the `appId`/`app` field-name reconciliation is gone.

`packages/agent-runtime/src/codex-centraid-tools.ts` and the in-process
MCP server in `packages/agent-runtime/src/claude-sdk.ts` now declare
`centraid_describe`/`_read`/`_write`, all dispatching through the
shared runtime-core `Dispatcher`. `_sql` lands as a built-in inside the
dispatcher (same path as HTTP callers).

`ToolContext` (in `packages/agent-runtime/src/runtime.ts`) now carries
`{ appId, dispatcher, agentTurnId }`. The dispatcher fires the host's
change bus internally, so the adapter doesn't need an `emitChange`
closure anymore — that was specific to the legacy `centraid_sql_write`
tool. The desktop's local-runtime supplies the dispatcher via a
`getDispatcher` closure that closes over the local `Runtime`
(cycle-broken the same way `getChangeEmitter` was before).

`packages/openclaw-plugin/src/lib/openclaw-chat-runner.ts` loses the
`input.mode === 'data'` branches: no more conditional `toolsAllow`
(the three structured tools are always available), no
`disableMessageTool` toggle, one workspace dir instead of two,
`promptMode` always `'full'`.

### Collapse `build-extra-prompt` to one prompt

`packages/runtime-core/src/build-extra-prompt.ts` collapses from two
flavored prompts (`full`/`data`) to one. The single prompt names the
three structured tools, lists the app's declared actions and queries
with descriptions + input schemas (so an agent matching an utterance
can pick the right entry), and explicitly names `_sql` as the fallback
with its SELECT-only / no-DDL constraints.

The chat-route in `packages/runtime-core/src/chat-routes.ts` loads the
manifest from the active code dir and threads it into
`buildExtraPrompt`. `versions` was added to `ChatRouteContext` so the
route can resolve the active code dir without going through the
dispatcher.

### Drop ChatMode end-to-end (v0 / no migration)

The `ChatMode` type, the `mode` field on `ChatRunInput` /
`ChatSessionMeta` / desktop session state / chat-harness POST body,
and the `mode` column on the `chat_sessions` SQLite table are all
gone. The chat-history `POST /sessions` route no longer reads `mode`
from the body, and `store.createSession(appId, title)` is two args.
v0 / no-backward-compat per the memory note made this clean.

`packages/builder-harness/src/system-prompt.ts`'s change-bus prose was
updated to name the new agent tool (`centraid_write` with `_sql`
action) instead of the retired `centraid_sql_write`.

## What did NOT change

- The three-tool URL surface (`POST /centraid/_tool/centraid_{describe,read,write}`)
  and the in-iframe `window.centraid.{describe,read,write}` helpers.
- The `app.json` wire format other than the new reserved-prefix rule.
- Per-app session-key scope check (still pins the agent to one app, now
  guarding three tools instead of six).
- The change-bus / SSE feed. `_sql` writes emit the same
  `source: 'agent'` event the legacy `centraid_sql_write` did, so the
  per-app `/_changes` listener and the desktop's tool-pill rendering
  see no protocol change.

## Out of scope

- Streaming or long-running queries — `_sql` stays single-statement.
- Cross-app reach — refused; the session-key scope is unchanged.
- Multi-statement SQL transactions exposed to the agent — author an
  action if you need transactional behavior.
- Builder UX work to nudge authors toward agent-readable
  action/query descriptions. The runtime is in place; that's a separate
  follow-up.
- Per-app opt-out for `_sql` (e.g. `app.json#agent.builtins: { sql: false }`).
  Easy to add later; not in this slice.

## Verification

Local pipeline green:

- `bun run typecheck` — 16 turbo tasks, no errors.
- `bun run lint` — oxlint 0 warnings, 0 errors.
- `bun run test` — all packages green (runtime-core 338, the rest
  unchanged from the prior baseline).

## Tests

- `packages/runtime-core/src/manifest.test.ts` — reserved-name
  validation for actions and queries.
- `packages/runtime-core/src/dispatcher.test.ts` — describe now
  returns `{ manifest, schema }`; new tests for `_sql` read
  (SELECT round-trip), `_sql` write (INSERT rowsAffected), refusals
  (INSERT-via-read, DDL-via-write), missing-input error, and
  unknown-builtin name (`_nope`) routing to UNKNOWN_QUERY /
  UNKNOWN_ACTION.
- `packages/runtime-core/src/chat-history.test.ts` — trimmed `mode`
  parameter from every `createSession` call; HTTP-route test no longer
  asserts on `mode`.
- `packages/runtime-core/src/gateway-db.test.ts` — cascading-delete
  fixture no longer inserts a `mode` column value.
- `packages/openclaw-plugin/src/lib/tools.test.ts` — dropped the
  `isSelectOnly`/`isWriteDml` duplicate tests (the guards live in
  runtime-core's `sql-ops.test.ts`); only `appIdFromSessionKey` stays
  here.
- `packages/chat-harness/src/chat-client.test.ts` — the "forwards mode"
  test became "forwards model"; the chat-mode parameter is gone from
  the public surface.
