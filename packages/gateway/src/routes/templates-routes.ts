// HTTP surface for the gateway-owned template catalog (issue #141).
//
// The desktop used to resolve the bundled @centraid/blueprints catalog
// in the main process and hand the renderer a stripped metadata list over
// IPC. Under the thin-client pivot the gateway owns the catalog: it
// resolves bundle-or-cache (preferring the higher semver) and serves the
// same metadata at `GET /centraid/_templates`, so local and remote
// gateways expose templates identically and the renderer reads them
// directly. Mounted via `startRuntimeHttpServer`'s `extraHandlers` seam,
// after the bearer check.
//
//   GET /centraid/_templates → [{ id, name, desc, colorKey, iconKey,
//                                 version, kind?, emoji?, category?,
//                                 triggerKind?, triggerLabel?, integrations?,
//                                 installed?, vault? }]   (installed = per-vault, #434)
//
// `vault` (#434, Phase 2) is the app-kind template's requested access —
// `{ purpose?, why?, scopes[] }` read straight from its `app.json` — so the
// Discover install sheet can render the consent surface (what the app will be
// able to touch) BEFORE the owner installs. Automations omit it.
//
// Only display metadata crosses the wire — `files` + `source` are stripped
// (the lists can be sizable and the renderer never needs them; the clone
// path reads files gateway-side). `kind` plus the automation-only display
// fields ARE sent: the renderer's automation gallery filters on `kind` and
// renders the card from emoji/category/trigger*/integrations.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  fetchRemoteTemplates,
  resolveTemplates,
  templateSourceDir,
  type ResolvedTemplate,
} from '@centraid/blueprints';
import { sendJson } from './route-helpers.js';

/** One requested scope of a template's `app.json` `vault` block. */
interface TemplateVaultScope {
  schema: string;
  table?: string;
  verbs: string;
}

/** The consent-relevant slice of a template's `app.json` `vault` block —
 *  the `why` sentence + requested scopes the Discover install sheet renders
 *  before the owner consents (issue #434, Phase 2). Display metadata only;
 *  the `purpose` DPV URI rides along for the per-app consent pane. */
interface TemplateVault {
  purpose?: string;
  why?: string;
  scopes: TemplateVaultScope[];
}

/**
 * Read the requested `vault` block from an app-kind template's `app.json`.
 * Automations declare their access on the automation manifest, not here, so
 * they're skipped. Best-effort: a missing/unparseable manifest or absent
 * vault block yields `undefined` (the sheet just shows identity + blurb).
 */
async function readTemplateVault(
  t: ResolvedTemplate,
  cacheDir?: string,
): Promise<TemplateVault | undefined> {
  if ((t.kind ?? 'app') === 'automation') return undefined;
  try {
    const dir = templateSourceDir(t.id, {
      kind: t.kind ?? 'app',
      source: t.source,
      ...(cacheDir ? { cacheDir } : {}),
    });
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8')) as {
      vault?: { purpose?: unknown; why?: unknown; scopes?: unknown };
    };
    const vault = parsed.vault;
    if (!vault || !Array.isArray(vault.scopes)) return undefined;
    const scopes: TemplateVaultScope[] = vault.scopes
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        schema: String(s.schema ?? ''),
        ...(typeof s.table === 'string' ? { table: s.table } : {}),
        verbs: String(s.verbs ?? ''),
      }))
      .filter((s) => s.schema && s.verbs);
    if (scopes.length === 0) return undefined;
    return {
      ...(typeof vault.purpose === 'string' ? { purpose: vault.purpose } : {}),
      ...(typeof vault.why === 'string' ? { why: vault.why } : {}),
      scopes,
    };
  } catch {
    return undefined;
  }
}

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
   * main process used to own before it dropped `@centraid/blueprints`.
   * `fetchRemoteTemplates` never throws (offline / 404 / bad manifest leave
   * the cache untouched), so this is safe to fire-and-forget.
   */
  remoteTemplatesUrl?: string;

  /**
   * Optional `fetch` implementation for the remote refresh, for tests /
   * non-Node environments. Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;

  /**
   * Installed bundled app ids for the request's vault (issue #434). When
   * provided, each catalog row carries `installed` so the Discover gallery
   * can show "Open" for an already-installed app instead of "Install".
   * Resolved per request off the ambient vault scope; omit for bundle-only
   * catalogs (tests) where install state is irrelevant.
   */
  installedAppIds?: () => Set<string>;
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
    // Install state is per-vault (issue #434) — resolve it once per request.
    const installed = opts.installedAppIds ? opts.installedAppIds() : undefined;
    // Requested-access blocks, read from each app template's app.json (#434,
    // Phase 2). Read in parallel; automations resolve to undefined.
    const vaults = await Promise.all(resolved.map((t) => readTemplateVault(t, opts.cacheDir)));
    sendJson(
      res,
      200,
      resolved.map((t, i) => ({
        id: t.id,
        name: t.name,
        desc: t.desc,
        colorKey: t.colorKey,
        iconKey: t.iconKey,
        version: t.version,
        // Whether this bundled app is already installed in the request's
        // vault. Only meaningful for app-kind templates; automations are
        // never in the installed set, so this stays false for them.
        ...(installed ? { installed: installed.has(t.id) } : {}),
        // Requested vault access, for the install/consent sheet (#434).
        ...(vaults[i] ? { vault: vaults[i] } : {}),
        // `kind` classifies the template (app vs automation) and the
        // renderer's automation gallery filters on it — omitting it left
        // that surface permanently empty. Pass it through, plus the
        // automation-only display fields the gallery card renders. All are
        // conditional so app templates stay lean.
        ...(t.kind !== undefined ? { kind: t.kind } : {}),
        ...(t.emoji !== undefined ? { emoji: t.emoji } : {}),
        ...(t.category !== undefined ? { category: t.category } : {}),
        ...(t.triggerKind !== undefined ? { triggerKind: t.triggerKind } : {}),
        ...(t.triggerLabel !== undefined ? { triggerLabel: t.triggerLabel } : {}),
        ...(t.integrations !== undefined ? { integrations: t.integrations } : {}),
      })),
    );
    return true;
  };
}
