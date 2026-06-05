# issue-141 — IPC vs HTTP: full remote-gateway support

GitHub issue: [#141](https://github.com/srikanth235/centraid/issues/141)

The desktop talks to the runtime over two channels: Electron IPC
(`centraid:*`, the privileged renderer↔main control plane) and the
gateway's HTTP server (the runtime/data plane reachable by any
non-renderer caller). Issue #141 sets that principle, audits the split,
and documents it.

This PR goes further: make **connecting to a remote gateway actually
work**. Several desktop operations previously ran only against the local
embedded gateway and threw for remote because they read/wrote the
git-store worktree or local SQLite directly. They now go over the
existing (and a few new) HTTP routes, so every renderer→runtime
operation works identically against local or remote gateways while
genuinely Electron-native operations stay on IPC.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Builder-harness file-map scaffolders
- [x] Webhook provisioning over a file map
- [x] Session file-delete route + shared route-helpers
- [x] Automation + insights HTTP routes
- [x] Reconcile OS scheduler on publish/delete/rollback
- [x] Desktop scaffold/clone/meta over HTTP
- [x] Desktop automation CRUD over HTTP
- [x] Desktop automation read/run/analytics over HTTP
- [x] PROJECTS_OPEN + AGENT_* gated as the only local-only handlers
- [x] IPC-vs-HTTP concept doc + token audit
- [x] CORS on the local gateway for renderer-direct HTTP
- [x] Renderer token bridge + app read surface over direct HTTP
- [x] Renderer data plane over direct HTTP — versions, user prefs, automation reads, insights
- [x] Draft preview served through the gateway runtime
- [x] Gateway owns the template catalog (GET /centraid/_templates)
- [x] Gateway owns the app lifecycle (create/clone/meta/automation CRUD over HTTP)
- [x] Renderer owns app editing sessions + lifecycle over direct HTTP; desktop IPC handlers deleted
- [x] Gateway runs the unified chat turn in the app's draft worktree with the union of tools
- [x] Data-chat panel streams the gateway _chat SSE directly; desktop chat IPC deleted
- [x] Builder chat streams the gateway _chat SSE; in-process AGENT_* path + agent-session.ts deleted
- [x] Builder preview iframe points at the gateway _draft URL; centraid-preview:// protocol + PROJECTS_PREVIEW_URL deleted
- [x] Drop the desktop builder-harness/chat-harness/app-templates deps; relocate template refresh to the gateway; rewrite the thin-client/unified-chat docs
- [x] Remove post-thin-client vestigial code: orphaned chat-harness package, dead gateway-ws WS client + ws deps; correct stale chat-harness/centraid-preview references
- [x] Renderer surfaces gateway delete failures instead of reporting a phantom success

## What changed

**Builder-harness file-map scaffolders.** The scaffold / clone / rename /
automation flows can no longer assume a local workspace directory — for a
remote gateway the desktop has no filesystem access to the worktree. Added
filesystem-free `*Files` variants that emit a `{path, content}[]` map the
caller PUTs into a git-store session and publishes over HTTP:
`scaffoldProjectFiles` / `updateProjectMetaFiles` / `appPackageJson` (new
`packages/builder-harness/src/scaffold-files.ts`, with the content
templates moved out of `scaffold.ts`); `cloneTemplateFiles`
(`clone.ts`); `scaffoldAutomationProjectFiles` /
`setAutomationEnabledInFiles` / `deleteAutomationFromFiles`
(`scaffold-automation.ts`). The existing dir-writing helpers now wrap the
pure variants, and `project-rewrites.ts` exposes pure `rewriteTitleInHtml`
/ `applyManifestName` shared by both paths.

**Webhook provisioning over a file map.** `provisionAppPendingWebhooks`
read/rewrote `automation.json` on disk, so it couldn't run for a remote
gateway. Added `provisionPendingWebhooksInFiles(files, ownerApp)` in
`packages/runtime-core/src/automation-webhook.ts`: it scans a draft file
map for pending webhook triggers, mints the route id + secret
desktop-side (crypto), rewrites each trigger to its provisioned
`{kind,id,secretHash}` form, and returns the updated map plus the minted
secrets to show once. Only the hash reaches the gateway.

**Session file-delete route + shared route-helpers.** App-owned automation
delete needs to remove files from a session worktree over HTTP, which the
git-store surface couldn't do (it had GET/PUT files only). Added
`DELETE /centraid/_apps/<appId>/files/<path>?sessionId=` to
`apps-store-routes.ts` `handleFiles` (same path-escape guard as PUT), and
extracted the shared `sendJson` / `readBody` / `readJson` / `fileExists`
HTTP helpers into `packages/gateway-runtime/src/route-helpers.ts` so the
new automations routes can reuse them.

**Automation + insights HTTP routes.** New
`packages/gateway-runtime/src/automations-routes.ts`
(`makeAutomationsRouteHandler`) mounted as a second `extraHandlers` entry
in `serve()`. Serves the automation runtime ops the desktop used to do
against local files/SQLite: `GET /centraid/_automations` (list),
`/read`, `POST /run-now` (fires on the gateway host via an injected
`runAutomationLocal` closure with the gateway's own runner), the run feed
`/runs` + per-run `/run`, `/run/nodes`, `/run/pin`, and
`GET /centraid/_insights/summary`. Code resolves from the materialized
`main`; run ledgers + analytics from the stable `appsDir`. Refs/run ids
ride query params to avoid slash-in-path parsing.

**Reconcile OS scheduler on publish/delete/rollback.** `serve()`'s
`onAppLive` / `onAppDeleted` previously only touched the registry, so a
publish over HTTP never updated the OS scheduler (only a startup reconcile
ran). Added a coalesced, fire-and-forget `reconcileScheduler()` that
re-scans `active-main/apps` and reconciles the full desired set via the
existing `schedulerHostFactory`; it now runs on publish, delete, and
rollback (rollback already calls `onAppLive`) as well as at startup. This
lets the desktop drop its direct scheduler register/unregister calls (next
commit) and makes a remote gateway reconcile its own scheduler. Also fixed
`@centraid/apps-store`'s `SAFE_ID_RE` to allow the `auto.` dot (rejecting
`..`), without which automation-app publish through the git store failed.
(That dot allowance was later removed under issue #98 when the `auto.`
prefix convention was replaced by `app.json#kind` — app ids are plain
slugs again.)

**Desktop scaffold/clone/meta over HTTP.** The three project-lifecycle IPC
handlers that still computed a local worktree path now go entirely over
the git-store HTTP surface, so they work against a remote gateway:
- `PROJECTS_CREATE` builds the file map with `scaffoldProjectFiles`,
  rejects an id already on `main`, then `ensureProjectSession` →
  `writeDraftFiles` → `publishApp`.
