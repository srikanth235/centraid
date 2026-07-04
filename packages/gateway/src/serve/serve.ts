/*
 * `serve()` — boot a gateway and front it with an HTTP listener.
 *
 * A thin wrapper over `buildGateway()` (which constructs the whole
 * host-agnostic graph without a socket — see `build-gateway.ts`). `serve()`
 * adds the loopback bind + bearer auth via `startRuntimeHttpServer`, then
 * drives the post-listener lifecycle. Behavior is identical to the
 * pre-split `serve()`, so the two callers that ship today are unchanged:
 *
 *   - `apps/desktop` embeds it in the Electron main process (paths under
 *     `<userData>/gateways/<id>/`).
 *   - The `centraid-gateway` CLI in this package runs it as a standalone
 *     daemon (paths under a config-file `dataDir`).
 *
 * A third host (the OpenClaw plugin) mounts `buildGateway()`'s
 * `composedHandler` directly instead, owning auth itself.
 */

import { startRuntimeHttpServer } from '@centraid/app-engine';
import { buildGateway, type BuildGatewayOptions, type BuiltGateway } from './build-gateway.js';

export interface ServeOptions extends BuildGatewayOptions {
  /** HTTP bind host. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /** HTTP port. `0` (default) asks the OS for an ephemeral port. */
  port?: number;
  /**
   * Pre-shared bearer token. When omitted, `startRuntimeHttpServer` mints
   * a random 32-byte hex token. The Electron embed lets this be random
   * per-launch; the daemon persists one across restarts.
   */
  token?: string;
}

export interface GatewayServeHandle extends Omit<
  BuiltGateway,
  'extraHandlers' | 'composedHandler' | 'start' | 'stop'
> {
  /** Bound base URL — `http://<host>:<port>`. */
  url: string;
  /** Bearer token the renderer must send on every request. */
  token: string;
  /** Stop the HTTP server. Idempotent in callers. */
  close(): Promise<void>;
}

export async function serve(options: ServeOptions): Promise<GatewayServeHandle> {
  const gateway = await buildGateway(options);

  const serverOptions: Parameters<typeof startRuntimeHttpServer>[0] = {
    runtime: gateway.runtime,
    extraHandlers: gateway.extraHandlers,
    // `/_centraid-user/id` answers with the ACTIVE vault's owner party id —
    // the vault owner IS the user (#280).
    ownerIdProvider: () => gateway.vaults.active().boot.ownerPartyId,
  };
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  if (options.token !== undefined) serverOptions.token = options.token;
  const server = await startRuntimeHttpServer(serverOptions);
  await gateway.start(server.url);

  return {
    url: server.url,
    token: server.token,
    // Stop the cron timer before the HTTP server so no fire is dispatched
    // mid-teardown.
    close: async () => {
      await gateway.stop();
      await server.close();
    },
    runtime: gateway.runtime,
    prefs: gateway.prefs,
    analyticsStore: gateway.analyticsStore,
    conversationHistoryStore: gateway.conversationHistoryStore,
    vaults: gateway.vaults,
    activeAppsStore: gateway.activeAppsStore,
    codeAppsDir: gateway.codeAppsDir,
  } satisfies GatewayServeHandle;
}
