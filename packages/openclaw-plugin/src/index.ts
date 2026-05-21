/*
 * @centraid/openclaw-plugin
 *
 * Thin OpenClaw shim over `@centraid/runtime-core`. Mounts the runtime's
 * `/centraid` URL surface on the gateway. All app-handling logic — registry,
 * versioned uploads, sqlite-backed query/action handlers, the full
 * `/centraid/...` switch — lives in runtime-core. This file only:
 *
 *   1. Resolves `pluginConfig` against the OpenClaw state dir
 *   2. Constructs a `Runtime`
 *   3. Forwards `gateway_start` to `runtime.bootstrap()`
 *   4. Mounts the runtime under `/centraid` via `api.registerHttpRoute`
 *
 * See `@centraid/runtime-core` for the engine and the public handler
 * surface (`QueryHandler`, `ActionHandler`).
 */

import path from 'node:path';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import {
  Runtime,
  ChatHistoryStore,
  makeChatHistoryRouteHandler,
  UserStore,
  makeUserStoreRouteHandler,
  makeGatewayDbProvider,
  makeChatDbProvider,
  makeActivityDbProvider,
  AutomationStore,
} from '@centraid/runtime-core';
import { registerCentraidTools } from './lib/tools.js';
import { makeOpenClawChatRunner } from './lib/openclaw-chat-runner.js';
import { registerAutomationsProvider, setOpenClawConfig } from './lib/automations-provider.js';
import { OpenclawAutomationHost } from './lib/automation-host.js';

// Re-export the public handler & payload types from runtime-core so apps
// authored against the historical `@centraid/openclaw-plugin` import path
// continue to type-check. New code should import from `@centraid/runtime-core`
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
  AutomationManifest,
  AutomationManifestRequires,
} from '@centraid/runtime-core';