- `PROJECTS_UPDATE_META` reads the app's draft over HTTP, applies the
  `{name,description}` patch with `updateProjectMetaFiles` (duplicate-name
  guard checks the published apps list), and writes back only the changed
  files.
- `TEMPLATES_CLONE` reads the desktop-bundled template's files via a new
  `readTemplateFiles` (`@centraid/app-templates`), rewrites them with
  `cloneTemplateFiles`, provisions pending webhooks with
  `provisionPendingWebhooksInFiles` (secret minted desktop-side, only the
  hash published), then PUTs + publishes. The remote gateway never needs
  the catalog.
All three drop `ensureProjectSessionAppsParent`; the local-worktree
helpers (`ensureProjectSessionDir`/`…AppsParent`) now survive only for the
genuinely-local PROJECTS_OPEN + AGENT_* paths (gated in a later commit).
A new `writeDraftFiles` batch helper (`apps-store-client.ts`) loops the
single-file PUT, and `httpProjectInfo` synthesizes the `ProjectInfo`
return (no local dir to stat — the canonical metadata flows back through
`listProjects()`).

**Desktop automation CRUD over HTTP.** The three automation-mutation IPC
handlers move off the local worktree onto the git-store HTTP surface, and
the desktop stops touching the OS scheduler directly:
- `AUTOMATIONS_CREATE` builds the file map with
  `scaffoldAutomationProjectFiles`, rejects an id already on `main`, mints
  webhook secrets desktop-side (hash only published), then session-PUT +
  publish. (The created `row` is still read back from the local
  materialized tree until C8 moves automation reads over HTTP.)
- `AUTOMATIONS_SET_ENABLED` reads the app's draft over HTTP, flips the flag
  via `setAutomationEnabledInFiles`, writes back only the changed manifest,
  and publishes.
- `AUTOMATIONS_DELETE`'s app-owned branch reads the draft, computes the
  removed paths with `deleteAutomationFromFiles`, DELETEs them through the
  session file-delete route (new `deleteDraftFiles` client helper), and
  republishes; the whole-automation-app branch already used the HTTP app
  delete.
All four direct `localRuntimeAutomationHost(...).register/unregister` calls
(create, set-enabled, delete, and the template-clone post-publish block)
are removed — the local gateway's `serve()` is wired with
`schedulerHostFactory`, so its `onAppLive`/`onAppDeleted` reconcile the
scheduler on publish/delete (C5); a remote gateway reconciles its own.
Drops the now-unused `ensureProjectSessionAppsParent`,
`localRuntimeAutomationHost`, `APP_AUTOMATIONS_SUBDIR`,
`readAutomationProjectAt`, `setAutomationEnabledAt`, `deleteAutomationAt`
imports from `ipc.ts`.

**Desktop automation read/run/analytics over HTTP.** The eight read/run/
analytics IPC handlers that hit local SQLite + the materialized tree
become thin proxies over the gateway's `/centraid/_automations` +
`/centraid/_insights` routes (added in C4), so the Automations + Insights
screens work against a remote gateway:
`AUTOMATIONS_LIST/READ/RUN_NOW/LIST_RUNS/READ_RUN/LIST_RUN_NODES/PIN_RUN`
and `INSIGHTS_SUMMARY`, plus the `AUTOMATIONS_CREATE` row read-back. New
client methods live in `apps-store-client.ts` (`listAutomationsHttp`,
`readAutomationHttp`, `runAutomationNow`, `listAutomationRunsHttp`,
`readAutomationRunHttp`, `listAutomationRunNodesHttp`,
`pinAutomationRunHttp`, `insightsSummaryHttp`) over the same active-gateway
auth as the git-store surface. Deletes the local `AnalyticsStore` /
`AutomationRunsStore` / `InsightsStore` / `runAutomationLocal` /
`runsStoreForRunId` / `summaryToRunRow` / per-gateway analytics-provider
machinery from `ipc.ts` and the imports that fed it.

Two consequences worth noting:
- **Run-now executes on the gateway host** with *its* runner + provider
  key — a remote fire does not use the desktop's key (the route mints the
  run id and fires fire-and-forget; the renderer polls it as before).
- **Delete no longer purges analytics.** There's no HTTP route to delete
  run summaries and the desktop no longer owns an `AnalyticsStore`, so a
  deleted automation's run history stays in the central ledger until the
  app's data dir is reaped gateway-side. (The three now-dead
  `localRuntime*` data-dir exports are flagged for a follow-up cleanup.)

**PROJECTS_OPEN + AGENT_* gated as the only local-only handlers.** With C6–C8
moving scaffold / clone / meta / automation CRUD / read / run / analytics
onto HTTP, the desktop's last filesystem-bound operations are exactly two:
PROJECTS_OPEN (reveal the worktree in Finder) and AGENT_* (the in-process
codex/claude builder that edits the on-disk worktree). Both legitimately
require a local gateway (a remote one exposes no worktree). This commit
makes that boundary explicit rather than incidental:
- `project-sessions.ts` factors the local-gateway check into a named
  `assertActiveGatewayLocal(action)` guard and tightens
  `ensureProjectSessionDir`'s doc to state it now serves ONLY those two
  flows. The now-unused `ensureProjectSessionAppsParent` (its scaffold/
  clone callers moved to HTTP) is deleted.
- The PROJECTS_OPEN + AGENT_START handlers carry comments declaring them
  the deliberate local-only surface; the guard throws a clear
  "requires the local gateway" error as the backstop.
- The renderer hides the "Open project folder" affordance when
  `window.Centraid.getRuntimeMode() === 'remote'`, so a remote user never
  hits the backstop error for it.

