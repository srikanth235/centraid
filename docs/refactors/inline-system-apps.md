# Inline system apps — iframe reserved for builder, app-scoped RPC, token-plane retirement

**Issue:** #505
**Status:** in-progress
**Owner session:** claude/centraid-issue-505-b4d50f

## Goal

Bundled (system) apps mount as inline React routes in the shared shell — no iframe, no
opaque document, no postMessage bridge, no second React runtime — reading and writing
through the shell's replica. The `AppFrame` + `opaqueAppDocument` + `appFrameReplicaBridge`
path remains byte-for-byte, scoped to builder/code-store apps only. The `/centraid/_tool/centraid_*`
app-RPC shim is renamed to app-scoped routes once the iframe bridge is no longer a caller.
The shared admin token plane (`token.bin` / `print-token`) is retired in favor of a
per-device revocable `owner` enrollment trust tier.

## Safety argument

- v0 is pre-release: no backward compatibility or data migrations are owed (repo policy).
- The opaque-document isolation machinery is **not modified** — only the render-path
  decision changes (bundled → inline; code-store → the unchanged `AppFrame` path), so the
  security boundary for actually-untrusted code is untouched.
- Inline apps are shell code with the shell's principal; that is the deliberate decision
  recorded in #505 (the sandbox existed because the tunnel made apps same-origin with the
  shell, not because bundled bytes are untrusted).
