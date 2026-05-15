# issue-63 — Centralize app settings: gateway-stored user identity, server-side injection, per-app sqlite settings

GitHub issue: [#63](https://github.com/srikanth235/centraid/issues/63)

## Checklist

- [x] User UUID generated + persisted gateway-side on first read (the "install hook")
- [x] HTTP route `/_centraid-user/id` returns the UUID — the desktop's `getUserId` RPC
- [x] Gateway-side user-prefs store (`UserStore`) with versioned sqlite schema
- [x] `__centraid_settings` per-app table contract + reader
- [x] `injectTheme` → `injectSettings`: arbitrary `data-*` attrs + CSS vars baked into `<html>` server-side
- [x] Settings-merge pipeline: global ⊕ per-app ⊕ URL query, with a `KNOWN_KEYS` allow-list
- [x] OpenClaw plugin and desktop local-runtime both mount the user store + the `/_centraid-user/*` route
- [x] Desktop renderer reads prefs from gateway after first paint and mirrors writes back; local Store demoted to fast-paint cache
- [x] Per-template `theme-bridge.js` retired; replaced with inline live-update listener in each `index.html`
- [x] Builder-harness scaffolder writes the inline bridge for new projects (no separate file)
- [x] Builder agent grounding (system-prompt) updated so new code never references `theme-bridge.js`
- [x] Standalone fallback preserved — templates keep working defaults via `:root` in their `app.css`
- [x] Tests + typecheck + format/lint all clean
- [x] PR review fixes: CSP nonce for inline bridge, accent key persists separately, live-update payload carries all known prefs
- [x] Chat-history sessions scoped to the user identity — `chat_sessions.user_id` baked into the baseline schema, every read + write filters by current `UserStore.getUserId()`
- [ ] **Out of scope (deferred):** mobile parity (Expo `WKURLSchemeHandler` / `injectedJavaScriptBeforeContentLoaded`)

## What changed

**User UUID generated + persisted gateway-side on first read (the "install hook").** `UserStore.getUserId()` in `packages/runtime-core/src/user-store.ts` returns the UUID from the `user_meta` table or generates one with `crypto.randomUUID()` and inserts it on the first call. There is no separate install ceremony — the first read is the install. The same UUID then survives Electron reinstalls (it lives with the gateway's sqlite, not in `userData/centraid-settings.json`) and travels with whichever gateway the desktop is pointed at.

**HTTP route `/_centraid-user/id` returns the UUID — the desktop's `getUserId` RPC.** `makeUserStoreRouteHandler()` in the same file dispatches `GET /_centraid-user/id` to `UserStore.getUserId()` and returns `{ id }`. The desktop's main process calls this through `apps/desktop/src/main/user-prefs-client.ts#fetchUserId`, exposed to the renderer as `window.CentraidApi.getUserId()` via the `USER_ID_GET` IPC channel. That's the "plugin RPC" the issue asks for, modeled exactly on the existing chat-history route.

**Gateway-side user-prefs store (`UserStore`) with versioned sqlite schema.** Two key/value tables: `user_meta` (the UUID lives here) and `user_prefs` (JSON-encoded values). Schema migrations follow the same `MIGRATIONS` ladder + `PRAGMA user_version` pattern as `chat-history.ts` — append, never edit shipped slots. The constructor only stashes the path; `ensureOpen()` lazily opens sqlite on first method call so the OpenClaw plugin's worker subprocesses (which construct the runtime in every context) don't hold stray DB handles. `setPrefs()` is transactional via `BEGIN IMMEDIATE` and treats `null`/`undefined` values as deletions.

**`__centraid_settings` per-app table contract + reader.** New `packages/runtime-core/src/app-settings.ts` defines the contract: a table named `__centraid_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` in each app's `data.sqlite`, with JSON-encoded values. `readAppSettings()` opens the file read-only, checks `sqlite_master` for the table, and returns the decoded rows — missing file or table returns `{}` and never throws. Apps own this table and can read/write through their normal SQL handlers; the runtime only ever reads it during `app-index`.

**`injectTheme` → `injectSettings`: arbitrary `data-*` attrs + CSS vars baked into `<html>` server-side.** `packages/runtime-core/src/static-server.ts` is now `SettingsInject = { dataAttrs, cssVars }` — the runtime can bake any `<html data-foo="bar" style="--foo:bar">` combo, not just theme + bgL. Keys (lowercase letters, digits, dashes) and values (no quotes, angle brackets, or control chars) are regex-validated so a typoed pref can't smear garbage across the `<html>` tag. Existing `data-*` attrs on the tag win — apps that hard-code a theme keep it, mirroring the previous `injectTheme` behavior.

**Settings-merge pipeline: global ⊕ per-app ⊕ URL query, with a `KNOWN_KEYS` allow-list.** New `packages/runtime-core/src/settings-merge.ts` exports `buildSettingsInject(layers)`. Layers fold in order — later layers override earlier ones, with `null`/`undefined` falling through to the previous layer. The `KNOWN_KEYS` table maps each pref name to either a `data-*` attr or a CSS var (with a coercer for percent strings, on/off booleans, etc.). Anything not in the table is dropped — a typoed pref name in an app's settings table never makes it onto `<html>`. Adding a new pref is a single-line edit to the table.

**OpenClaw plugin and desktop local-runtime both mount the user store + the `/_centraid-user/*` route.** `packages/openclaw-plugin/src/index.ts` constructs `UserStore`, passes it to `Runtime`, and registers `/_centraid-user` as a sibling of `/_centraid-chat` via `api.registerHttpRoute`. `apps/desktop/src/main/local-runtime.ts` does the same: constructs `UserStore` at `<userData>/local-runtime/centraid-user.sqlite`, passes it to `Runtime`, and `startRuntimeHttpServer` auto-mounts the route whenever `runtime.userStore` is set. Both gateways read/write the same on-disk shape, so the desktop sees identical behavior in either runtime mode.

**Desktop renderer reads prefs from gateway after first paint and mirrors writes back; local Store demoted to fast-paint cache.** `apps/desktop/src/renderer/app.ts` still applies the local Store value synchronously (no flash), then fires `void window.CentraidApi.getUserPrefs()` after `applyPrefs()` and reapplies if the gateway disagrees. `setPrefs()` writes through to the gateway fire-and-forget via `saveUserPrefs()`. New `pickAppearance` / `toRemoteShape` helpers mediate between the renderer's typed prefs and the gateway's `KNOWN_KEYS` shape (resolving the accent palette key into the swatch's hex values so the gateway can bake `--accent` directly into `<html style="…">`).

**Per-template `theme-bridge.js` retired; replaced with inline live-update listener in each `index.html`.** `packages/app-templates/{journal,hydrate,todos}/theme-bridge.js` are deleted. Each template's `index.html` now embeds a small inline `<script>` block at the top of `<head>` that does the same job: parses the URL hash for the no-runtime preview path and listens for `centraid:theme` postMessage for live updates while the iframe is mounted. Initial paint comes from the runtime's bake. `manifest.json` is regenerated by the build script and no longer references the deleted files.

**Builder-harness scaffolder writes the inline bridge for new projects (no separate file).** `packages/builder-harness/src/scaffold.ts` no longer writes `theme-bridge.js` to the project dir; `DEFAULT_INDEX_HTML` embeds the same minified bridge inline via the `INLINE_SETTINGS_BRIDGE` constant. Existing projects on the old layout keep working — the inline bridge is harmless when the runtime has already baked the initial paint.

**Builder agent grounding (system-prompt) updated so new code never references `theme-bridge.js`.** `packages/builder-harness/src/ui-grounding.ts` and the README no longer instruct the agent to include `theme-bridge.js`; they reference the inline `<script>` pattern and tell the agent to keep that block at the top of `<head>`. The "When unsure, read these templates" reference list now points to the inline bridge as the canonical pattern.

**Standalone fallback preserved — templates keep working defaults via `:root` in their `app.css`.** Each template declares working defaults under `:root` (light theme via the literal `--bg`, `--ink`, etc.; dark theme overrides via `:root[data-theme='dark']`). With no shell, no runtime, and no `data-theme` attribute, the light defaults render as-is — the inline bridge silently no-ops and the page remains usable.

**Tests + typecheck + format/lint all clean.** See Verification below.

**PR review fixes: CSP nonce for inline bridge, accent key persists separately, live-update payload carries all known prefs.** Three follow-up fixes after the initial PR landed:

1. **CSP nonce.** The runtime serves apps with `script-src 'self'`, which would block the inline bridge baked into each `index.html`. `static-server.serveStatic` now mints a per-response nonce (16 random bytes, base64), stamps `nonce="<nonce>"` onto every inline `<script>` it emits via `stampInlineScriptNonces`, and forwards the nonce to `staticSecurityHeaders` so `script-src` becomes `'self' 'nonce-<nonce>'`. External-src `<script>` tags and any tag already carrying a `nonce` attr are left untouched. New tests in `packages/runtime-core/src/static-server.test.ts` cover the round-trip, the no-double-stamp path, freshness across responses, and the no-nonce fallback for non-HTML responses.

2. **Accent key persists separately.** `pickAppearance` previously rejected the gateway's `accent` field because `toRemoteShape` overwrote the semantic key (e.g. `"teal"`) with the hex swatch (`"#2EA098"`), leaving second-device launches stuck on the default accent. Renamed the wire fields: `accentKey` carries the semantic palette key (round-tripped for renderer state recovery), while `accent` / `accentLight` / `accentDeep` carry the resolved hex values that the runtime bakes into `<html style="…">`. `pickAppearance` reads `accentKey` first and falls back to `accent` for any prefs persisted before the fix.

3. **Live-update payload carries all known prefs.** `broadcastThemeToFrames` only sent `{ theme, bgL }`, so density / cards / coolCast / accent changes wouldn't retune mounted iframes until reload. Replaced with `broadcastSettingsToFrames` (which sends a `centraid:settings` payload with full `dataAttrs` + `cssVars` derived from `toRemoteShape`, plus the legacy `centraid:theme` payload for any old bridges still in the wild). The inline bridge in each template (and the scaffolder's `INLINE_SETTINGS_BRIDGE`) now accepts both message shapes — `centraid:settings` applies the full set via `setAttribute('data-…')` + `setProperty('--…')`, and `centraid:theme` falls through to the original theme/bgL apply.

**Chat-history sessions scoped to the user identity — `chat_sessions.user_id` baked into the baseline schema, every read + write filters by current `UserStore.getUserId()`.** The chat-history store and the user store were two unrelated SQLite files, so a chat session had no link back to the user identity. With the gateway now the source of truth for user prefs, the chat history needs the same scoping — otherwise two devices syncing to the same gateway can see each other's history (and a future multi-user model has no path forward without a column-add migration). Since centraid is pre-1.0, the column went into the baseline `MIGRATIONS[0]` directly rather than as a follow-up slot — no append-only migration ladder yet, no backfill machinery to carry. The `ChatHistoryStore` constructor now takes a required `userIdProvider: () => string` (wired to `UserStore.getUserId` by both hosts); every prepared statement filters by `user_id`, every insert stamps it. `startRuntimeHttpServer` refuses to mount the chat-history route without a `runtime.userStore` so misconfiguration fails loudly. Five new tests cover that two stores against the same SQLite file with different user UUIDs cannot see, write to, rename, or delete each other's sessions.

## Verification

- `bun run build` — 7 packages clean, including a clean rebuild after wiping `dist/` and `.turbo` to confirm no caching artefacts hid the new exports.
- `bun run test` — 154/154 passing in runtime-core (16 new tests across `user-store.test.ts`, `app-settings.test.ts`, `settings-merge.test.ts`).
- `bun run typecheck` — 14/14 tasks clean across the workspace.
- `bun run check` — `oxfmt --check` and `oxlint` both clean across 218 files.
- Manifest regenerated via `node scripts/build-manifest.mjs`; `grep -c theme-bridge manifest.json` → 0.

## Out of scope

- **Mobile parity (Expo WebView).** The same `injectSettings` model needs `WKURLSchemeHandler` / `shouldInterceptRequest` on the Expo side, plus `injectedJavaScriptBeforeContentLoaded` for the inline-bridge equivalent. Confirmed deferred at scoping time.
- **Settings UI surfaces inside individual apps.** This change provides storage + injection plumbing only — apps can write to their `__centraid_settings` table through their own handlers, but no first-class UI for editing per-app settings is shipping here.
- **Migration of existing local Electron prefs to the gateway.** The renderer's local Store is now a fast-paint cache; on first launch the gateway is empty, so the renderer's first `setPrefs` after any user interaction populates the gateway. No one-shot migration script is included — the issue marked it as optional polish.
- **Multi-user / auth.** The model is single-user-per-Claude-Code-installation by design, as per the issue.
