# issue-107 — Three-tool invocation surface with manifest-driven dispatch

GitHub issue: [#107](https://github.com/srikanth235/centraid/issues/107)

Replace the per-handler HTTP routes (`POST /_run`, `GET /_data/<query>`)
with exactly three generic tools dispatched against a per-app `app.json`
manifest. The manifest carries JSON Schema (draft 2020-12) for every
handler's `input` / `output`; the dispatcher validates inputs with Ajv
before invoking the handler in the existing worker. Handler files
become pure function bodies — no JSDoc-driven validation, no schema
exports.

## Checklist

- [x] Manifest type and Ajv validator
- [x] Three-tool dispatcher
- [x] HTTP shim and route surgery
- [x] Template migration
- [x] Builder harness updates
- [x] openclaw-plugin tool registration
- [x] Browser UI helpers
- [x] Path-mode retirement (follow-up commit)

## What changed

### Manifest type and Ajv validator

### Three-tool dispatcher

`packages/runtime-core/src/manifest.ts` exports a `Manifest` TS type, a
`MANIFEST_JSON_SCHEMA` document for external validators, and a
runtime-side `validateManifest` / `parseManifest` pair backed by Ajv
(`ajv/dist/2020`). The validator rejects missing or unsupported
`manifestVersion` with a dedicated code (`unsupported_manifest_version`),
flags duplicate handler names within a single array, and allows the
same name across `actions[]` and `queries[]` (they're dispatched
through different tools so collisions are unambiguous).

`packages/runtime-core/src/dispatcher.ts` adds a `Dispatcher` class with
`write`, `read`, and `describe` methods. It reads `app.json` from the
resolved code dir, caches the parsed manifest keyed on
`(codeDir, mtimeMs)` so a version flip or dev-watch rewrite invalidates
immediately, and caches per-handler Ajv validators inside that entry.
Errors are returned as MCP-shaped envelopes:
`{ isError: true, content: [{type:'text', text: JSON.stringify(...)}],
structuredContent: { code, message, path? } }`. Error codes:
`UNKNOWN_APP`, `UNKNOWN_ACTION`, `UNKNOWN_QUERY`, `WRONG_KIND`,
`INVALID_INPUT`, `INVALID_MANIFEST`, `NO_ACTIVE_VERSION`,
`HANDLER_ERROR`.

`WRONG_KIND` is surfaced when the caller addresses a query through
`centraid_write` (or vice versa) — better than `UNKNOWN_ACTION`, which
would falsely suggest the handler doesn't exist.

### HTTP shim and route surgery

`packages/runtime-core/src/router.ts` removed the `app-data` and
`app-run` route kinds and the parser branches for `/_data/<name>` /
`/_run`. Added one new kind, `tool-invoke`, parsed from
`POST /centraid/_tool/<toolName>`. The toolName-shape check is
deliberately loose at the router level; the dispatcher's `isToolName`
guard returns 404 for unknown tools.

`packages/runtime-core/src/runtime.ts` wires `Runtime.dispatcher` (a
shared `Dispatcher` instance) and a private `handleToolInvoke` method
that parses the JSON body, dispatches to `dispatcher.write/read/describe`,
and maps `isError` → HTTP status via `statusForToolError` (404 for
UNKNOWN_*, 400 for WRONG_KIND/INVALID_INPUT, 503 for NO_ACTIVE_VERSION,
500 otherwise).

### Browser UI helpers

`packages/runtime-core/src/static-server.ts` extended the auto-injected
change-bridge script to also expose `window.centraid.write`,
`.read`, and `.describe`. They derive the app id from
`location.pathname` (the iframe is served at `/centraid/<id>/...`) and
POST to `/centraid/_tool/<toolName>` — a single shim, no per-app
plumbing.

### Template migration

All app templates ship full manifests:

- `packages/app-templates/todos/app.json` — actions: add (none),
  toggle (none), delete (required); queries: list.
- `packages/app-templates/journal/app.json` — actions: save (none),
  delete (required); queries: get, list-dates.
- `packages/app-templates/hydrate/app.json` — action: set-cups (none);
  query: get-today.
- `packages/app-templates/auto.*` — manifestVersion + empty
  actions/queries (automation-only apps have no app actions/queries).

Frontend `app.js` files in each template switched from
`fetch('_data/list')` and `fetch('_run', { body: { action, args } })`
to `window.centraid.read({ query, input })` and
`window.centraid.write({ action, input })`.

### Builder harness updates

`packages/builder-harness/src/scaffold.ts` emits a starter manifest
(`manifestVersion: 1`, `id`, `actions: []`, `queries: []`) so the
builder agent has the shape to extend as it generates handlers.
README templates were moved to `scaffold-defaults.ts` to keep
`scaffold.ts` under the 500-line repo-hygiene cap.

`packages/builder-harness/src/publish.ts` validates `app.json` through
the runtime validator before tarring, and additionally enforces that
every declared action/query has a matching handler file on disk. An
invalid manifest fails the publish loudly (`HarnessError('invalid_manifest')`)
rather than uploading a broken app the dispatcher would then refuse
on every call.

`packages/builder-harness/src/clone.ts` rewrites the manifest's `id`
field to the new app id so the dispatcher's id check matches the
registry id.

`packages/builder-harness/src/system-prompt.ts` was rewritten with a
new "App manifest" section, updated layout block (no more `_run` /
`_data/<name>` URLs), and revised handler-contract guidance ("pure
function bodies — dispatcher validates input").

### openclaw-plugin tool registration

`packages/openclaw-plugin/src/lib/tools.ts` registers three new agent
tools — `centraid_describe`, `centraid_write`, `centraid_read` — that
delegate to `runtime.dispatcher`. The scope guard enforces both
`appId` (the field name the existing `centraid_sql_*` tools use) and
`app` (the new field name), and exempts `centraid_describe` from the
session-scope check when no `app` is provided (the legal cross-app
"list all apps" call).

### Path-mode retirement (follow-up commit)

Discussion around the deferred "dev-watch manifest regeneration"
criterion surfaced the architectural smell behind it: the desktop's
local gateway used path-mode (register an external folder live) for
authored apps, which is a divergent execution path the remote
gateway doesn't have. The decision for v0 was to retire path-mode
entirely so the local and remote gateways take identical input.

- `packages/runtime-core/src/types.ts` — `AppMode` removed; `RegistryEntry`
  drops the `mode` field. The doc on the type spells out the new
  invariant.
- `packages/runtime-core/src/registry.ts` — `register({mode})` removed;
  only `ensureUploaded(id)` (idempotent upsert from the upload route)
  remains. Legacy `_registry.json` rows carrying a `mode` field are
  loaded transparently and the field is dropped on next persist. The
  `not_a_directory` error code is gone (no external paths to validate).
- `packages/runtime-core/src/app-paths.ts` — `appCodeDir` no longer
  branches; `activeVersion` is required, falsy throws
  `AppPathError('no_active_version')`.
- `packages/runtime-core/src/dispatcher.ts` + `runtime.ts` —
  `resolveCodeDir` simplified to one branch.
- `packages/runtime-core/src/router.ts` — removed
  `kind: 'registry-register'`; the `POST /centraid/_apps` route is gone.
- `packages/runtime-core/src/runtime.ts` — removed all
  `entry.mode !== 'uploaded'` 409 guards (unreachable now) and the
  `registry-register` case.
- `packages/runtime-core/src/deregister-cleanup.ts` — dropped the
  `'path-mode'` skip reason; the defense-in-depth "outside appsDir"
  check stays.
- `packages/builder-harness/src/gateway-client.ts` — `AppRegistryRow`
  drops `mode`; `fetchAppSchema` no longer treats 409 as "no schema".
- `apps/desktop/src/main/ipc.ts` — comment + version-list 409 fallback
  trimmed.
- Tests: `chat-routes.test.ts`, `dispatcher.test.ts`, and
  `deregister-cleanup.test.ts` updated to use `ensureUploaded(id)`
  with a real `current.json` + `versions/v_*/` layout instead of the
  former path-mode shortcut.

Total: -83 net lines, 470 tests still pass.

## What did NOT change

- `ChangeBus`, `ChangeTracker`, the `/centraid/<id>/_changes` SSE
  endpoint, and the invalidate-only payload shape — all untouched. The
  refactor sits above this layer.
- The handler-runner / worker isolation — the dispatcher hands off
  through the same `runHandler` API.
- The chat surface (`POST /centraid/<id>/_chat`) — unchanged.

## Out of scope

- **Multi-caller RBAC**. The dispatcher itself stays permissionless;
  each action declares `confirmation: "none" | "required"` and the
  chat surface honours it. Per-caller permissions land once
  multi-user or sandboxed automations exist.
- **MCP-side delivery of change events to chat/agent clients**. The
  `ChangeBus` and SSE feed continue to serve only the per-app iframe;
  agents don't subscribe.
- **Auto-generated manifest from filesystem scan in path-mode**. The
  manifest is always builder-emitted and always required. (Path-mode
  itself is retired in the follow-up commit on this branch — see
  receipts/issue-107-followup-retire-path-mode.md if/when added.)
- **A fourth tool for subscriptions**. The three tools are it; live
  invalidations stay on the existing SSE channel.

## Deferred follow-ups

- **Dev-watch manifest regeneration** for path-mode apps was listed in
  the acceptance criteria. Made obsolete by the parallel decision to
  retire path-mode entirely; covered in a follow-up commit on this
  branch.
- **End-to-end "boot real runtime + invoke via shim" integration
  test** — the handler-runner's worker entry resolves a
  compiled-output path (`dist/worker/runner.js`), which makes it
  awkward to exercise from a tsx-driven unit test. Covered indirectly
  via `dispatcher.test.ts` (validation + error mapping) and
  `router.test.ts` (route parsing).

## Verification

Local pipeline (`bun run check && bun run typecheck && bun run test`)
green:

- `bun run check` — oxfmt + oxlint clean.
- `bun run typecheck` — 16 turbo tasks, no errors.
- `bun run test` — 471 pass, 0 fail across all packages.

Manual smoke (deferred to follow-up branch given the path-mode retirement
in flight): boot the local gateway, register the todos template, call
`POST /centraid/_tool/centraid_describe` with `{ "app": "todos" }`, then
`POST /centraid/_tool/centraid_write` with
`{ "app": "todos", "action": "add", "input": { "text": "first" } }`,
then `POST /centraid/_tool/centraid_read` with
`{ "app": "todos", "query": "list" }` and observe the appended row.

## Tests

- `packages/runtime-core/src/manifest.test.ts` — validator surface,
  manifestVersion enforcement, duplicate detection, Ajv round-trip.
- `packages/runtime-core/src/dispatcher.test.ts` — describe at each
  filter depth, error-code coverage, WRONG_KIND enforcement,
  INVALID_MANIFEST surface.
- `packages/runtime-core/src/router.test.ts` — new `/_tool/<name>`
  shape, removed `/_run` / `/_data` shapes, unaffected routes.
- `packages/builder-harness/src/publish.test.ts` — updated fixture so
  the tarball regression test ships a valid manifest.

Full suite: 471 tests pass (330 runtime-core, 84 agent-runtime, 32
builder-harness, 21 openclaw-plugin, 4 chat-harness).
