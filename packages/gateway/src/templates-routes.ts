// HTTP surface for the gateway-owned template catalog (issue #141).
//
// The desktop used to resolve the bundled @centraid/app-templates catalog
// in the main process and hand the renderer a stripped metadata list over
// IPC. Under the thin-client pivot the gateway owns the catalog: it
// resolves bundle-or-cache (preferring the higher semver) and serves the
// same metadata at `GET /centraid/_templates`, so local and remote
// gateways expose templates identically and the renderer reads them
// directly. Mounted via `startRuntimeHttpServer`'s `extraHandlers` seam,
// after the bearer check.
//
//   GET /centraid/_templates → [{ id, name, desc, colorKey, iconKey,
//                                 version }]
//
// Only display metadata crosses the wire — `files` + `source` are stripped
// (the lists can be sizable and the renderer never needs them; the clone
// path reads files gateway-side).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { fetchRemoteTemplates, resolveTemplates } from '@centraid/app-templates';
import { sendJson } from './route-helpers.js';

export interface TemplatesRouteOptions {
  /**
   * Per-gateway template cache dir. When set, a newer copy pulled from a
   * remote URL can shadow the bundled template; omit for bundle-only
   * resolution (the standalone daemon / tests).
   */
  cacheDir?: string;

  /**
   * Optional remote template manifest URL (issue #141, Phase 5). When set
   * with `cacheDir`, the handler kicks a one-time best-effort refresh of the
   * cache from this URL on construction — the catalog refresh the desktop
   * main process used to own before it dropped `@centraid/app-templates`.
   * `fetchRemoteTemplates` never throws (offline / 404 / bad manifest leave
   * the cache untouched), so this is safe to fire-and-forget.
   */
  remoteTemplatesUrl?: string;

  /**
   * Optional `fetch` implementation for the remote refresh, for tests /
   * non-Node environments. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Build the templates route handler. Returns a function suitable for
 * `startRuntimeHttpServer`'s `extraHandlers`: resolves `true` when it
 * owned the request, `false` otherwise.
 */
export function makeTemplatesRouteHandler(
  opts: TemplatesRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  // One-time remote refresh on construction (mirrors the desktop's old
  // startup fetch). Best-effort + non-throwing; the cache stays usable even
  // if the network is down. Only meaningful when both a cache dir and a
  // remote URL are configured.
  if (opts.cacheDir && opts.remoteTemplatesUrl) {
    void fetchRemoteTemplates({
      cacheDir: opts.cacheDir,
      remoteUrl: opts.remoteTemplatesUrl,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/centraid/_templates') return false;
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;

    const resolved = await resolveTemplates(opts.cacheDir ? { cacheDir: opts.cacheDir } : {});
    sendJson(
      res,
      200,
      resolved.map((t) => ({
        id: t.id,
        name: t.name,
        desc: t.desc,
        colorKey: t.colorKey,
        iconKey: t.iconKey,
        version: t.version,
      })),
    );
    return true;
  };
}
