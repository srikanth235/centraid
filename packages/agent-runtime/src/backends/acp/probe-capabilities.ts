/*
 * Probe an ACP agent for the capabilities Settings and pre-send checks need.
 *
 * Launches the agent the same way a turn would, runs `initialize` (+ a
 * session/new when possible), then tears down. Results are pure data —
 * no stream events. Used by the agents-status route and vault preflight.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { lowPriorityCommand } from '../../low-priority.js';
import {
  ACP_PROTOCOL_VERSION,
  AUTH_REQUIRED_CODE,
  AcpRpcError,
  createAcpConnection,
} from './json-rpc.js';
import { planLaunch } from './launch.js';
import {
  hasSessionCapability,
  readConfigOptions,
  readOfferedModels,
  type InitializeResult,
  type SessionSetupResult,
} from './session-config.js';
import type { AcpTurnConfig } from './types.js';

/** Wire-stable capability snapshot for one runner kind on this host. */
export interface AcpAgentCapabilities {
  /** CLI spawned and answered `initialize`. */
  reachable: boolean;
  loadSession: boolean;
  resume: boolean;
  close: boolean;
  additionalDirectories: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  mcpAcp: boolean;
  /** Agent exposes a model config option we can pin. */
  modelConfigurable: boolean;
  /** session/new failed with AUTH_REQUIRED. */
  authRequired: boolean;
  /** Prompt image capability. */
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  /** Human reason when `reachable` is false. */
  reason?: string;
}

const emptyCaps = (over: Partial<AcpAgentCapabilities> = {}): AcpAgentCapabilities => ({
  reachable: false,
  loadSession: false,
  resume: false,
  close: false,
  additionalDirectories: false,
  mcpHttp: false,
  mcpSse: false,
  mcpAcp: false,
  modelConfigurable: false,
  authRequired: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  ...over,
});

/**
 * Spawn → initialize → optional session/new → teardown. Bounded so a wedged
 * agent can't hang Settings forever.
 */
export async function probeAcpCapabilities(
  config: AcpTurnConfig,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<AcpAgentCapabilities> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const cwd = opts?.cwd ?? (await fs.mkdtemp(path.join(tmpdir(), 'centraid-acp-cap-')));

  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  try {
    launch = planLaunch(config, undefined, []);
  } catch (err) {
    return emptyCaps({
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  await fs.mkdir(cwd, { recursive: true });
  const command = lowPriorityCommand(launch.bin, launch.args);
  const child = spawn(command.bin, command.args, {
    cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const conn = createAcpConnection(child, {
    onServerRequest: (id, method) => {
      conn.respondMethodNotFound(id, method);
    },
    onNotification: () => undefined,
  });

  const timer = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const init = await conn.request<InitializeResult>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'centraid-capability-probe', title: 'Centraid', version: '0.1.0' },
    });

    const ac = init?.agentCapabilities;
    const sc = ac?.sessionCapabilities;
    const mcp = ac?.mcpCapabilities;
    const prompt = ac?.promptCapabilities as
      | { image?: unknown; audio?: unknown; embeddedContext?: unknown }
      | undefined;

    const caps = emptyCaps({
      reachable: true,
      loadSession: ac?.loadSession === true,
      resume: hasSessionCapability(sc, 'resume'),
      close: hasSessionCapability(sc, 'close'),
      additionalDirectories: hasSessionCapability(sc, 'additionalDirectories'),
      mcpHttp: mcp?.http === true,
      mcpSse: mcp?.sse === true,
      mcpAcp: mcp?.acp === true,
      promptImage: prompt?.image === true,
      promptAudio: prompt?.audio === true,
      promptEmbeddedContext: prompt?.embeddedContext === true,
    });

    try {
      const created = await conn.request<SessionSetupResult>('session/new', {
        cwd,
        mcpServers: [],
      });
      const offered = readOfferedModels(readConfigOptions(created));
      caps.modelConfigurable = offered.models.length > 0;
    } catch (err) {
      if (err instanceof AcpRpcError && err.code === AUTH_REQUIRED_CODE) {
        caps.authRequired = true;
      }
    }

    return caps;
  } catch (err) {
    return emptyCaps({
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (!child.killed) child.kill('SIGTERM');
    await conn.exited.catch(() => undefined);
  }
}
