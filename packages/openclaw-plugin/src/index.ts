/*
 * @centraid/openclaw-plugin
 *
 * OpenClaw host for the centraid gateway. One of three hosts that mount
 * the shared `buildGateway()` core (the others: the `centraid-gateway`
 * daemon and the Electron embed). Instead of reimplementing the graph,
 * this plugin builds the gateway and mounts its `composedHandler` on the
 * OpenClaw HTTP server — OpenClaw owns auth (`auth: 'gateway'`), so the
 * composed chain runs without the daemon's bearer check.
 *
 * What the plugin owns:
 *   1. Derive `GatewayPaths` + the git-store root under OpenClaw's state dir.
 *   2. `buildGateway()` (async) and drive `start()` / `stop()` from the
 *      `gateway_start` / `gateway_stop` lifecycle hooks.
 *   3. Mount `composedHandler` on the `/centraid`, `/_centraid-chat`,
 *      `/_centraid-user` prefixes, and a dedicated `/_centraid-hook`
 *      webhook route (auth: 'plugin' — verifies its own secret) that fires
 *      through the gateway's own automation path.
 *   4. Register the `centraid_*` agent tools so any OpenClaw agent (not
 *      just centraid chat) can address a registered app's data surface.
 *
 * Everything else — the git store, draft/branching, the unified chat
 * runner, the in-process cron scheduler, every route handler — comes from
 * `@centraid/gateway`. Chat runs through the gateway's runner pref
 * (`codex` / `claude-code` / `openclaw`), so this plugin no longer ships
 * its own chat runner or automation pipeline.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import {
  buildGateway,
  type BuiltGateway,
  type GatewayPaths,
  type RouteHandler,
  type SecretsProvider,
} from '@centraid/gateway';
import { makeWebhookRouteHandler } from '@centraid/automation';
import { registerCentraidTools } from './lib/tools.js';

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
export type { AutomationManifest, AutomationManifestRequires } from '@centraid/automation';

/**
 * OpenClaw's embedded runner self-authenticates from the user's shell, so
 * the gateway never needs a custom OpenAI-compatible provider key here.
 * (Picking the codex / claude runner inside the OpenClaw host uses their
 * own `codex login` / `claude login`, not this key.)
 */
const noSecrets: SecretsProvider = { getProviderApiKey: async () => undefined };

export default definePluginEntry({
  id: 'centraid',
  name: 'Centraid',
  description:
    'Mounts the centraid gateway on the OpenClaw HTTP server. Apps own static assets, a git-backed code store with draft/branching, a per-app sqlite database, and JS handlers for queries / actions; automations fire on an in-process scheduler.',

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      dataDir?: string;
      versionRetention?: number;
    };
    // Relative `dataDir` resolves under OpenClaw's state dir (~/.openclaw by
    // default, OPENCLAW_STATE_DIR override), NOT the plugin source tree —
    // runtime state must not live next to code, especially with --link installs.
    const dataDirRaw = pluginConfig.dataDir ?? 'centraid';
    const stateRoot = path.isAbsolute(dataDirRaw)
      ? dataDirRaw
      : path.join(resolveStateDir(process.env), dataDirRaw);

    // Clean break on layout (v0, no live openclaw users, no migration): the
    // gateway owns app *code* as a git store under `apps-store/`, app *data*
    // (per-app `data.sqlite`) under `apps/`, and the identity + analytics DBs
    // as siblings. Mirrors the daemon's `daemonLayoutFor`.
    const paths: GatewayPaths = {
      appsDir: path.join(stateRoot, 'apps'),
      identityDb: path.join(stateRoot, 'identity.sqlite'),
      analyticsDb: path.join(stateRoot, 'analytics.sqlite'),
      chatRunnerSessionDir: path.join(stateRoot, 'chat-runner-sessions'),
      codexHomeBaseDir: path.join(stateRoot, 'codex-home'),
    };
    const appsStoreRoot = path.join(stateRoot, 'apps-store');

    // `buildGateway` is async but `register()` is synchronous. Kick the build
    // off now and expose a `ready` promise that route handlers + lifecycle
    // hooks await; cache the resolved gateway for synchronous reads (tools).
    let gateway: BuiltGateway | undefined;
    const ready = buildGateway({
      paths,
      secrets: noSecrets,
      appsStoreRoot,
      logger: {
        info: (m) => api.logger.info(m),
        warn: (m) => api.logger.warn(m),
        error: (m) => api.logger.error(m),
      },
      logTag: 'centraid',
    });
    void ready.then(
      (g) => {
        gateway = g;
      },
      (err) =>
        api.logger.error(
          `[centraid] gateway build failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );

    // Mount `composedHandler` on each centraid URL prefix. OpenClaw owns auth
    // (`auth: 'gateway'`); the composed chain replays chat → user → extra →
    // runtime.handle minus the bearer check and always resolves the response.
    for (const prefix of ['/centraid', '/_centraid-chat', '/_centraid-user']) {
      api.registerHttpRoute({
        path: prefix,
        match: 'prefix',
        auth: 'gateway',
        handler: async (req, res) => (await ready).composedHandler(req, res),
      });
    }

    // Webhook-trigger route (issue #96). One prefix route fronts every
    // automation with a `webhook` trigger: the slug resolves to an automation
    // and the handler verifies the shared secret itself, so it runs at
    // `auth: 'plugin'` (no gateway bearer). The fire rides the gateway's own
    // automation path — the same one cron + "run now" use. Built lazily on
    // first hit (the gateway + its `main` worktree exist only post-start).
    let webhookHandler: RouteHandler | undefined;
    api.registerHttpRoute({
      path: '/_centraid-hook',
      match: 'prefix',
      auth: 'plugin',
      handler: async (req, res) => {
        const g = await ready;
        if (!g.fireAutomation || !g.appsStore) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'gateway not ready for webhooks' }));
          return true;
        }
        if (!webhookHandler) {
          const codeAppsDir = path.join(g.appsStore.getActiveMainLink(), 'apps');
          const fireAutomation = g.fireAutomation;
          webhookHandler = makeWebhookRouteHandler({
            appsDir: codeAppsDir,
            fire: async ({ automationRef, body }) => {
              const runId = randomUUID();
              fireAutomation(automationRef, {
                runId,
                triggerKind: 'scheduled',
                triggerOrigin: 'webhook',
                ...(body !== undefined ? { input: body } : {}),
              });
              return { ok: true, runId };
            },
          });
        }
        return webhookHandler(req, res);
      },
    });

    // Agent tools — let any OpenClaw agent read/act on a registered app's
    // declared surface. Scope is enforced by the `before_tool_call` hook
    // inside `registerCentraidTools` (sessionKey = "centraid-chat:<appId>").
    // The runtime is resolved lazily since the gateway builds asynchronously.
    registerCentraidTools(api, () => {
      if (!gateway) throw new Error('centraid gateway is not ready yet');
      return gateway.runtime;
    });

    // Lifecycle: `start()` runs bootstrap + git-store registry sync + the
    // in-process cron scheduler; `stop()` halts the scheduler. The public
    // base URL feeds post-turn webhook minting — OpenClaw binds loopback, so
    // build it from the gateway port the hook reports.
    api.on('gateway_start', async (event) => {
      const port = (event as { port?: number }).port;
      const publicBaseUrl = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
      const g = await ready;
      await g.start(publicBaseUrl);
    });
    api.on('gateway_stop', async () => {
      await gateway?.stop();
    });
  },
});