**IPC-vs-HTTP concept doc + token audit.** Adds
`docs/concepts/ipc-vs-http.mdx` (Mintlify concept-doc style) capturing the
principle (HTTP by default; IPC only for renderer↔main / token-hiding /
Electron-native ops), the three buckets (A already-proxied, B
Electron-native, C migrated in #141) with their final disposition, what
stays local and why (PROJECTS_OPEN + AGENT_*), and the token-boundary
audit. Registered in `docs.json` under the Architecture group and
cross-linked from `architecture.mdx` + `gateway.mdx`.

**Token audit.** Ran
`grep -rn "gatewayToken|Bearer|Authorization" apps/desktop/src/renderer apps/desktop/src/preload*`.
Result: no renderer/preload code authenticates a request with the gateway
token. The matches are the settings **input form** where the user types a
gateway token (handed to main over IPC to be stored), two UI placeholders,
and a webhook-setup instruction string. The renderer's single direct
network call is an unauthenticated `GET <live-url>/app.json` (public app
manifest for knobs). Every bearer-authenticated gateway call lives in
`apps/desktop/src/main/*` — the privileged token never crosses into
renderer request code.

---

### Thin-client follow-on — renderer talks HTTP directly; the gateway owns the builder

The audit above settled the *boundary*; this follow-on acts on its
conclusion. Rather than relay the runtime/data plane through the main
process, the renderer now calls the gateway directly with a Bearer token
(injected at startup), and the gateway becomes the owner of the full
builder — deterministic lifecycle, template catalog, webhook minting, and
the AI agent — so local and remote behave identically and the IPC surface
shrinks to genuinely Electron-native ops. Landed in phases; this section
grows per phase.

**CORS on the local gateway for renderer-direct HTTP.** A renderer that
calls the gateway directly is cross-origin (and sends `Origin: null` from a
`file://` page), so the local embedded server must answer CORS. Added
`setCorsHeaders` to `packages/runtime-core/src/http-server.ts`, called at
the top of `route()` so every response — including the 401 and the SSE
streams (Node merges `setHeader` values into a later `writeHead`, so the
chat-routes / changes-sse writers inherit them unchanged) — carries
`Access-Control-Allow-Origin: *`. Because auth is a Bearer header (never a
cookie) there are no ambient credentials to leak, so `*` is safe and also
covers the `file://` origin; no custom `app://` scheme is needed. An
OPTIONS preflight is answered with 204 *before* the Bearer check (preflight
carries no token). Remote/OpenClaw front-door CORS is a tracked follow-up.

**Renderer token bridge + app read surface over direct HTTP.** Establishes
the thin-client foundation and migrates the first method group off IPC.
Main exposes a single new `GATEWAY_AUTH_GET` channel
(`getGatewayAuth(): { baseUrl, token }`, resolved from keychain-backed
settings) — the one point the bearer token crosses to the renderer. New
`apps/desktop/src/renderer/gateway-client.ts` caches that auth, refreshes
it on `onGatewayChanged`, and issues `fetch` calls directly against the
active gateway (local loopback or remote URL). The app read surface —
`appLiveUrl` / `appSchema` / `appTableRows` / `appQuery` / `appLogs` /
`deregisterApp` — moves there verbatim (same input shapes, same
404/503→`undefined` schema semantics, a `GatewayClientError` mirroring
`HarnessError` codes); their IPC handlers + preload methods + channel
constants are deleted, and the `app.ts` / `builder.ts` call sites import
the functions instead of reaching through `window.CentraidApi`. These were
pure proxies over `@centraid/builder-harness`'s gateway-client with no
main-side state, so nothing else changes.

**Renderer data plane over direct HTTP — versions, user prefs, automation
reads, insights.** Extends `renderer/gateway-client.ts` with the rest of the
read/run data plane and deletes the matching IPC. Migrated: version history
(`listVersions` — including the git-store active-tag → `current` +
`activeVersion` shaping the old handler did — and `activateVersion`'s
forward-only rollback); the `/_centraid-user` surface (`getUserId`,
`getUserPrefs`, `saveUserPrefs`); and the automation read/run/analytics
surface (`listAutomations`, `readAutomation`, `runAutomationNow`,
`listAutomationRuns`, `readAutomationRun`, `listAutomationRunNodes`,
`pinAutomationRun`, `getInsightsSummary`). Their IPC handlers + preload
methods + channel constants are deleted, the `CentraidApi` typings are
trimmed, and the `app.ts` / `builder.ts` call sites import the functions
directly. The automation **create / enable / delete** mutators stay on IPC
for now — they orchestrate scaffold + editing session + publish, which moves
to the gateway in a later phase. One behavior dropped deliberately:
`saveUserPrefs` no longer pokes the main-side preflight cache
(`noteRunnerPrefsChanged`); the cache already keys on the runner prefs that
matter (kind / binPath / provider id+baseUrl+envKey) so a meaningful change
re-probes on its own, and the runner-status panel (`getRunnerStatus`)
force-invalidates before every read regardless. Dead client functions in
`main/apps-store-client.ts` (rollback + the automation run/insights proxies)
and `main/user-prefs-client.ts` (`fetchUserId`, `saveUserPrefs`) are removed;
both modules stay because the create-path + the runner-preflight loader still
use `listAutomationsHttp` / `listGitVersions` / `fetchUserPrefs`. The app
shelf's `listProjects` (a pure `GET /centraid/_apps` registry read) moves to
the renderer client too, and `SETTINGS_GET` now strips `gatewayToken` from
its payload — the token reaches the renderer only through `getGatewayAuth()`,
and nothing reads it off `getSettings()`.

**Draft preview served through the gateway runtime.** Reordered ahead of the
gateway-owned create/clone work (a newly staged app must be previewable
before the "explicit Publish" flips it live, and per #137 a draft must be
served *through the runtime/store*, never a local path shortcut). The
runtime gains an optional `draftCodeDir(appId, sessionId)` resolver: a
request under `/centraid/_draft/<sessionId>/<appId>/…` serves the open
session worktree's code — static **and** handlers — against the app's live
`data.sqlite`, with the live `/centraid/<appId>/…` path untouched.
Mechanics: `router.ts` gains `parseWithDraft`, which peels the `_draft/
<sessionId>` prefix and re-parses the inner route (query string preserved);
`runtime.handle` threads the session id into the code-dependent cases
(`app-index`, `app-static`, `app-schema`, and `tool-invoke` →
`dispatchTool`), preferring the draft dir over `resolveCodeDir`; the
`Dispatcher`'s `read`/`write`/`describe` take an optional per-call
`overrideCodeDir` so a draft runs its staged handlers without registering a
second app; and `static-server`'s injected bridge becomes draft-aware — it
pins the real `appId` (the path's first segment is `_draft`, which the live
`location.pathname` sniff would mis-read) and routes tool calls through
`/centraid/_draft/<sessionId>/_tool/`. `_changes` stays relative and
resolves to the draft route's app-changes (drafts share the live change
bus). The gateway wires `draftCodeDir` to `appsStore.snapshotSessionAppDir`,
returning `undefined` for an unknown/closed session (→ 503), so the live
backend is wholly unaffected when no draft resolver is configured. The
desktop renderer's iframe still points at the live preview; pointing it at
the `_draft` URL lands with the renderer-visible sessions in the
gateway-owned create + unified-chat phases.

