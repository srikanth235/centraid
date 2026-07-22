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

_To be filled by Phase 1 — every router surface bundled apps consume, mapped to its
shell-native replacement._

| Surface | Serving code | Consumers | Shell-native replacement |
| --- | --- | --- | --- |
| _pending_ | | | |

## Progress log

| Date | Step | PR/commit | Notes |
| --- | --- | --- | --- |
| 2026-07-22 | Kickoff; recon + Phase 0 baseline started | — | Orchestrated session; baseline uses the #404 PWA waterfall harness (loopback) with modeled remote RTT |
| 2026-07-22 | Phase 0 complete — GO | — | Real Tasks open = 2 req / 572 KB; app document is `no-store` (109 KB re-fetched every open, warm/cold ratio 1.0 measured); offline renders nothing. Full numbers in receipts/issue-505-inline-system-apps.md |

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
