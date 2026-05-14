/*
 * @centraid/openclaw-plugin
 *
 * Thin OpenClaw shim over `@centraid/runtime-core`. Mounts the runtime's
 * `/centraid` URL surface on the gateway and wires OpenClaw's cron CLI as
 * the runtime's `Scheduler` backend. All app-handling logic — registry,
 * versioned uploads, sqlite-backed query/action/cron handlers, the full
 * `/centraid/...` switch — lives in runtime-core. This file only:
 *
 *   1. Resolves `pluginConfig` against the OpenClaw state dir
 *   2. Constructs a `Runtime` with `OpenClawScheduler` as the Scheduler
 *   3. Forwards `gateway_start` to `runtime.bootstrap()` and `cron_changed`
 *      to `runtime.onCronChanged()`
 *   4. Mounts the runtime under `/centraid` via `api.registerHttpRoute`
 *
 * See `@centraid/runtime-core` for the engine and the public handler
 * surface (`QueryHandler`, `ActionHandler`, `CronHandler`).
 */

import path from 'node:path';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { Runtime } from '@centraid/runtime-core';
import { OpenClawScheduler } from './lib/openclaw-cron.js';
import { registerCentraidTools } from './lib/tools.js';

// Re-export the public handler & payload types from runtime-core so apps
// authored against the historical `@centraid/openclaw-plugin` import path
// continue to type-check. New code should import from `@centraid/runtime-core`
// directly.
export type {
  QueryHandler,
  ActionHandler,
  CronHandler,
  QueryHandlerArgs,
  ActionHandlerArgs,
  CronHandlerArgs,
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
} from '@centraid/runtime-core';

export { OpenClawScheduler } from './lib/openclaw-cron.js';

export default definePluginEntry({
  id: 'centraid',
  name: 'Centraid',
  description:
    'Mounts /centraid on the gateway. Apps may be registered by path or uploaded as versioned tar.gz archives; each app has static assets, a persistent sqlite database, and JS handlers for queries / actions / cron-fed ingest.',

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      appsDir?: string;
      gatewayBaseUrl?: string;
      versionRetention?: number;
    };
    // Relative `appsDir` resolves under OpenClaw's state dir (~/.openclaw by
    // default, OPENCLAW_STATE_DIR override), NOT the plugin source tree —
    // runtime state must not live next to code, especially with --link installs.
    const appsDirRaw = pluginConfig.appsDir ?? 'centraid';
    const appsDir = path.isAbsolute(appsDirRaw)
      ? appsDirRaw
      : path.join(resolveStateDir(process.env), appsDirRaw);
    const gatewayBaseUrl = pluginConfig.gatewayBaseUrl ?? 'http://127.0.0.1:18789';
    const versionRetention = Math.max(2, pluginConfig.versionRetention ?? 5);

    const runtime = new Runtime({
      appsDir,
      gatewayBaseUrl,
      versionRetention,
      scheduler: new OpenClawScheduler(), // Path B by default; upgraded in gateway_start.
      logger: api.logger,
    });

    api.on('gateway_start', async (_event, ctx) => {
      // Path A becomes available if the gateway exposes a getCron() handle.
      // We use it for list/remove only; add() always goes through the CLI
      // because the public cron service shape doesn't support webhook delivery.
      const handle = ctx.getCron?.();
      if (handle) {
        runtime.setScheduler(new OpenClawScheduler({ handle }));
      }
      await runtime.bootstrap();
    });

    api.on('cron_changed', async (event) => {
      await runtime.onCronChanged(event);
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
    registerCentraidTools(api, runtime.registry);
  },
});