**Gateway owns the template catalog (GET /centraid/_templates).** First slice
of moving the deterministic builder into the gateway: the bundled
`@centraid/app-templates` catalog is now resolved gateway-side and served at
`GET /centraid/_templates`, so the renderer reads it directly instead of
through a desktop IPC. `gateway-runtime` gains an `@centraid/app-templates`
dependency and a `makeTemplatesRouteHandler` (mounted in `extraHandlers`
regardless of the code backend — templates are bundle/cache-resolved,
independent of the git store); `GatewayPaths` gains an optional
`templatesCacheDir` so a remote-pulled template can shadow the bundled copy
(the desktop's `local-runtime` passes its per-gateway cache dir, matching the
old IPC's `templatesCacheDir(gatewayId)`). The route returns the same
6-field display projection the desktop IPC did (`files`/`source` stripped).
The renderer's `listTemplates` moves to `gateway-client.ts`; its IPC handler,
preload method, channel, and `CentraidApi` typing are deleted.
`TEMPLATES_CLONE` stays on IPC for now — it scaffolds + provisions webhooks +
opens a session + publishes, and that orchestration moves to the gateway in
the next slice.

**Gateway owns the app lifecycle (create/clone/meta/automation CRUD over
HTTP).** The deterministic builder — scaffolding a blank app, cloning a
template, editing name/description, and creating/toggling/deleting automations
— moves off the desktop and into the gateway as a new `lifecycle-routes.ts`
(`makeLifecycleRouteHandler`, mounted in `serve()`'s `extraHandlers`):
`POST /centraid/_apps` (scaffold), `POST /centraid/_apps/_clone` (clone a
bundled template), `POST /centraid/_apps/<id>/meta` (rename/describe),
`POST /centraid/_automations` (scaffold an automation app),
`POST /centraid/_automations/set-enabled?ref=` (toggle), and
`DELETE /centraid/_automations?ref=` (remove). `gateway-runtime` gains an
`@centraid/builder-harness` dependency so the gateway runs the same
`scaffoldProjectFiles` / `cloneTemplateFiles` / `updateProjectMetaFiles` /
`scaffold*`/`setAutomationEnabledInFiles` / `deleteAutomationFromFiles`
scaffolders the desktop used, plus runtime-core webhook minting
(`provisionPendingWebhooksInFiles` for clone, `generateWebhookId/Secret` +
`hashWebhookSecret` for automation create) — the plaintext secret is returned
once in the response, only the hash lands in the manifest. Every mutation
**stages** into a git-store session worktree (the draft); a `publish` flag
(default off, extending the explicit-publish model) validates the manifest and
merges onto `main` + reconciles the OS scheduler. A staged-only create is
registered via `runtime.registry.ensureUploaded` so its draft is immediately
previewable through the `_draft` route without a `main` version. Shared
`route-helpers` gains `readFileMap`/`writeFileMap` (a `{path,content}[]`
worktree round-trip) and `apps-store-routes` exports `validateManifestAt` so
the lifecycle publish path reuses the same gateway-side manifest validation.
This slice is additive — the desktop's IPC handlers still run; the renderer
cutover + handler/scaffold-dep deletion is the next slice.

**Renderer owns app editing sessions + lifecycle over direct HTTP; desktop IPC
handlers deleted.** The renderer's `gateway-client.ts` gains a per-app editing
session manager (`ensureAppSession`/`dropAppSession`, cleared on gateway swap)
keyed on the SAME `desktop-<appId>` id the main-process `project-sessions.ts`
uses — so the renderer's Code-tab edits and the local-only builder agent share
one draft worktree (whoever opens first wins; a 409 re-open is treated as
success). On top of it the renderer gains the editing surface (`readProjectFiles`/
`writeProjectFile`/`publish`) and the lifecycle surface (`createProject`/
`cloneTemplate`/`updateProjectMeta`/`deleteProject`/`createAutomation`/
`setAutomationEnabled`/`deleteAutomation`), each opening/reusing the session and
calling the Phase-2 gateway endpoints with `publish: true` to preserve
"new/edited app is live immediately" until the preview iframe moves to the draft
URL. `app.ts` + `builder.ts` repoint every call from `window.CentraidApi.*` /
`Api().*` to the imported client functions (the local `cloneTemplate` wrapper
keeps its name; the gateway one is imported as `gwCloneTemplate`). The matching
desktop IPC is deleted: the `PROJECTS_CREATE/FILES/WRITE_FILE/DELETE/UPDATE_META`,
`PUBLISH`, `TEMPLATES_CLONE`, and `AUTOMATIONS_CREATE/SET_ENABLED/DELETE` handlers,
their `Channel` constants, preload methods, and `CentraidApi` typings, plus the
now-dead `ipc.ts` imports (`scaffold*`/webhook-mint, the apps-store draft-file
helpers, `dropProjectSession`, `httpProjectInfo`). `PROJECTS_OPEN` (reveal-in-
Finder) + `PROJECTS_PREVIEW_URL` stay on IPC (local-only / preview), and
`project-sessions.ts` stays for the local-only `AGENT_*` + `PROJECTS_OPEN` — it
retires with the agent in the unified-chat phase. To stay under the repo
file-size limit the renderer client is split three ways (all re-exported from
`gateway-client.ts` so call sites are unchanged): `gateway-client-core.ts` (auth
cache + fetch/JSON helpers, dependency-free to avoid an import cycle),
`gateway-client.ts` (the data-plane reads), and `gateway-client-editing.ts` (the
session manager + editing + lifecycle).

**Gateway runs the unified chat turn in the app's draft worktree with the
union of tools.** First slice of the unified chat (the gateway-owned AI
builder): one chat surface, both jobs. A new
`packages/gateway-runtime/src/unified-chat-runner.ts`
(`makeUnifiedChatRunner`) is a `ChatRunner` that — unlike the data-only
`@centraid/agent-runtime` `makeChatRunner` it replaces in `serve()` whenever
a git store is active — runs each turn in the app's OPEN draft session
worktree (`worktrees/sessions/desktop-<appId>/apps/<appId>/`, opened
409-tolerantly via the shared `ensureSession`, the SAME id the renderer's
Code tab + the retiring local builder agent use) so the agent's native file
edits stage in the draft. The turn gets the **union of tools**: the
codex/claude adapter's native file/shell tools (workspace-write against
`cwd`) PLUS the `centraid_*` dispatcher threaded via `toolContext` — so the
same turn can author a migration and answer a data question. The system
prompt is unified too: the chat route's data/schema preamble
(`input.extraSystemPrompt`) is kept and the builder authoring blocks are
folded in (`CENTRAID_APPEND_PROMPT` + UI grounding for an app,
`AUTOMATION_APPEND_PROMPT` for an automation — read from the worktree
`app.json#kind` — plus the cached `buildToolsGroundingBlock`, now exported
from `@centraid/builder-harness`). Code edits stage (the preview iframe
reflects the draft); the `centraid_*` tools hit the live `data.sqlite`
(registry-resolved, independent of `cwd`); Publish stays the explicit flip.
Webhook secrets are minted as a post-turn step (`provisionAppPendingWebhooks`
on the worktree — the agent can't generate crypto-random credentials) and
surfaced once via a new `webhooks` `ChatStreamEvent` carrying the
`{automationId, ownerApp, webhookId, url, secret}` (absolute `_centraid-hook`
URL built against the live server origin, published into the runner after
`startRuntimeHttpServer` resolves). The runner takes injectable `runTurn` +
`enumerateTools` seams so it tests hermetically without spawning a real CLI.
This slice is gateway-side only; the renderer SSE cutover + deletion of the
desktop `chat.ts` / `AGENT_*` / `agent-session.ts` / `project-sessions.ts`
is the next slice.

**Data-chat panel streams the gateway _chat SSE directly; desktop chat IPC
deleted.** First renderer slice of the unified-chat merge: the in-app data
chat (`renderer/app-chat.ts`) no longer relays through the desktop main
process. A new dependency-free `renderer/gateway-client-chat.ts` (re-exported
from the `gateway-client.ts` barrel) adds `streamChat` — a `fetch` +
`ReadableStream` reader that POSTs `/centraid/<appId>/_chat` and parses the
SSE frames into the gateway's native `ChatStreamEvent` union (fetch streaming,
not `EventSource`, because we need a POST body + the Bearer header) — plus the
chat-history surface (`listChatSessions` / `createChatSession` /
`loadChatSession` / `renameChatSession` / `deleteChatSession`) over the
gateway's `/_centraid-chat/apps/<appId>/sessions…` routes. `app-chat.ts` now
consumes `ChatStreamEvent` directly (no IPC-translated `CentraidChatEvent`):
it creates the session row lazily on first send (the id IS the window id the
turn streams to), drives the turn through `streamChat` with an
`AbortController` for Stop, targets tool results by the real `toolCallId` (no
more client-minted ids), and surfaces the post-turn `webhooks` event's minted
secret once as an assistant message. Because the gateway-side runner (previous
slice) runs the turn in the app's draft worktree with the union of tools, the
same panel now both tweaks the app's code and operates its data — one chat
surface, both jobs. Deleted: `apps/desktop/src/main/chat.ts` (the whole
`centraid:chat:*` relay), its `registerChatIpcHandlers` / `disposeWindowChatSessions`
call sites in `main.ts` + `ipc.ts`, the `CHAT_*` preload channels + chat
methods, and the `chatStart` / `chatSend` / `chatAbort` / `listChatModels` /
`onChatEvent` / `chatHistory*` `CentraidApi` typings + the now-orphaned
`CentraidChatEvent` / `CentraidChatModel` / `CentraidChatSessionWithMessages`
types (the persisted `CentraidChatSessionMeta` / `CentraidChatHistoryMessage`
shapes stay — the panel still reads history). The settings model picker's
`listChatModels()` call (always empty — the model is gateway-owned) is
inlined to an empty list. The builder's `AGENT_*` surface is untouched in this
slice; its cutover + the agent-machinery deletion is next.

**Builder chat streams the gateway _chat SSE; in-process AGENT_* path +
agent-session.ts deleted.** Completes the unified-chat merge: the builder's
chat (`renderer/builder.ts`) now streams turns through the SAME `streamChat`
transport + native `ChatStreamEvent` model as the app-view data chat — one
chat surface, both jobs. The builder's `handleAgentEvent` (consuming the rich
IPC `CentraidAgentEvent`) is replaced by a `handleStreamEvent(ChatStreamEvent)`
that maps `assistant.delta`/`reasoning.delta` → the text/thinking bubbles,
`tool.start`/`tool.result` → the consolidated tool groups (targeted by the
real `toolCallId`, reloading the draft preview on a successful
file-writing tool), `webhooks` → the minted-secret announcement, and
`final`/`aborted`/`error` → turn settle. `startAgentSession` + the
persisted-message `hydrateChatFromMessages` give way to `ensureChatWindow`
(find-or-create a gateway chat session per project — `continue` reuses the
newest so the gateway resumes the same adapter thread, `fresh` mints a new one
for a first build); `sendUserPrompt` + the three `bootstrap` flows drive
`streamChat` with an `AbortController` for Stop/unmount; the synchronous
post-turn `publishApp` is gone (edits stage in the draft worktree — Publish is
the explicit flip, per the stage-vs-publish model). With the renderer off the
agent IPC, the in-process builder is deleted: the `centraid:agent:*` handlers +
`AGENT_*` channels + the per-window `sessions` map + `disposeWindowSession` +
`capturePreviewSnapshot` (and its now-dead `appsStorePublishApp` /
`provisionAppPendingWebhooks` / `WEBHOOK_ROUTE_PREFIX` / `ProvisionedWebhook` /
`ensureProjectSession`-via-prompt / `localRuntimeCodexHomeBaseDir` /
`MintedWebhookInfo` wiring) in `ipc.ts`, the `startAgent`/`promptAgent`/
`stopAgent`/`onAgentEvent` preload methods + channels, the matching
`CentraidApi` typings + the `CentraidAgentEvent`/`CentraidAgentMessage`/
`CentraidContentBlock` types, and `@centraid/builder-harness`'s
`agent-session.ts` (`createCentraidAgentSession`) + its index exports. The
gateway-side webhook minting (`provisionAppPendingWebhooks` is now called by
the unified runner) and the builder authoring prompt + UI/tools grounding
exports stay. `project-sessions.ts` is retained — `PROJECTS_OPEN`
(reveal-in-Finder) still resolves the on-disk worktree through it. `chat-harness`
is now unused by the desktop (its only consumer, `chat.ts`, is gone); dropping
the dep is a Phase 5 item.

