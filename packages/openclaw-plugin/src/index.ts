/*
 * @centraid/openclaw-plugin
 *
 * Thin OpenClaw shim over `@centraid/app-engine`. Mounts the runtime's
 * `/centraid` URL surface on the gateway. All app-handling logic — registry,
 * sqlite-backed query/action handlers, the full `/centraid/...` switch —
 * lives in app-engine. App CODE is backed by the gateway-owned git store
 * (issue #137); DATA lives under `appsDir`. This file only:
 *
 *   1. Resolves `pluginConfig` against the OpenClaw state dir
 *   2. Constructs the git `WorktreeStore` + a `Runtime` wired to serve from it
 *   3. Forwards `gateway_start` to `store.init()` + `runtime.bootstrap()`
 *   4. Mounts the runtime under `/centraid` via `api.registerHttpRoute`
 *
 * See `@centraid/app-engine` for the engine and the public handler
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
  AnalyticsStore,
  makeAnalyticsDbProvider,
} from '@centraid/app-engine';
import { listAutomations, makeWebhookRouteHandler } from '@centraid/automation-engine';
import { WorktreeStore } from '@centraid/worktree-store';
import { registerCentraidTools } from './lib/tools.js';
import { makeOpenClawChatRunner } from './lib/openclaw-chat-runner.js';
import { registerAutomationsProvider, setOpenClawConfig } from './lib/automations-provider.js';
import { OpenclawAutomationHost } from './lib/automation-host.js';
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
export type { AutomationManifest, AutomationManifestRequires } from '@centraid/automation-engine';

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

    // Sibling SQLite files, one per domain — identity
    // (`centraid-gateway.sqlite`: users + prefs) and the central
    // analytics DB (`centraid-analytics.sqlite`: one summary row per
    // run, every kind — issue #98). Automation *and* chat runs live in
    // each app's own `runtime.sqlite`, resolved per app. Providers are
    // lazy: a file is only opened when a store actually needs it, which
    // keeps OpenClaw worker subprocesses (which `register()` runs in but
    // which don't serve HTTP) from holding stray DB handles.
    const dbDir = path.dirname(appsDir);
    const gatewayDbProvider = makeGatewayDbProvider(path.join(dbDir, 'centraid-gateway.sqlite'));
    const analyticsStore = new AnalyticsStore(
      makeAnalyticsDbProvider(path.join(dbDir, 'centraid-analytics.sqlite')),
    );

    // Git-store backend (issue #137): app CODE lives in a bare git repo +
    // worktrees under `<dbDir>/centraid-code`; DATA stays under `appsDir`.
    // `codeStore.init()` runs in `gateway_start` below. `codeDirOverride`
    // makes the runtime serve handlers/static from the live `main` worktree
    // — the legacy tarball/VersionStore backend is gone. `codeAppsDir()` is
    // a thunk: the active-main link rotates on each publish/rollback, so
    // automation reads resolve the current code per fire.
    const codeStore = new WorktreeStore({ root: path.join(dbDir, 'centraid-code') });
    const codeAppsDir = (): string => path.join(codeStore.getActiveMainLink(), 'apps');

    // Issue #98: an automation is never standalone — it lives inside an
    // app folder. There is no separate automations dir; `listAutomations`
    // scans every app's `automations/` under the live `main` worktree.
    const userStore = new UserStore(gatewayDbProvider);

    // Chat-history store — app-scoped (issue #98): every chat session +
    // turn lives in its app's `runtime.sqlite`, resolved from `appsDir`.
    // The `/centraid/<id>/_chat` POST route reads the runner-resume handle
    // from it and records each turn as a `runs` row. Constructed before the
    // runtime so it can be handed to the Runtime and also mounted on the
    // `/_centraid-chat` HTTP surface.
    const chatHistoryStore = new ChatHistoryStore(
      appsDir,
      () => userStore.getUserId(),
      analyticsStore,
    );

    const chatRunner = makeOpenClawChatRunner(api);

    // Openclaw cron host. Same `AutomationHost` shape the desktop's
    // OS scheduler implements; centralizes register / unregister /
    // reconcile so callers don't speak `cron.add` / `cron.update`
    // directly.
    const automationHost = new OpenclawAutomationHost();

    const runtime = new Runtime({
      appsDir,
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
      // Serve handlers + static from the live git-store `main` worktree.
      codeDirOverride: (appId) => codeStore.resolveActiveAppDir(appId),
    });

    // Register the centraid-mock provider plugin. The provider's
    // StreamFn parses the dispatch sentinel from the cron-fire prompt,
    // loads the automation handler off disk, and runs it with a ctx
    // that routes ctx.tool through callGatewayTool and ctx.agent
    // through the user's REAL provider via the simple-completion
    // runtime. See `lib/automations-provider.ts`.
    registerAutomationsProvider(api, {
      appsDir,
      codeAppsDir,
      analytics: analyticsStore,
      logger: api.logger,
    });

    api.on('gateway_start', async () => {
      // Initialize the git store, then register every app present on `main`
      // so `registry.get(id)` resolves + its data dir exists (issue #137).
      // Code is served from the worktree via `codeDirOverride`; this only
      // bookkeeps existence + the per-app data dir.
      await codeStore.init();
      for (const appId of await codeStore.listApps()) {
        await runtime.registry.ensureUploaded(appId);
      }
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
        const { rows } = await listAutomations(codeAppsDir());
        const outcome = await automationHost.reconcile(rows);
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

    // Webhook-trigger route (issue #96). One prefix route fronts every
    // automation with a `webhook` trigger: the path slug resolves to an
    // automation and the handler verifies the shared secret itself, so
    // it runs at `auth: 'plugin'` (no gateway bearer required). The fire
    // rides the same `runOpenclawFire` path a cron trigger uses.
    api.registerHttpRoute({
      path: '/_centraid-hook',
      match: 'prefix',
      auth: 'plugin',
      handler: makeWebhookRouteHandler({
        // The webhook handler resolves the target automation from CODE on
        // `main` (`getActiveMainLink()` is a stable symlink path repointed
        // atomically on publish, so resolving once stays correct).
        appsDir: codeAppsDir(),
        fire: async ({ automationRef, body }) => {
          const outcome = await runOpenclawFire(
            {
              automationRef,
              appsDir,
              codeAppsDir: codeAppsDir(),
              analytics: analyticsStore,
              triggerKind: 'scheduled',
              triggerOrigin: 'webhook',
              ...(body !== undefined ? { input: body } : {}),
            },
            api.logger,
          );
          return {
            ok: outcome.ok,
            ...(outcome.runId ? { runId: outcome.runId } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        },
      }),
    });
  },
});
