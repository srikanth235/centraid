// HTTP surface for gateway-owned coding-agent detection.
//
// The desktop main process used to probe the on-machine state itself and
// hand the renderer a snapshot over IPC. But the agent runs wherever the
// GATEWAY runs, and Centraid is agnostic to how each agent authenticates —
// codex and Claude Code each own their own auth. So detection asks one
// question only: is the CLI runnable on the gateway host? We run
// `<bin> --version` for each known runner and report success.
//
//   GET /centraid/_agents/status → { codexAvailable, claudeAvailable,
//                                    codexVersion?, claudeVersion? }
//
// Mounted via `startRuntimeHttpServer`'s `extraHandlers` seam, after the
// bearer check. A remote gateway reports its own host's CLIs, not the
// desktop's.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { probeCliAvailability } from '@centraid/agent-runtime';
import type { RunnerModel } from '@centraid/app-engine';
import { sendJson } from './route-helpers.js';

/** Runner kinds the desktop Agents panel configures. */
export type AgentKind = 'codex' | 'claude-code';

/**
 * Resolve the models for a single runner kind (catalog cache or default seed;
 * `refresh` enumerates live). Supplied by the gateway so this route can report
 * EACH agent's models — not just the active runner's, which is all
 * `runner-status` knows. Returns `[]` when unavailable.
 */
export type ResolveAgentModels = (kind: AgentKind, refresh: boolean) => Promise<RunnerModel[]>;

export interface AgentsStatus {
  /** The `codex` CLI is runnable on the gateway host. */
  codexAvailable: boolean;
  /** The `claude` CLI is runnable on the gateway host. */
  claudeAvailable: boolean;
  /** `codex --version` output when available. */
  codexVersion?: string;
  /** `claude --version` output when available. */
  claudeVersion?: string;
  /** Models codex can serve (default seed or refreshed catalog). Issue #188. */
  codexModels?: RunnerModel[];
  /** Models Claude Code can serve (default seed or refreshed catalog). */
  claudeModels?: RunnerModel[];
}

/**
 * Probe the gateway host for runnable coding-agent CLIs, and — when a model
 * resolver is supplied — each agent's models (so Settings → Agents can offer a
 * per-agent default-model picker, independent of which runner is active).
 */
export async function readAgentsStatus(opts?: {
  resolveModels?: ResolveAgentModels;
  refresh?: boolean;
}): Promise<AgentsStatus> {
  const resolve = opts?.resolveModels;
  const refresh = opts?.refresh ?? false;
  const [codex, claude, codexModels, claudeModels] = await Promise.all([
    probeCliAvailability('codex'),
    probeCliAvailability('claude-code'),
    resolve ? resolve('codex', refresh).catch(() => []) : Promise.resolve(undefined),
    resolve ? resolve('claude-code', refresh).catch(() => []) : Promise.resolve(undefined),
  ]);
  return {
    codexAvailable: codex.available,
    claudeAvailable: claude.available,
    ...(codex.version ? { codexVersion: codex.version } : {}),
    ...(claude.version ? { claudeVersion: claude.version } : {}),
    ...(codexModels ? { codexModels } : {}),
    ...(claudeModels ? { claudeModels } : {}),
  };
}

/**
 * Build the agents route handler. Returns a function suitable for
 * `startRuntimeHttpServer`'s `extraHandlers`: resolves `true` when it owned
 * the request, `false` otherwise. `?refresh=1` re-enumerates each agent's
 * models live (otherwise the catalog cache / default seed is returned).
 */
export function makeAgentsRouteHandler(opts?: {
  resolveModels?: ResolveAgentModels;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/centraid/_agents/status') return false;
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;

    const refresh = url.searchParams.get('refresh') === '1';
    sendJson(
      res,
      200,
      await readAgentsStatus({
        ...(opts?.resolveModels ? { resolveModels: opts.resolveModels } : {}),
        refresh,
      }),
    );
    return true;
  };
}