**Builder preview iframe points at the gateway _draft URL; centraid-preview://
protocol + PROJECTS_PREVIEW_URL deleted.** Completes Phase 4: the builder's
preview pane now reflects the **staged draft worktree** served through the
gateway runtime (the `draftCodeDir`/`_draft` machinery from the earlier
gateway-side slice), so chat- and file-driven edits are visible *before* the
explicit Publish flips them live — honoring #137's "serve through the
runtime/store, never a local path shortcut" invariant. A new renderer-side
`draftPreviewUrl(appId)` (`gateway-client-editing.ts`) ensures the app's
`desktop-<appId>` editing session, GET-probes
`/centraid/_draft/<sessionId>/<appId>/` for an `available` flag (so the
"building" skeleton stays up until the draft has an `index.html`), and returns
that URL with a cache-buster. `builder.ts`'s `resolvePreviewSrc` drops the
old two-tier logic (gateway live URL when published, else the
`centraid-preview://` local-files fallback) and always points the iframe at
the draft — after Publish the draft equals live anyway — surfacing a "Draft ·
staged" badge and a "Draft preview" URL pill. The iframe authenticates exactly
like the prior live-URL iframe: the main-process auth-injector stamps the
Bearer header onto every gateway-origin request (top navigation + subresources),
so no token rides in the URL. With the iframe on a real HTTP origin, the
desktop's local preview machinery is deleted: `main/preview-protocol.ts` (the
whole `centraid-preview://` custom protocol), its `registerSchemesAsPrivileged`
+ `registerPreviewProtocol()` wiring and the now-unused `protocol` import in
`main.ts`, the `PROJECTS_PREVIEW_URL` IPC handler + `Channel` constant + the
now-dead `listGitVersions`/`PREVIEW_SCHEME` `ipc.ts` imports, the `previewUrl`
preload method, and the `previewUrl` `CentraidApi` typing. Create/clone keep
`publish: true` deliberately — the registry (`GET /centraid/_apps`) lists apps
on `main`, so an app must publish a baseline version once to exist on the home
grid (its "git init"); from then on edits stage in the draft and Publish flips
each subsequent version. So "auto-publish" is the one-time baseline only, not
per-edit.

