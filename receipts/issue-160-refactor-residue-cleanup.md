# issue-160 — clean up leaky abstractions & refactor residue across the stack

GitHub issue: [#160](https://github.com/srikanth235/centraid/issues/160)

A rapid series of major refactors (git-store cutover #137, the
`runtime-core→app-engine` / `builder-harness→agent-harness` /
`apps-store→code-store` / `gateway-runtime→gateway` renames #142–#146, the
chat/automation re-home #147–#150, the `@centraid/stores→@centraid/analytics`
extraction #151–#153, the `buildGateway()` extraction #155/#156, data
branching #144, and automation streaming #158/#159) each landed cleanly in
behavior but left behind **leaky abstractions, dead dual-paths, stale
comments, and a couple of unfinished wiring gaps**.

v0 pre-release: no backward compatibility, no migrations.

## Checklist (suggested sequence)

- [x] **PR 1 — comment/doc accuracy (zero behavior change):** 1b, 1c, 1d,
      1e, and the stale "pi session" comments.
- [x] **PR 2 — `windowId` → `chatSessionId` rename (1a).** Mechanical,
      contract-wide.
- [x] **PR 3 — codex MCP-server preservation (3a).** Mirror the `-c`
      override fix into `codex-app-server.ts` + `host-tools.ts`.
- [x] **Decision — rollback migrations (3b).** Documented rollback as
      code-only (the lower-risk option); a re-publish heals the schema.
- [x] **Gateway session-scheme de-leak (Theme 2, `desktop-<appId>`).**
      `sessionIdFor` defaults host-neutral in the gateway core; the desktop
      host injects its `desktop-<appId>` scheme.
- [ ] **Gated on #155 — delete the tarball/VersionStore backend (Theme 2)**
      once OpenClaw is on git-store. Tracked only; load-bearing until then.

## What changed

### Theme 1 — vestigial naming & comments

- **1b (sticky mode):** the per-session/data mode toggle was deleted (#133).
  Dropped "sticky mode +" from the chat-store docs in `chat-history.ts`,
  `chat-routes.ts`, and `openclaw-plugin/index.ts`; the route reads only the
  runner-resume handle now.
- **1c (OS scheduler):** the OS scheduler was removed (#149/#150) and the
  gateway now owns in-process cron. Rewrote the stale (and on one line,
  false) comments in `desktop/local-runtime.ts` to describe gateway-owned
  in-process scheduling — automations fire only while the gateway runs. Also
  corrected the matching "reconcile the OS scheduler" comments in
  `gateway/lifecycle-{shared,routes}.ts` (`reconcile()` drives the in-process
  scheduler).
- **1d (agent-harness attribution):** `@centraid/agent-harness` dissolved in
  #146; reworded the `runtime.ts` `appMeta` comment to "host-injected
  app.json reader". (`appMeta` itself is live — not removed.)
- **1e (openclaw capability string):** path registration was retired;
  dropped "registered by path" from the plugin description.
- **stale "pi session" wording:** the OpenClaw runner hands `sessionFile` to
  `runEmbeddedAgent`; it doesn't write a "pi session file".

### 1a — `windowId` → `chatSessionId` (structural rename)

A chat session **is** the chat window; the `windowId` name froze a
renderer/UI "pane" concept into the gateway+runner contract. Renamed
contract-wide — `ChatRunInput.windowId`, the `_chat` POST body field,
`isValidWindowId` → `isValidChatSessionId`, `withWindowLock` →
`withChatSessionLock`, the per-runtime `chatWindowLocks` → `chatSessionLocks`
lock map, and the renderer send sites — plus the comments that referenced it.
No backend dependency (the legacy `_chat/windows` sub-routes are already
gone; Surface A is POST-only).

### 3a — codex custom-provider drops the user's MCP servers in chat + builder grounding

The automation `ctx.tool` path was fixed in #158/#159 to route the provider
via `-c key=value` overrides (preserving `[mcp_servers.*]`), but two sibling
paths still redirected `CODEX_HOME` and dropped those servers:

- `codex-app-server.ts` (the chat-turn path) now passes
  `codexProviderOverrideArgs(provider)` to `codex app-server` (honored since
  codex-cli 0.128.0) instead of materializing a scoped `CODEX_HOME`, so the
  user's MCP servers survive into chat. The API key still flows via env under
  `env_key`, never on disk.
- `host-tools.ts` (the builder tool-enumeration probe) likewise spawns
  `codex exec` with `-c` overrides on the real `~/.codex`, so the enumerated
  tool surface includes the user's MCP tools.

This makes chat, the builder's tool grounding, and automations consistent: a
user on a custom OpenAI-compatible provider keeps their MCP tools across all
three surfaces.

After this fix `materializeCodexHome` has no production callers (kept as a
tested utility / documented alternative strategy), and the `codexHomeBaseDir`
paths chain (`GatewayPaths.codexHomeBaseDir` → agent-runtime configs) is
**vestigial** — no longer consulted. Fully removing it would touch the
`GatewayPaths` contract and ~13 gateway test fixtures, so it's left as a
follow-up rather than expanding 3a's blast radius; the leaf field is doc'd as
vestigial in `codex-app-server.ts`.

### 3b — rollback skips migrations while publish runs them (asymmetry from #144)

`publishCritical` runs `input.migrate`; `rollbackCritical` has no migrate
hook. **Decision: rollback is code-only.** Documented the asymmetry in
`worktree-store.ts` — rolling back swaps the live code to an older tag but
leaves the live `data.sqlite` schema forward; centraid migrations are
forward-only, and a re-publish re-applies the forward migration to heal any
drift. No down-migration is run.

### Theme 2 — `desktop-<appId>` session scheme leaked into the host-agnostic gateway

`buildGateway()` is host-agnostic, yet `makeUnifiedChatRunner`'s **default**
session id was `desktop-${appId}` — the renderer's scheme leaking into the
neutral core. The default is now host-neutral (`chat-${appId}`); the gateway
threads an optional `sessionIdFor` from `BuildGatewayOptions`/`ServeOptions`,
and the **desktop host** injects its `desktop-${appId}` scheme so the
renderer Code tab, the local builder, and gateway chat still share one draft
worktree. The standalone daemon uses the neutral default.

The tarball/VersionStore dead dual-path (Theme 2) is **not** deleted here —
it is OpenClaw's sole code-ingestion path until OpenClaw moves to git-store
(#155). Captured in the checklist above.

## Out of scope

- **Deleting the tarball / VersionStore backend (Theme 2).** Gated on the
  OpenClaw re-platform (#155): tarball upload is still OpenClaw's only
  code-ingestion path, so `upload.ts`, `version-store.ts`, the
  `app-upload` / `app-versions-list` routes, the `resolveCodeDir` fallback,
  the registry `mode` shim, and `current.json` stay until OpenClaw is on
  git-store. Tracked, not actioned.
- **Audit over-reach explicitly recorded as non-violations** (kept as-is):
  `RunnerStatus.kind` runner identity, `prevThreadId` inside
  `codex-app-server.ts`, `agentTurnId` on the change-bus, the live `appMeta`
  reader, and the load-bearing `@mariozechner/pi-ai` import.
- A down-migration on rollback (3b) — see the decision above; rollback is
  documented as code-only instead.

## Verification

- `bun run typecheck` — all workspaces pass.
- `bun run test` — affected package suites pass (app-engine chat-routes,
  agent-runtime codex-provider-config, gateway unified-chat-runner /
  worktree-store).
- `bun run check` (oxfmt + oxlint) — clean.

