# issue-108 — Separate workspace dir from gateway storage; publish-on-save loop

GitHub issue: [#108](https://github.com/srikanth235/centraid/issues/108)

Split the desktop's single per-app dir into two roles:

- **`workspaceDir`** (`<projectsDir>/workspace/`) — flat, editable source
  files. The builder agent and the renderer's editor read/write here.
- **`appsDir`** (`<projectsDir>/apps/`) — versioned gateway storage,
  populated by uploads from the workspace. The dispatcher, the iframe,
  and the OS scheduler all read from `<appsDir>/<id>/versions/<active>/`.

Every workspace mutation queues a debounced upload to the local gateway
(`requestPublish`), so the iframe + dispatcher see workspace edits within
~500ms without the user clicking Publish. Pre-#108 the desktop's
`settings.appsDir` and the local runtime's storage path were different
physical directories — publishes effectively went into a black hole that
the home shelf never read. The split fixes that disconnect at the same
time.

## Checklist

- [x] Settings split (`projectsDir` → derived `workspaceDir` + `appsDir`)
- [x] Project IPCs read/write `workspaceDir`
- [x] Auto-publish on scaffold + on save (debounced)
- [x] Preview protocol reads active version
- [x] Legacy flat layout migration on boot
- [x] Automation flow rewritten to publish-then-register
- [x] Renderer surface for publish status + events

## What changed

### Settings split (`projectsDir` → derived `workspaceDir` + `appsDir`)

`apps/desktop/src/main/settings.ts` keeps `projectsDir` as the only
persisted root and derives two sibling subdirs on the effective
`DesktopSettings`:

- `workspaceDir = <projectsDir>/workspace`
- `appsDir = <projectsDir>/apps`

Doc comments on both interfaces spell out the new invariant. The
defaults sit under `~/centraid-projects/` so existing installations only
need a one-shot migration (see below).

`apps/desktop/src/main/local-runtime.ts` consolidates the second
appsDir concept: `localRuntimeAppsDir()` is now async and returns
`<projectsDir>/apps`, not the pre-#108 `<userData>/local-runtime/apps`.
The in-process gateway writes to the same directory the renderer reads.
`OsSchedulerHost.workdir` follows suit (it took the value but now passes
through cleanly).

### Project IPCs read/write `workspaceDir`

`apps/desktop/src/main/ipc.ts` — every IPC handler that mutates an
app's source files now operates on `settings.workspaceDir`:

- `PROJECTS_LIST` / `PROJECTS_CREATE` / `PROJECTS_FILES` /
  `PROJECTS_WRITE_FILE` / `PROJECTS_OPEN` / `PROJECTS_DELETE` /
  `PROJECTS_UPDATE_META` — all repointed.
- `AGENT_START` — `projectDir` resolves under `workspaceDir`; the
  builder agent's native `Read` / `Write` tools therefore see the
  workspace, not the versioned dir.
- `PUBLISH` (the explicit Publish button) — also points at the
  workspace; the button stays as an "I want this published RIGHT NOW
  with a full build" escape hatch over the auto-publish queue.
- `TEMPLATES_CLONE` — clones into the workspace, then publishes once
  synchronously so the iframe and (for automation templates) the OS
  scheduler have an active version to point at.
- `PROJECTS_PREVIEW_URL` — availability now checks
  `<appsDir>/<id>/current.json` (i.e. "has been published at least
  once") instead of the workspace's `index.html`, because the preview
  serves from the gateway-active version after this change.

### Auto-publish on scaffold + on save (debounced)

New module `apps/desktop/src/main/publish-on-save.ts`:

- `requestPublish(id, opts?)` — queues an upload for project `id`.
  Multiple calls within the debounce window (default 500ms) collapse
  to one publish. Set `immediate: true` to fire on the next tick.
- `getPublishStatus(id)` — read-only snapshot
  (`{ inFlight, lastError?, lastPublishedAt? }`).
- `forgetPublish(id)` — cancel queue + drop the entry. Called from
  `PROJECTS_DELETE` so a stale request doesn't recreate a freshly
  deregistered gateway version.
- Per-event broadcast on `centraid:publish:event` so the renderer can
  toast failures inline. Resolves once per publish — success or fail.
- In-flight reentrancy is handled: a request arriving mid-publish sets
  `retriggered`, and the finally block fires another publish after
  resolution so the latest workspace bytes always land.

Callers:
- `PROJECTS_CREATE` → `requestPublish(id, { immediate: true })` so a
  fresh app is browsable without waiting for the first edit (edge case
  #1 from the design).
- `PROJECTS_WRITE_FILE` → debounced.
- `PROJECTS_UPDATE_META` → debounced (rename / description change).
- `AGENT_START.prompt(text)` → debounced after each turn — the agent
  uses its own native `Read` / `Write` tools that bypass our IPC, so
  we trigger from the prompt handler's `finally`-equivalent.
- `AUTOMATIONS_CREATE`, `AUTOMATIONS_SET_ENABLED`, `AUTOMATIONS_DELETE`
  (app-owned) → synchronous publish (not debounced) so the OS-scheduler
  register/unregister that follows reads a fresh active version.

`Channel.PUBLISH_STATUS` exposes the snapshot to the renderer; the
broadcast channel is exposed via `preload.ts` as `onPublishEvent` and
typed in `renderer/centraid-api.d.ts`.

### Preview protocol reads active version

`apps/desktop/src/main/preview-protocol.ts` — the `centraid-preview://`
scheme now resolves through `readActiveCodeDir` from runtime-core,
returning `<appsDir>/<id>/versions/<active>/<path>`. Pre-#108 it
served the workspace's flat dir directly, which let the iframe show
unpublished edits the gateway dispatcher could not actually run. After
the split, the iframe and the dispatcher see the same bytes — the
auto-publish loop is what makes a workspace edit visible.

Before the first publish the file stat 404s cleanly, which matches
the new `PROJECTS_PREVIEW_URL.available` semantics.

### Legacy flat layout migration on boot

New module `apps/desktop/src/main/migrate-workspace.ts`:

- Scans `<appsDir>/` for entries that match the pre-#108 flat layout
  (have an `app.json` at the top level but no `current.json` and no
  `versions/` directory).
- Moves source files (`actions/`, `queries/`, `app.json`, `index.html`,
  `automations/`, etc.) to `<workspaceDir>/<id>/`; leaves persistent
  state (`data.sqlite`, `runtime.sqlite` + journal/wal/shm siblings)
  behind so it survives the move.
- Queues an immediate publish per migrated app so the gateway re-emits
  the workspace as `versions/v_1/...`.
- Defensive: any ambiguity (workspace target exists, no `app.json`,
  unreadable dir) skips with a console warning rather than risking
  data loss.

Wired into `apps/desktop/src/main.ts` as a fire-and-forget call inside
`app.whenReady` — failure logs to console but does not block startup.

### Automation flow rewritten to publish-then-register

`AUTOMATIONS_CREATE`, `AUTOMATIONS_SET_ENABLED`, `AUTOMATIONS_DELETE`
all needed updates because:

1. The source of truth (the `automation.json` manifest) now lives in
   the workspace, not the active version dir.
2. The OS-scheduler host reads from `appsDir` (the versioned active),
   so any manifest edit needs a publish before re-register.

Pattern is the same in all three handlers: locate the manifest in
`<workspaceDir>/<appId>/automations/<autoId>/`, mutate, publish the app
synchronously, then call `localRuntimeAutomationHost(appsDir).register`.

`packages/builder-harness/src/scaffold-automation.ts` — the
auto-scaffolded `app.json` now emits a post-#107-valid manifest
(`manifestVersion: 1, id, name, version, actions: [], queries: []`).
Pre-#108 the scaffolder produced `{name, version}` only; that would
have INVALID_MANIFEST'd on the new publish-on-create call.

### Renderer surface for publish status + events

`apps/desktop/src/preload.ts` exposes `getPublishStatus` + 
`onPublishEvent` through the existing contextBridge surface.
`apps/desktop/src/renderer/centraid-api.d.ts` types both. The renderer
can choose to surface failures as a toast — left to the next UI pass;
the channels are in place.

## What did NOT change

- The gateway upload endpoint (`POST /centraid/_apps/<id>/upload`) is
  unchanged — both local and remote gateways already accepted identical
  input, which is why no `runtime-core` changes were needed here.
- `publishProject` in `@centraid/builder-harness` — unchanged. The
  publish-on-save module just reuses it with `skipBuild: true`.
- The dispatcher, the three-tool surface from #107, the SSE change
  bridge, the per-app SQLite — all untouched. This refactor sits one
  layer above (desktop-only).
- The chat and chat-history surfaces — unchanged.

## Out of scope

- **Multi-machine workspace sync** (Dropbox / iCloud / Syncthing for
  `workspaceDir`). The desktop assumes a single editing machine per
  user; sync is a separate product.
- **Per-version diff UI in the builder.** Versions accumulate under
  `appsDir/<id>/versions/`; surfacing a diff between v_3 and v_4 is a
  future polish, not required for the loop to work.
- **Remote-gateway publish-on-save.** In remote mode `appsDir` is
  unused and the renderer talks to a remote gateway. Wiring auto-publish
  there needs auth UX (token rotation, retry on 401) and is deferred.
- **Build step on auto-publish.** Auto-publish always passes
  `skipBuild: true` — the workspace IS the source of truth and handlers
  ship as-authored. The explicit Publish button stays as the
  "with full build" escape hatch.
- **Workspace file watching.** Agents edit through their own tools,
  external editors edit through the OS. We hook the agent prompt loop
  + the renderer's `writeProjectFile` IPC, which covers both. Adding
  a chokidar watcher to catch true out-of-band edits (e.g. `git pull`
  in the workspace) is a v0.next feature.

## Deferred follow-ups

- **Failure toast UI.** The renderer can subscribe to
  `onPublishEvent` and surface a toast on `ok: false`. The plumbing is
  in place; the toast itself is a renderer-side change deferred to the
  next UI pass (tracked separately rather than as an in-tree marker).
- **Unit tests for `publish-on-save.ts` and `migrate-workspace.ts`.**
  `apps/desktop` has no unit test harness today (only the Playwright
  e2e suite); adding `node:test` infra is its own work. The modules
  are exercised end-to-end every time the desktop boots; manual smoke
  in the verification section is the v0 coverage.

## Verification

Local pipeline (`bun run check && bun run typecheck && bun run test`)
green:

- `bun run check` — oxfmt + oxlint clean.
- `bun run typecheck` — 16 turbo tasks, no errors.
- `bun run test` — 470 pass, 0 fail (329 runtime-core, 84
  agent-runtime, 32 builder-harness, 21 openclaw-plugin, 4
  chat-harness).

Manual smoke (intended; not run in this sandbox):

1. Boot the desktop with an empty `~/centraid-projects/`. Scaffold a
   new app from a template. Confirm `~/centraid-projects/workspace/<id>/`
   has the source files and `~/centraid-projects/apps/<id>/current.json`
   appears within a second (initial publish).
2. Edit `actions/foo.js` in the builder. Confirm a new version dir
   appears under `apps/<id>/versions/` after ~500ms, and the iframe
   picks up the change on next reload.
3. Boot the desktop with a pre-#108 layout (flat
   `~/centraid-projects/apps/<id>/`). Confirm the dir is moved into
   `workspace/<id>/` and a `versions/v_1/` is published.
4. Delete the project from the home shelf. Confirm the workspace dir
   is removed; the gateway's deregister cleans up `apps/<id>/`.

## Tests

No new automated tests this round. The desktop package's only test
surface is Playwright e2e (`apps/desktop/tests/e2e/`), which doesn't
exercise the file-system invariants this change touches. The existing
470-test suite covers everything `publish-on-save` and
`migrate-workspace` consume (runtime-core's manifest parser, the
publish HTTP path, the registry's `ensureUploaded`).