**Drop the desktop builder-harness/chat-harness/app-templates deps; relocate
template refresh to the gateway; rewrite the thin-client/unified-chat docs.**
Phase 5 strips the desktop main process to its Electron-native core now that
the gateway owns the builder. Three `@centraid/*` workspace deps leave
`apps/desktop/package.json`: `chat-harness` (its only consumer, `main/chat.ts`,
was deleted in Phase 3), `builder-harness` (its last desktop reference was a
single `HarnessConfig` type import in `main/settings.ts` — the two fields
`gatewayUrl`/`gatewayToken` are inlined into `DesktopSettings` so the dep can
go), and `app-templates`. The last was still live for one thing: the desktop's
startup remote-template fetch (`fetchRemoteTemplates` in `main.ts`'s
`backgroundFetchTemplates`). That refresh **moves into the gateway**, completing
"the gateway owns the template catalog": `GatewayPaths` and
`TemplatesRouteOptions` gain an optional `remoteTemplatesUrl`, and
`makeTemplatesRouteHandler` fires a one-time best-effort `fetchRemoteTemplates`
into its cache dir on construction (non-throwing — offline/404/bad-manifest
leave the cache intact); `serve()` threads it through and the desktop's
`local-runtime.ts` passes `settings.remoteTemplatesUrl` down. `main.ts` deletes
`backgroundFetchTemplates`, its call site, and the `app-templates` +
`templatesCacheDir` imports. `@centraid/agent-runtime` stays — `local-runtime`
+ `ipc.ts`'s `runPreflight` still use it. The three concept docs are rewritten
to the thin-client + unified-chat model: `docs/concepts/ipc-vs-http.mdx` is
reframed around "HTTP is the primary channel, the renderer calls the gateway
directly with a Bearer token, the gateway owns the builder (lifecycle +
templates + webhook minting + unified chat)", documents the **only** remaining
local-only IPC op (`PROJECTS_OPEN`; `AGENT_*` retired with the unified chat),
and reframes the token audit around the **Bearer-in-renderer posture** (first-
party shell top frame, app code in cross-origin iframes, Bearer not cookie so
`ACAO: *` leaks nothing, token delivered only via `getGatewayAuth` + stamped
onto iframe subresource requests by the auth-injector); `gateway.mdx` gains a
"gateway owns the builder" section and corrects "renderer talks over IPC" →
"directly over HTTP"; `architecture.mdx` updates the intro + the chat concept
to one-surface-both-jobs. The same stale "renderer connects over IPC" line is
fixed in `getting-started.mdx` + `deploy/local.mdx`.

### Review fix (PR #138)

- Renderer surfaces gateway delete failures instead of reporting a phantom success.

`deleteProject` and `deleteAutomation` in
`apps/desktop/src/renderer/gateway-client-editing.ts` wrapped their
`readJson` call in `.catch(() => …)`, swallowing every non-2xx response — a
401/404/409/500 from the gateway looked like success and the UI reported the
app/automation as deleted when it wasn't. `deleteProject` also dropped the
draft editing session *before* issuing the DELETE, so a failed delete
discarded the in-progress draft. Both now let `readJson` throw on a gateway
rejection (it already maps status → `GatewayClientError`), and
`deleteProject` deletes first and only `dropAppSession` once the delete is
confirmed.

## Verification

- Renderer surfaces gateway delete failures instead of reporting a phantom
  success: full `bun run build && bun run typecheck && bun run lint && bun run
  test` green across the workspace. Removing the error-swallowing `.catch`
  means a non-2xx DELETE now throws; the gateway-side delete tests confirm
  those routes return real 4xx/5xx + JSON error bodies. No renderer fetch test
  harness exists, so this path is covered by inspection plus the green gate.
- Drop the desktop builder-harness/chat-harness/app-templates deps; relocate
  template refresh to the gateway; rewrite the thin-client/unified-chat docs:
  full `turbo run build typecheck lint test` green across all tasks after a
  `bun install` pruned the three deps. `@centraid/gateway-runtime` typecheck +
  lint clean; `templates-routes.test.ts` adds 2 cases — constructing the
  handler with `remoteTemplatesUrl` + `cacheDir` (and an injected `fetchImpl`)
  fires a remote fetch on construction, and omitting the URL fires none (53
  package tests pass). `@centraid/desktop` typechecks + builds with the inlined
  `DesktopSettings` fields and the relocated fetch; `oxlint` confirms the
  removed `backgroundFetchTemplates` + `HarnessConfig`/`app-templates`/
  `templatesCacheDir` imports left nothing dangling, and grep confirms no live
  `@centraid/builder-harness` / `@centraid/chat-harness` / `@centraid/app-
  templates` import remains in `apps/desktop/src` (only comments). The doc
  rewrites keep every internal link resolving (`no-broken-internal-doc-links`
  green).