export default definePluginEntry({
  id: 'centraid',
  name: 'Centraid',
  description:
    'Mounts /centraid on the gateway. Apps may be registered by path or uploaded as versioned tar.gz archives; each app has static assets, a persistent sqlite database, and JS handlers for queries / actions.',

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      appsDir?: string;
      versionRetention?: number;
    };
    // Relative `appsDir` resolves under OpenClaw's state dir (~/.openclaw by
    // default, OPENCLAW_STATE_DIR override), NOT the plugin source tree —
    // runtime state must not live next to code, especially with --link installs.
    const appsDirRaw = pluginConfig.appsDir ?? 'centraid';
    const appsDir = path.isAbsolute(appsDirRaw)
      ? appsDirRaw
      : path.join(resolveStateDir(process.env), appsDirRaw);
    const versionRetention = Math.max(2, pluginConfig.versionRetention ?? 5);

    // Three sibling SQLite files, one per domain — identity
    // (`centraid-gateway.sqlite`: users + prefs), chat
    // (`centraid-chat.sqlite`: sessions + messages), automations
    // (`centraid-activity.sqlite`: mirror + run audit). Each store
    // gets the provider for its domain. Providers are lazy: a file is
    // only opened when a store actually needs it, which keeps OpenClaw
    // worker subprocesses (which `register()` runs in but which don't
    // serve HTTP) from holding stray DB handles.
    const dbDir = path.dirname(appsDir);
    const gatewayDbProvider = makeGatewayDbProvider(path.join(dbDir, 'centraid-gateway.sqlite'));
    const chatDbProvider = makeChatDbProvider(path.join(dbDir, 'centraid-chat.sqlite'));
    const automationDbProvider = makeActivityDbProvider(
      path.join(dbDir, 'centraid-activity.sqlite'),
    );
    const userStore = new UserStore(gatewayDbProvider);
    const automationStore = new AutomationStore(automationDbProvider);

    // Chat-history store — wraps the chat DB. It is THE chat store: the
    // `/centraid/<id>/_chat` POST route reads sticky mode + runner-resume
    // handles from it and records turn completion back. Constructed
    // before the runtime so it can be handed to the Runtime and also
    // mounted on the `/_centraid-chat` HTTP surface.
    const chatHistoryStore = new ChatHistoryStore(chatDbProvider, () => userStore.getUserId());

    const chatRunner = makeOpenClawChatRunner(api);

    // Openclaw cron host. Same `AutomationHost` shape the desktop's
    // OS scheduler implements; centralizes register / unregister /
    // reconcile so callers don't speak `cron.add` / `cron.update`
    // directly.
    const automationHost = new OpenclawAutomationHost();

    const runtime = new Runtime({
      appsDir,
      versionRetention,
      userStore,
      chatHistoryStore,
      chatRunnerSessionDir: path.join(
        resolveStateDir(process.env),
        'centraid',
        'chat-runner-sessions',
      ),
      logger: api.logger,
      chatRunner,
      runnerStatus: async () => ({ kind: 'openclaw', ok: true }),
    });

    // Register the centraid-mock provider plugin. The provider's
    // StreamFn parses the dispatch sentinel from the cron-fire prompt,
    // loads the automation handler off disk, and runs it with a ctx
    // that routes ctx.tool through callGatewayTool and ctx.agent
    // through the user's REAL provider via the simple-completion
    // runtime. See `lib/automations-provider.ts`.
    registerAutomationsProvider(api, {
      automationDbProvider,
      logger: api.logger,
    });

    api.on('gateway_start', async () => {
      await runtime.bootstrap();
      // Bind the openclaw config so the provider plugin's ctx.agent
      // path can route through `prepareSimpleCompletionModelForAgent`.
      // `api.config` is available at gateway_start time; before this
      // any cron fire would throw, but cron jobs don't fire until
      // after gateway_start anyway.
      setOpenClawConfig((api as unknown as { config: unknown }).config);
      // Reconcile centraid's automations mirror with openclaw's cron
      // store. Adds jobs we expect but openclaw doesn't know about,
      // updates mismatched ones, removes zombies. Soft-fails on
      // network / SDK errors so a transient cron-store hiccup doesn't
      // prevent the plugin from booting.
      try {
        const outcome = await automationHost.reconcile(automationStore.listAll());
        if (outcome.added.length + outcome.updated.length + outcome.removed.length > 0) {
          api.logger.info(
            `[centraid] automations reconciled: +${outcome.added.length} ~${outcome.updated.length} -${outcome.removed.length}`,
          );
        }
      } catch (err) {
        api.logger.warn(
          `[centraid] automations reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    api.registerHttpRoute({
      path: '/centraid',
      match: 'prefix',
      auth: 'gateway',
      handler: (req, res) => runtime.handle(req, res),
    });

    // Agent tools — let the OpenClaw agent read a single app's data via
    // SELECT only. Scope is enforced by the before_tool_call hook inside
    // registerCentraidTools (uses sessionKey = "centraid-chat:<appId>").
    registerCentraidTools(api, runtime);

    // Mount the chat-history store (constructed above) on its HTTP surface.
    // Per-user scoping: every chat_sessions row carries the gateway-side
    // user UUID from `UserStore` (real FK to `users`, ON DELETE CASCADE).
    // The provider closure resolves the UUID lazily — UserStore caches it
    // after the first read.
    api.registerHttpRoute({
      path: '/_centraid-chat',
      match: 'prefix',
      auth: 'gateway',
      handler: makeChatHistoryRouteHandler(() => chatHistoryStore),
    });

    // User-prefs route. The store was constructed eagerly above so that the
    // runtime's app-index injection can read prefs synchronously, but the
    // route handler still goes through a getter for symmetry with the
    // chat-history wiring (and so future lazy-init refactors don't have to
    // touch the route registration).
    api.registerHttpRoute({
      path: '/_centraid-user',
      match: 'prefix',
      auth: 'gateway',
      handler: makeUserStoreRouteHandler(() => userStore),
    });
  },
});