- Phases land as separate commits; each phase boundary holds `bun run check:pr` green.
- Writes from inline apps go through the replica intent dispatch carrying `intentId`, the
  same idempotency contract the bridge used (#406 multi-tab findings).
- Token retirement (Phase 7) keeps the per-boot proof header and desktop loopback token;
  identity on iroh paths is already handshake-first, so removing bearer checks there
  removes dead weight, not protection.

## Plan

0. **Baseline measurement** (go/no-go gate) — cold+warm bundled-app open via the existing
   PWA waterfall harness; remote-tunnel cost modeled as measured request count × RTT.
1. **Prerequisites** — CSS scoping for the 8 blueprint apps; bundled-vs-code-store as a
   typed render-path signal; written surface inventory (below).
2. **Shell app services** — one shell-side service per inventoried surface, bound to the
   replica intent dispatch.
3. **Pilot** — Tasks inline end-to-end (lazy chunk, error boundary, sync theming, offline
   render from replica).
4. **Rollout** — agenda, docs, locker, notes, people, photos, tally on the proven contract.
5. **App-scoped RPC** — `/centraid/_tool/centraid_*` → `/centraid/<app>/actions|queries/<name>`;
   Companion + builder bridge re-pointed; no dual-route compat window.
6. **Cleanup + docs write-back** — `centraid_sql_*` ghosts deleted; ARCHITECTURE.md,
   docs/traps/blueprint-csp.md, docs/protocol.md updated.
7. **Token landlord-plane retirement** — `owner` enrollment trust tier; `token.bin` /
   `print-token` / URL+token paste deleted; `direct`-tier decision recorded in
   docs/decisions.md; revocation severs all planes.

## Surface inventory (Phase 1 deliverable)

Every router surface bundled apps consume today, with the serving code, the in-app
consumer, and the shell-native replacement inline apps bind to. Router parse:
`packages/app-engine/src/http/router.ts` (one `Route` kind per row). The served
(iframe/WebView) path keeps all of these — mobile WebViews and the builder preview
still consume them; the rows describe what the **inline** path replaces them with.

| Surface | Serving code | App-side consumer | Shell-native replacement |
| --- | --- | --- | --- |
| `POST /centraid/_tool/<name>` (`centraid_read`/`_write`/`_describe`, kit.query/kit.act) | `router.ts` `tool-invoke`; bridge injected by `static-server.ts` → `bridge-script.ts` | `window.centraid.read/write/describe` via `kit.js` | `ReplicaShellSession.read/search` for reads; `ReplicaShellSession.write(appId, { action, input, optimistic, intentId })` → replica intent dispatch (`replica-intent-route.ts`) for writes. `describe` is not needed inline (manifests ship in `@centraid/blueprints`) |
| `GET /centraid/<app>/_changes` SSE | `router.ts` `app-changes` → `changes-sse.ts` | bridge legacy `EventSource` fallback; managed shells fan out a parent tail | `ReplicaShellSession.subscribe(appId, deps, listener)` — replica invalidations, no per-app SSE |
| `GET /centraid/<app>/_query/<name>.mjs` | `router.ts` `app-query-bundle` → `query-bundle.ts` (esbuild, imports confined to `queries/`) | `bridge-script.ts` `loadQueryModule`/`runLocalQuery` (local replica read, tool fallback) | direct import of `queries/<name>.ts` from `@centraid/blueprints`, executed against the shell replica coordinator (no network bundle) |
| `POST /centraid/<app>/_turn` (+ `GET/PUT /_turn/model`) SSE chat | `router.ts` `app-chat` → `turn-routes.ts` | **all 8 apps**: `window.KIT_ASK` + `[data-ask-mount]`; `kit.js` ask panel + `kit/conversation-client.js`/`turn-stream.js`/`consent-cards.js` | shell conversation surface (`gateway-client-conversation.ts` / `useAssistantConversations`) scoped to the app, including parked-write consent cards |
| `GET/PUT /centraid/_apps/<id>/settings` | `router.ts` `app-settings-read/-write` | server-side bake (theme/knobs) + settings postMessage | shell already owns `AppSettingsController.tsx` / `appSettingsData.ts`; inline apps read knobs through the same client data module — no bake, no postMessage |
| App static assets (HTML, `_bundle.<hash>.js`, serve-time `.tsx`/`.module.css` transpile) | `router.ts` `app-static` → `static-server.ts`, `app-bundle.ts`, `asset-variants.ts` | browser document/module loads | none — code ships in the shell bundle as a per-app lazy chunk; served path remains for WebView/builder |
| Consent surface `/centraid/_vault/parked` (+ `/parked/<id>`) | gateway vault plane | `kit.js` ask panel consent cards | shell-native consent flow (same Approvals surface the shell already renders) |
| Blobs `/centraid/_vault/blobs` (CAS) | gateway `blob-routes.ts` | `kit.js` attachments (`renderAttachments`, `wireAttachInput`, 256 KB inline cap) | shell gateway client blob routes (unchanged HTTP surface, called from shell code with shell auth — no bridge `centraid:resource` hop) |
| Theme/settings postMessage channels (`centraid:theme`, `centraid:settings`) + URL `?theme=&bgL=` bake | `AppFrame.tsx` postMessage + `static-server.ts` bake | inline `<script>` in each `index.html` | none — inline apps live in the shell document and inherit design tokens synchronously |

Notes settled by this inventory (issue open questions 2 and 3):

- **Embedded chat is universal** — all 8 apps mount the kit ask panel, not a subset.
  The inline equivalent is one shared shell service, priced once, not per app.
- **`/_query/<name>.mjs` bundles are redundant inline** — query modules are
  relative-import-only and confined to `queries/`, so the shell imports them
  directly; the network bundle survives only for the served path.

## Progress log

| Date | Step | PR/commit | Notes |
| --- | --- | --- | --- |
| 2026-07-22 | Kickoff; recon + Phase 0 baseline started | — | Orchestrated session; baseline uses the #404 PWA waterfall harness (loopback) with modeled remote RTT |
| 2026-07-22 | Phase 0 complete — GO | — | Real Tasks open = 2 req / 572 KB; app document is `no-store` (109 KB re-fetched every open, warm/cold ratio 1.0 measured); offline renders nothing. Full numbers in receipts/issue-505-inline-system-apps.md |
| 2026-07-22 | Phase 1 surface inventory written | — | Open questions 2 (chat universal, 8/8) and 3 (query bundles redundant inline) settled; inventory table above |
| 2026-07-22 | Phase 6 ghost cleanup landed early | — | Zero `centraid_sql_*` refs left in `packages/` sources; independent slice, no conflicts with render phases |

## Rejected alternatives

| Idea | Why rejected |
| --- | --- |
| Keep iframes but same-origin-optimize (SW-cache the opaque doc) | Still pays second runtime + bridge serialization + blank-pane failure class; offline render still tunnel-coupled at first open |
| Re-implement `centraid_read`/`centraid_write` names in the shell | #107 naming is a vestige; the app+action shape already exists at `replica-intent-route.ts` |
| Dual-route compat window for the RPC rename | v0 pre-release policy: no compat shims |
| Keep the shared admin token alongside `owner` enrollments | Defeats the point — one static hex for every vault with no revocation is the landlord plane being retired |

## Out of scope

- Agent vault tools (`vault_sql`/`vault_invoke`/`vault_content`), ACP/MCP surface
- Builder feature work; the opaque-document machinery itself
- Gateway HTTP serving of apps (mobile WebViews + builder preview still consume it)
- Mobile client changes
- 2026-07-18 out-of-box onboarding blockers (separate work)