- Builder preview iframe points at the gateway _draft URL; centraid-preview://
  protocol + PROJECTS_PREVIEW_URL deleted: full `turbo run build typecheck lint
  test` green across all 28 tasks. The gateway-side draft serving these URLs hit
  is already covered by `draft-preview-over-http.test.ts` (static + staged
  handler + unknown-session 503) and `router.test.ts`'s `parseWithDraft` cases,
  so the renderer `draftPreviewUrl` is a wire shim over a tested route with no
  new server behavior to retest (the desktop package ships no renderer unit
  harness — renderer is browser-loaded `<script type="module">`). `@centraid/
  desktop` typechecks + builds with the new `draftPreviewUrl` client method and
  the iframe repointed; `oxlint` confirms the deleted `preview-protocol.ts`,
  `PROJECTS_PREVIEW_URL` handler/channel, `previewUrl` preload method + typing,
  and the now-dead `PREVIEW_SCHEME` / `listGitVersions` / `protocol` imports
  left nothing dangling.
- `@centraid/builder-harness` typecheck + lint clean;
  `scaffold-files.test.ts` adds 15 cases (52 package tests pass).
- `@centraid/runtime-core` typecheck + lint clean;
  `automation-webhook.test.ts` adds 3 cases (343 package tests pass).
- `@centraid/gateway-runtime` typecheck + lint clean;
  `apps-store-routes.test.ts` adds the DELETE-file + path-escape cases;
  `automations-routes.test.ts` adds 8 cases (run-now invokes the stubbed
  `runAutomation`; list/read/runs/run/insights shapes);
  `serve-scheduler-reconcile.test.ts` asserts a publish triggers a
  reconcile carrying the scanned rows.
- `@centraid/apps-store` adds an `auto.`-id publish + `..`-rejection case.
- Desktop scaffold/clone/meta: full `turbo run build typecheck lint test`
  green across all 28 tasks; `@centraid/desktop` typechecks + builds with
  the rewritten handlers. New `clone-over-http.test.ts` (gateway-runtime)
  boots a real git-store gateway and drives the desktop's exact clone wire
  path — `cloneTemplateFiles` → `provisionPendingWebhooksInFiles` → session
  PUT → publish — asserting the app lands on `main` with a plain-slug id,
  `kind: 'automation'`, and a provisioned webhook (hashed secret, no
  plaintext, no `pending`). The component pieces (file-map scaffolders,
  webhook provisioning, session PUT/publish) keep their own unit coverage.
- Desktop automation CRUD: full suite green; new
  `automation-lifecycle-over-http.test.ts` (gateway-runtime) drives the
  toggle + app-owned-delete wire paths end to end against a real gateway —
  toggling `enabled` republishes the manifest, and deleting the subdir via
  the file-DELETE route + republish removes the automation while the owning
  app survives on `main`.
- Desktop automation read/run/analytics: full suite green; the gateway
  routes the new client methods proxy are covered by
  `automations-routes.test.ts` (C4), so the desktop handlers are one-line
  proxies with no behavior of their own to retest. `oxlint` confirms the
  removed local machinery left no dangling imports in `ipc.ts`.
- Local-only gating: full suite green; `ensureProjectSessionDir` has no
  callers left besides PROJECTS_OPEN + AGENT_START (grep-confirmed), and
  the removed `ensureProjectSessionAppsParent` has no references.
- Docs + token audit: the new concept doc's internal links all resolve
  (`no-broken-internal-doc-links` green) and it's registered in the nav;
  the token-audit grep returns only the form-input / placeholder /
  instruction matches described above — no renderer-side authenticated
  fetch.
- CORS on the local gateway for renderer-direct HTTP:
  `@centraid/runtime-core` typecheck + lint clean; `http-server.test.ts`
  adds 4 cases — an OPTIONS preflight returns 204 with the CORS headers and
  no auth required, and both the 401 and a successful authed 200 carry
  `Access-Control-Allow-Origin: *` (348 package tests pass).
- Renderer token bridge + app read surface over direct HTTP: full
  `turbo run build typecheck lint test` green across all 28 tasks.
  `@centraid/desktop` typechecks + builds with the new ESM
  `renderer/gateway-client.ts` (package is `"type": "module"`, renderer
  scripts load as `<script type="module">`, so the import resolves), and
  `oxlint` confirms the removed IPC handlers / preload methods left no
  dangling imports.
- Renderer data plane over direct HTTP — versions, user prefs, automation
  reads, insights: full `turbo run build typecheck lint test` green across
  all 28 tasks. `@centraid/desktop` typechecks + builds with the expanded
  `renderer/gateway-client.ts`; `oxlint` confirms the removed handlers,
  preload methods, channel constants, and the now-dead `apps-store-client` /
  `user-prefs-client` exports left no dangling imports (the trimmed
  runtime-core type imports in `apps-store-client.ts` resolve clean). The
  gateway routes these client methods call are already covered by
  `automations-routes.test.ts` (C4) and the git-store version/rollback +
  `/_centraid-user` route tests, so the renderer methods are wire shims with
  no new server behavior to retest.
- Draft preview served through the gateway runtime: full `turbo run build
  typecheck lint test` green across all 28 tasks. New
  `draft-preview-over-http.test.ts` (gateway-runtime) seeds + publishes an
  app, opens a session, overwrites its `index.html` + query handler, and
  asserts the live path still serves the published static + handler while
  `/centraid/_draft/<sid>/app/` serves the staged HTML (carrying the
  draft-pinned tool URL) and `/centraid/_draft/<sid>/_tool/centraid_read`
  runs the staged handler against the same data; an unknown session 503s.
  `router.test.ts` adds 6 `parseWithDraft` cases (prefix peeling for
  index/static/tool, query-string preservation, pass-through, empty-session
  guard).
- Gateway owns the template catalog: full `turbo run build typecheck lint
  test` green across all 28 tasks. New `templates-routes.test.ts`
  (gateway-runtime) boots `serve()` and asserts `GET /centraid/_templates`
  401s without a bearer and, when authed, returns a non-empty catalog where
  every row carries the 6 display fields and neither `files` nor `source`.
  `@centraid/desktop` typechecks + builds with `listTemplates` on the
  renderer client and the IPC handler/preload/channel removed.
- Gateway owns the app lifecycle (create/clone/meta/automation CRUD over
  HTTP): full `turbo run build typecheck lint test` green across all 28 tasks.
  New `lifecycle-over-http.test.ts` (gateway-runtime) boots a real git-store
  gateway and drives the endpoints end to end — a stage-only `POST /_apps`
  returns `{sessionId, staged:true}`, leaves the app off the `main` list, yet
  serves its draft `app.json` through `/centraid/_draft/<sid>/<id>/`; a
  `publish:true` create lands on `main` and shows in `GET /_apps`; a duplicate
  id 409s `already_exists`; `…/meta` renames an app on `main`; an automation
  create mints a webhook secret returned once (`/_centraid-hook/` URL) with the
  row read back from `main` and `kind: 'automation'`; and set-enabled →
  whole-app delete flows through publish, removing the app from `main`.
  `@centraid/gateway-runtime` typecheck + lint clean (48 package tests pass).
