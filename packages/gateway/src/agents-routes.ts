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
import { sendJson } from './route-helpers.js';

export interface AgentsStatus {
  /** The `codex` CLI is runnable on the gateway host. */
  codexAvailable: boolean;
  /** The `claude` CLI is runnable on the gateway host. */
  claudeAvailable: boolean;
  /** `codex --version` output when available. */
  codexVersion?: string;
  /** `claude --version` output when available. */
  claudeVersion?: string;
}

/** Probe the gateway host for runnable coding-agent CLIs. */
export async function readAgentsStatus(): Promise<AgentsStatus> {
  const [codex, claude] = await Promise.all([
    probeCliAvailability('codex'),
    probeCliAvailability('claude-code'),
  ]);
  return {
    codexAvailable: codex.available,
    claudeAvailable: claude.available,
    ...(codex.version ? { codexVersion: codex.version } : {}),
    ...(claude.version ? { claudeVersion: claude.version } : {}),
  };
}

/**
 * Build the agents route handler. Returns a function suitable for
 * `startRuntimeHttpServer`'s `extraHandlers`: resolves `true` when it owned
 * the request, `false` otherwise.
 */
export function makeAgentsRouteHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/centraid/_agents/status') return false;
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;

    sendJson(res, 200, await readAgentsStatus());
    return true;
  };
}
