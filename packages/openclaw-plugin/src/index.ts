/*
 * @centraid/openclaw-plugin
 *
 * Thin OpenClaw shim over `@centraid/gateway`. The whole store / runtime /
 * route graph is built by `buildGateway()` (the host-agnostic gateway core
 * desktop + the standalone daemon also mount); this file only adapts it to
 * the OpenClaw host:
 *
 *   1. Resolves `pluginConfig` + paths against the OpenClaw state dir.
 *   2. Constructs `buildGateway({ appsStoreRoot, lazyStoreInit, … })` — once
 *      per process, lazily (no git-store `init()` at construction, so the
 *      worker subprocesses OpenClaw runs `register()` in stay inert).
 *   3. Mounts `gw.composedHandler` on the gateway-auth route prefixes
 *      (`/centraid`, `/_centraid-chat`, `/_centraid-user`) — OpenClaw owns
 *      auth, so the handler replays the gateway's route chain MINUS the
 *      bearer check.
 *   4. Drives `gw.start()` from `gateway_start` (the only event that fires in
 *      the single HTTP-serving process — so the in-process cron scheduler
 *      and git-store init run in exactly one process).
 *
 * Plane B (in-process, OpenClaw-specific) is injected into `buildGateway()`:
 *   - chat → `makeOpenClawChatRunner` (`runEmbeddedAgent`)
 *   - automation fire → `runOpenclawFire` (`ctx.tool` → `callGatewayTool`,
 *     `ctx.agent` → simple-completion), shared by cron + run-now
 *   - runner status → `{ kind: 'openclaw', ok: true }`
 *
 * The `/_centraid-hook` webhook route stays plugin-owned (it isn't part of
 * `composedHandler`): it verifies its own shared secret (`auth: 'plugin'`)
 * and fires through the same `runOpenclawFire` path.
 *
 * See `@centraid/app-engine` for the engine + public handler surface
 * (`QueryHandler`, `ActionHandler`) and `@centraid/gateway` for the core.
 */

import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { makeWebhookRouteHandler } from '@centraid/conversation-engine';
import { buildGateway, type BuiltGateway } from '@centraid/gateway';
import { registerCentraidTools } from './lib/tools.js';
import { makeOpenClawChatRunner } from './lib/openclaw-chat-runner.js';
import { runOpenclawFire } from './lib/openclaw-fire.js';

// Re-export the public handler & payload types from app-engine so apps
// authored against the historical `@centraid/openclaw-plugin` import path
// continue to type-check. New code should import from `@centraid/app-engine`
// directly.
export type {
  QueryHandler,
  ActionHandler,
  QueryHandlerArgs,
  ActionHandlerArgs,
  ActionResult,
  ScopedDb,
  ScopedLog,
  AppRef,
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
  AppTableRows,
  RunQueryResult,
  LogEntry,
  LogLevel,
} from '@centraid/app-engine';
export type { AutomationManifest, AutomationManifestRequires } from '@centraid/conversation-engine';