- Renderer owns app editing sessions + lifecycle over direct HTTP; desktop IPC
  handlers deleted: full `turbo run build typecheck lint test` green across all
  28 tasks. `@centraid/desktop` typechecks + builds with the editing/lifecycle
  methods on `renderer/gateway-client.ts`; `oxlint` confirms the removed IPC
  handlers, `Channel` constants, preload methods, `CentraidApi` typings, and the
  now-dead `ipc.ts` imports + `httpProjectInfo` helper left nothing dangling.
  The gateway endpoints these methods call are covered by
  `lifecycle-over-http.test.ts` + the apps-store session/files/publish route
  tests, so the renderer methods are wire shims with no new server behavior to
  retest. Session sharing with the local agent is by construction (identical
  `desktop-<id>` session id).
- Gateway runs the unified chat turn in the app's draft worktree with the
  union of tools: full `turbo run build typecheck lint test` green across all
  28 tasks. New `unified-chat-runner.test.ts` (gateway-runtime) injects a fake
  `runTurn` against a real `AppsStore` and asserts the turn's `cwd` is the
  `desktop-<appId>` worktree app dir, the `centraid_*` dispatcher + appId ride
  in `toolContext`, the data preamble is preserved with the builder authoring
  blocks folded in, and the adapter resume handle round-trips; a second case
  has the fake turn author a pending-webhook automation and asserts exactly one
  `webhooks` event surfaces a plaintext secret + an `http://…/_centraid-hook/`
  URL while the staged manifest keeps only the hash (no plaintext, no
  `pending`); a third asserts an unconfigured runner emits `error` + rejects.
  `@centraid/gateway-runtime` typecheck + lint clean (51 package tests pass).
- Data-chat panel streams the gateway _chat SSE directly; desktop chat IPC
  deleted: full `turbo run build typecheck lint test` green across all 28
  tasks. `@centraid/desktop` typechecks + builds with `app-chat.ts` rewired
  onto `streamChat` + the `/_centraid-chat` history client and `main/chat.ts`
  removed; `oxlint` confirms the deleted `CHAT_*` channels, preload methods,
  `CentraidApi` typings, and orphaned chat event/model types left nothing
  dangling. The gateway endpoints the transport calls are covered by the
  unified-chat-runner test (turn streaming) + the runtime-core chat-history
  route tests (sessions list/create/load/rename/delete), so the renderer
  transport is a wire shim with no new server behavior to retest.
- Builder chat streams the gateway _chat SSE; in-process AGENT_* path +
  agent-session.ts deleted: full `turbo run build typecheck lint test` green
  across all 28 tasks. `@centraid/desktop` typechecks + builds with `builder.ts`
  rewired onto `streamChat` + `ensureChatWindow` and the `centraid:agent:*`
  handlers / channels / preload methods / `CentraidApi` typings removed;
  `@centraid/builder-harness` typechecks + builds with `agent-session.ts`
  deleted and its index exports dropped (the prompt + grounding exports the
  gateway runner uses remain). `oxlint` confirms the removed handlers, the
  `sessions`/`disposeWindowSession`/`capturePreviewSnapshot` machinery, the
  now-dead `path`/`fs`/webhook-mint/publish imports, and the agent event/message
  types left nothing dangling. The builder turn now hits the same
  unified-chat-runner the data chat does (covered by `unified-chat-runner.test.ts`),
  so there's no new server behavior to retest.
- Remove post-thin-client vestigial code: orphaned chat-harness package, dead gateway-ws WS
  client + ws deps; correct stale chat-harness/centraid-preview references: deleted
  `packages/chat-harness` (audited to zero importers — no package.json dep, no `import` site)
  and `apps/desktop/src/main/gateway-ws.ts` (zero importers; the in-app chat moved to the
  gateway `_chat` SSE in Phase 3), and dropped the now-unused `ws` + `@types/ws` desktop deps,
  regenerating `bun.lock`. Fixed the dangling `@centraid/chat-harness` doc/README links
  (concepts/chat, reference/http-api, openclaw-plugin + builder-harness READMEs, runtime-core
  comments) and the dead `centraid-preview://` CSP `frame-src` token + the template/`ui-and-changes`
  comments, and reframed the (still-live, gateway-consumed) `@centraid/builder-harness` +
  `@centraid/app-templates` docs around gateway ownership. Full `turbo run build typecheck lint
  test` green across all tasks (oxlint 0 warnings on 282 files; gateway-runtime 53 tests,
  runtime-core + agent-runtime + apps-store suites all pass); post-change searches for
  `chat-harness` / `gateway-ws` return only historical receipt mentions.

## Out of scope

Deferred to the agreed follow-up sequence:

- Migrating `@centraid/openclaw-plugin` and the standalone `gateway-runtime`
  daemon CLI onto `serve()` + `appsStoreRoot` (git store), then deleting
  the legacy `VersionStore` / `current.json` / `appCodeDir` machinery.
- Remote builds via the in-process codex/claude agent — `AGENT_*` stays
  local-only; remote gateways build through the chat surface.
- A batch file-write route (the desktop currently loops single PUTs).
- A deeper rewrite of the `@centraid/builder-harness` README surfaces table (it still lists the
  retired `createCentraidAgentSession` + tarball `publishProject`) and the `docs/templates/cloning`
  flow + `gateway.mdx` on-disk-layout section, which describe the legacy `current.json`/`versions`
  VersionStore model — folded into the #137 legacy-layout doc pass.

## Follow-up — automation display fields cross the templates wire

The `GET /centraid/_templates` route originally stripped everything but the
app-template display metadata. The renderer's automation gallery filters on
`kind` and renders cards from `emoji` / `category` / `triggerKind` /
`triggerLabel` / `integrations`, so dropping those left that surface
permanently empty. `makeTemplatesRouteHandler` now passes `kind` plus the
automation-only display fields through (each conditional, so app templates stay
lean), with a regression test asserting `kind === 'automation'` rows carry the
card fields. No resolver-internal fields (`files` / `source`) cross the wire.

Verification: `bun run typecheck` + `bun run lint` green; gateway
`templates-routes.test.ts` passes (auth gate, stripped internals, automation
display-field presence).
