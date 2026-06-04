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
//                                    codexVersion?, claudeVersion?,
//                                    codexModels?, claudeModels?,
//                                    codexTools?, claudeTools? }
//
// Models and tools refresh on INDEPENDENT triggers: `?refresh=1` re-enumerates
// each agent's models; `?refreshTools=1` re-probes each agent's tool surface
// (builtins + MCP). A plain read returns both from the catalog cache.
//
// Mounted via `startRuntimeHttpServer`'s `extraHandlers` seam, after the
// bearer check. A remote gateway reports its own host's CLIs, not the
// desktop's.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { probeCliAvailability, type HostTool } from '@centraid/agent-runtime';
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

/**
 * Resolve the host tools for a single runner kind (catalog cache; `refresh`
 * re-probes the CLI live). Tools have no seed, so a cold catalog yields `[]`.
 */
export type ResolveAgentTools = (kind: AgentKind, refresh: boolean) => Promise<HostTool[]>;

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
  /** Tools codex exposes (builtins + MCP), from the catalog. */
  codexTools?: HostTool[];
  /** Tools Claude Code exposes (builtins + MCP), from the catalog. */
  claudeTools?: HostTool[];
}

/**
 * Probe the gateway host for runnable coding-agent CLIs, and — when the
 * resolvers are supplied — each agent's models and tools (so Settings → Agents
 * can show a per-agent model picker and tool list, independent of which runner
 * is active). Models and tools refresh on independent flags.
 */
export async function readAgentsStatus(opts?: {
  resolveModels?: ResolveAgentModels;
  resolveTools?: ResolveAgentTools;
  refresh?: boolean;
  refreshTools?: boolean;
}): Promise<AgentsStatus> {
  const resolveModels = opts?.resolveModels;
  const resolveTools = opts?.resolveTools;
  const refresh = opts?.refresh ?? false;
  const refreshTools = opts?.refreshTools ?? false;
  const [codex, claude, codexModels, claudeModels, codexTools, claudeTools] = await Promise.all([
    probeCliAvailability('codex'),
    probeCliAvailability('claude-code'),
    resolveModels ? resolveModels('codex', refresh).catch(() => []) : Promise.resolve(undefined),
    resolveModels
      ? resolveModels('claude-code', refresh).catch(() => [])
      : Promise.resolve(undefined),
    resolveTools ? resolveTools('codex', refreshTools).catch(() => []) : Promise.resolve(undefined),
    resolveTools
      ? resolveTools('claude-code', refreshTools).catch(() => [])
      : Promise.resolve(undefined),
  ]);
  return {
    codexAvailable: codex.available,
    claudeAvailable: claude.available,
    ...(codex.version ? { codexVersion: codex.version } : {}),
    ...(claude.version ? { claudeVersion: claude.version } : {}),
    ...(codexModels ? { codexModels } : {}),
    ...(claudeModels ? { claudeModels } : {}),
    ...(codexTools ? { codexTools } : {}),
    ...(claudeTools ? { claudeTools } : {}),
  };
}

/**
 * Build the agents route handler. Returns a function suitable for
 * `startRuntimeHttpServer`'s `extraHandlers`: resolves `true` when it owned the
 * request, `false` otherwise. `?refresh=1` re-enumerates each agent's models;
 * `?refreshTools=1` re-probes each agent's tools (otherwise the catalog cache /
 * default seed is returned).
 */
export function makeAgentsRouteHandler(opts?: {
  resolveModels?: ResolveAgentModels;
  resolveTools?: ResolveAgentTools;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/centraid/_agents/status') return false;
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;

    const refresh = url.searchParams.get('refresh') === '1';
    const refreshTools = url.searchParams.get('refreshTools') === '1';
    sendJson(
      res,
      200,
      await readAgentsStatus({
        ...(opts?.resolveModels ? { resolveModels: opts.resolveModels } : {}),
        ...(opts?.resolveTools ? { resolveTools: opts.resolveTools } : {}),
        refresh,
        refreshTools,
      }),
    );
    return true;
  };
}