export default definePluginEntry({
  id: 'centraid',
  name: 'Centraid',
  description:
    'Mounts /centraid on the gateway. Each app has static assets, a persistent sqlite database, and JS handlers for queries / actions; app code is backed by the gateway-owned git store.',

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      appsDir?: string;
    };
    // Relative `appsDir` resolves under OpenClaw's state dir (~/.openclaw by
    // default, OPENCLAW_STATE_DIR override), NOT the plugin source tree —
    // runtime state must not live next to code, especially with --link installs.
    const appsDirRaw = pluginConfig.appsDir ?? 'centraid';
    const appsDir = path.isAbsolute(appsDirRaw)
      ? appsDirRaw
      : path.join(resolveStateDir(process.env), appsDirRaw);
    // Sibling SQLite files live one level up from `appsDir` — identity
    // (`centraid-gateway.sqlite`: users + prefs) + the central analytics DB
    // (`centraid-analytics.sqlite`). App CODE is a git store under
    // `centraid-code`; app DATA stays under `appsDir`.
    const dbDir = path.dirname(appsDir);

    // Build the gateway core once per process. `register()` also runs in
    // OpenClaw worker subprocesses (which execute the centraid_* agent tools
    // but never serve HTTP) — `lazyStoreInit` keeps the git-store `init()` +
    // the in-process scheduler off them; both run only from `gw.start()`,
    // driven by `gateway_start` in the single HTTP-serving process. The
    // construction itself is cheap (no git I/O, lazy DB handles), so doing it
    // in every process is safe and gives the worker's tools a live runtime.
    const gwPromise: Promise<BuiltGateway> = buildGateway({
      paths: {
        appsDir,
        identityDb: path.join(dbDir, 'centraid-gateway.sqlite'),
        analyticsDb: path.join(dbDir, 'centraid-analytics.sqlite'),
        chatRunnerSessionDir: path.join(
          resolveStateDir(process.env),
          'centraid',
          'chat-runner-sessions',
        ),
      },
      // OpenClaw owns provider auth; the gateway's secrets seam is unused
      // because chat + ctx.agent run in-process through OpenClaw, never the
      // CLI runner — so a no-op key reader satisfies the required option.
      secrets: { getProviderApiKey: async () => undefined },
      // App CODE backed by the gateway-owned git store (issue #137).
      appsStoreRoot: path.join(dbDir, 'centraid-code'),
      lazyStoreInit: true,
      logger: api.logger,
      logTag: 'centraid',
      // Plane B (in-process): chat drives OpenClaw's embedded agent, not a
      // codex/claude CLI puppet.
      chatRunner: makeOpenClawChatRunner(api),
      // OpenClaw chat runs in-process regardless of any local CLI, so report
      // ready rather than running a codex/claude preflight.
      runnerStatus: async () => ({ kind: 'openclaw', ok: true }),
      // Plane B (in-process): both scheduled (cron) and manual (run-now) fires
      // run the handler in THIS process via `runOpenclawFire` — `ctx.tool` →
      // `callGatewayTool`, `ctx.agent` → simple-completion.
      fireAutomationFactory: (deps) => (automationRef, fireOpts) => {
        void runOpenclawFire(
          {
            automationRef,
            appsDir: deps.appsDir,
            codeAppsDir: deps.codeAppsDir(),
            analytics: deps.analytics,
            triggerKind: fireOpts.triggerKind,
            triggerOrigin: fireOpts.triggerOrigin,
          },
          deps.logger,
          api,
        ).catch((err) =>
          deps.logger.warn(
            `${fireOpts.triggerKind} ${automationRef} failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    });

    api.on('gateway_start', async () => {
      const gw = await gwPromise;
      // `runOpenclawFire` reads `api.config` directly via the captured `api`
      // (no module-global handle) for its ctx.tool/ctx.agent embedded runs.
      // `start()` runs the git-store init, registry sync, bootstrap, and starts
      // the in-process cron scheduler — only here, in the HTTP-serving process.
      // The base URL is unused by the OpenClaw path (the injected chat runner
      // ignores it; webhook URLs are minted from each request's Host header).
      await gw.start('');
    });

    // `gw.composedHandler` replays `chatHistory → userStore → extraHandlers[]
    // → runtime.handle` minus the bearer check (OpenClaw owns auth, hence
    // `auth: 'gateway'`). It dispatches `/_centraid-chat` + `/_centraid-user`
    // internally by URL prefix, so all three gateway-auth prefixes route to it.
    const handleGateway = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const gw = await gwPromise;
      await gw.composedHandler(req, res);
    };
    for (const prefix of ['/centraid', '/_centraid-chat', '/_centraid-user']) {
      api.registerHttpRoute({
        path: prefix,
        match: 'prefix',
        auth: 'gateway',
        handler: handleGateway,
      });
    }

    // Agent tools — let the OpenClaw agent read a single app's data via SELECT
    // only. Scope is enforced by the before_tool_call hook inside
    // registerCentraidTools (sessionKey = "centraid-chat:<appId>"). The runtime
    // is resolved lazily so the worker's tools get the per-process instance.
    registerCentraidTools(
      api,
      gwPromise.then((gw) => gw.runtime),
    );

    // Webhook-trigger route (issue #96). Not part of `composedHandler`: one
    // prefix route fronts every automation with a `webhook` trigger — the path
    // slug resolves to an automation and the handler verifies the shared secret
    // itself, so it runs at `auth: 'plugin'` (no gateway bearer). The fire
    // rides the same `runOpenclawFire` path cron + run-now use. Built lazily
    // (and cached) once the gateway core resolves so it can read live app CODE
    // through `gw.codeAppsDir()` without the plugin naming the git store.
    let webhookHandler:
      | ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>)
      | undefined;
    const ensureWebhookHandler = async (): Promise<
      (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
    > => {
      if (webhookHandler) return webhookHandler;
      const gw = await gwPromise;
      const codeAppsDir = gw.codeAppsDir!;
      webhookHandler = makeWebhookRouteHandler({
        // `codeAppsDir()` resolves the automation from CODE on `main` — a
        // stable symlink path repointed atomically on publish, so resolving
        // once stays correct.
        appsDir: codeAppsDir(),
        fire: async ({ automationRef, body }) => {
          const outcome = await runOpenclawFire(
            {
              automationRef,
              appsDir,
              codeAppsDir: codeAppsDir(),
              analytics: gw.analyticsStore,
              triggerKind: 'scheduled',
              triggerOrigin: 'webhook',
              ...(body !== undefined ? { input: body } : {}),
            },
            api.logger,
            api,
          );
          return {
            ok: outcome.ok,
            ...(outcome.runId ? { runId: outcome.runId } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        },
      });
      return webhookHandler;
    };
    api.registerHttpRoute({
      path: '/_centraid-hook',
      match: 'prefix',
      auth: 'plugin',
      handler: async (req, res) => {
        const handler = await ensureWebhookHandler();
        await handler(req, res);
      },
    });
  },
});
