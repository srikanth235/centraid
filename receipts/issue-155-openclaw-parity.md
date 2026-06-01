# issue-155 — bring openclaw-plugin to parity

GitHub issue: [#155](https://github.com/srikanth235/centraid/issues/155)

`@centraid/openclaw-plugin` is the pre-#137 architecture frozen in time:
it serves app code from the legacy tarball backend, runs chat as a
data-only loop that can't edit code, and fires automations by smuggling
them through openclaw's cron pipeline behind a fake `pi-ai` provider.
Meanwhile `serve()` builds a far richer graph (git store, draft resolvers,
unified chat, in-process scheduler, all route handlers) inline.

OpenClaw stays a first-class host at full parity with the desktop embed
and the `centraid-gateway` daemon by **sharing one core** instead of
reimplementing it. Net effect: ~1000 lines + the `@mariozechner/pi-ai`
dependency deleted from the plugin.

v0 pre-release: no backward compatibility, no migrations. No live openclaw
users — clean break on state layout.

## Checklist

- [x] Phase 1 — extract host-agnostic `buildGateway()` core out of `serve()`
- [x] Phase 2 — add `'openclaw'` to `LocalRunnerKind` + CLI-spawn wiring
- [ ] Phase 3 — re-platform the plugin `index.ts` onto `buildGateway()` +
      `composedHandler`; delete the 5 legacy files; drop `pi-ai`
- [ ] Phase 4 — cut automations to `InProcessScheduler` (remove the
      `centraid-mock` registration)

## What changed

### Phase 1 — extract host-agnostic `buildGateway()` core out of `serve()`

Pure refactor. Daemon + Electron behavior unchanged.

`serve()` welded graph construction and the HTTP listener into one
function. Split them so a host can mount the gateway core without a
dedicated bearer-protected listener — the first of the two architectural
moves in the issue.

- New `build-gateway.ts` owns `buildGateway(options)`: it constructs the
  whole object graph (stores, prefs loader, chat runner, `Runtime`, the
  in-process scheduler, every route handler) and returns it **without**
  binding a socket. The returned `BuiltGateway` exposes:
  - `composedHandler` — replays the route chain from app-engine
    `http-server.ts:135-147` (`chatHistory → userStore → extraHandlers[]
    → runtime.handle`) **minus** the bearer check, for hosts that own
    auth themselves (OpenClaw's `auth: 'gateway'`). Always resolves the
    response.
  - `extraHandlers` — the templates / apps-store / lifecycle / automations
    handler array, handed straight to `startRuntimeHttpServer` by `serve()`.
  - `start(publicBaseUrl)` / `stop()` — the post-listener lifecycle
    (publish the live origin for webhook minting, `runtime.bootstrap()`,
    git-store registry sync, scheduler start + reconcile — issue #149).
- `serve.ts` is now a thin wrapper: `buildGateway()` +
  `startRuntimeHttpServer` + `start()`. `ServeOptions` extends
  `BuildGatewayOptions` with the listener-only `host`/`port`/`token`.
  `GatewayServeHandle` keeps its exact shape (`url`/`token`/`close` +
  `runtime`/stores), so the daemon, CLI, and Electron callers are
  untouched.
- `resolveProvider()` (parse provider prefs + splice the secret in) moves
  to `provider-prefs.ts`, next to its sync counterpart `parseProviderPrefs`.

### Phase 2 — add `'openclaw'` to `LocalRunnerKind` + CLI-spawn wiring

The second architectural move: `openclaw` joins `codex` and `claude-code`
as a coding-agent backend the gateway can drive. Unlike those two,
`openclaw` self-authenticates from the user's shell (the model provider
is configured inside OpenClaw) — `RunnerPrefs.provider` is ignored, no
`CODEX_HOME` / `ANTHROPIC_*` injection.

- `RunnerKind` (`types.ts`) and `LocalRunnerKind`
  (`run-automation-cli-spawn.ts`) both gain `'openclaw'`; `preflight.ts`
  learns its bin name (`openclaw`), CalVer minimum, and install hint.
- **Chat** (`runtime.ts` → new `openclaw-acp.ts`): a `kind === 'openclaw'`
  turn spawns `openclaw acp` and drives one prompt over the Agent Client
  Protocol (`@agentclientprotocol/sdk`'s `ClientSideConnection`, stdio).
  `openclaw-acp-events.ts` translates `session/update` notifications
  (`agent_message_chunk` / `agent_thought_chunk` / `tool_call` /
  `tool_call_update` / `plan` / `usage_update`) into the shared
  `ChatStreamEvent` shape. openclaw reaches centraid data through the
  bundled `centraid` CLI on PATH (its shell tool), so no inline
  `toolContext` is forwarded.
- **Automation `ctx.agent` one-shot** (`run-automation-live-dispatch.ts`):
  `openclaw agent --local --json --message <prompt>` against the user's
  real provider; the reply text is read from the gateway response object's
  `result.payloads[].text`.
- **Automation `ctx.tool` round-trip** (`run-automation-cli-spawn.ts`):
  an explicit openclaw branch points `openclaw agent --local` at the
  per-fire mock-LLM endpoint via `OPENAI_BASE_URL` / `OPENAI_API_KEY`
  (the OpenAI-compatible override openclaw honors), mirroring the
  codex/claude provider shadow. Flagged in-code as needing live-openclaw
  validation of the staged-tool round-trip.
- `build-gateway.ts`'s prefs loader accepts `'openclaw'` as a runner kind.

## Out of scope (this phase)

- Phases 3–4 — the plugin re-platform onto `buildGateway()` +
  `composedHandler` and the file deletions, plus cutting automations to
  `InProcessScheduler`, land in follow-up commits.
- Live-openclaw end-to-end validation: the ACP chat turn and the
  automation spawns typecheck + unit-test against the real
  `@agentclientprotocol/sdk` contract and the installed `openclaw` CLI's
  flags, but have not been exercised against a running `openclaw` agent in
  this environment.

## Verification

- Phase 1: `@centraid/gateway` typecheck clean; 74 tests pass (the 69
  pre-existing + 5 new in `build-gateway.test.ts` pinning the
  listener-free `buildGateway()` contract and the auth-free
  `composedHandler`). Full-repo `turbo run typecheck` green; lint + format
  clean. `build-gateway.ts` 498 lines (under the 500-line repo-hygiene cap).
- Phase 2: `@centraid/agent-runtime` typecheck + build clean; 68 tests
  pass (including 9 new in `openclaw-acp-events.test.ts` pinning every
  `session/update` → `ChatStreamEvent` mapping). `@centraid/gateway`
  typecheck clean + 74 tests pass with the openclaw runner kind threaded
  through the prefs loader. New ACP imports resolve against the installed
  `@agentclientprotocol/sdk` 0.21.0; openclaw spawn flags
  (`acp --no-prefix-cwd`, `agent --local --json --message`) match the
  installed `openclaw` 2026.5.7 CLI.
