/*
 * Launch planning: what process to spawn for a runner kind, and with what
 * environment.
 *
 * Native-ACP kinds spawn their own CLI with the ACP flag. Adapter-backed kinds
 * spawn `node <adapter entry>`; the user's `binPath` is redirected into the
 * adapter's "where is the real CLI" env var, since with an adapter in the
 * middle `binPath` names the agent CLI, not the process we launch.
 */

import type { TurnStreamEvent } from '@centraid/app-engine';
import { agentSpawnEnv } from '../../spawn-env.js';
import { resolveAdapterEntry } from './adapter-bin.js';
import type { AcpTurnConfig } from './types.js';

export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Decide what process to spawn and with what environment.
 *
 * Throws when a launch is impossible (no binary, adapter not installed).
 * Findings worth telling the owner about are pushed onto `notices` rather than
 * emitted here, so they reach the transcript in turn order — after the
 * handshake has proved the agent is actually alive.
 */
export function planLaunch(
  config: AcpTurnConfig,
  extraPath: string | undefined,
  notices: TurnStreamEvent[],
): LaunchPlan {
  const extraArgs = config.extraArgs ?? [];
  const adapter = config.adapter;

  if (!adapter) {
    const bin = config.binPath ?? config.defaultBin;
    if (!bin) {
      throw new Error(
        'No binary configured for the ACP runner — set its path in Settings → Agents.',
      );
    }
    return {
      bin,
      args: [...config.acpArgs, ...extraArgs],
      env: agentSpawnEnv({
        ...(config.binPath ? { binPath: config.binPath } : {}),
        ...(extraPath ? { extraPath } : {}),
      }),
    };
  }

  const entry = resolveAdapterEntry(adapter.packageName);
  const env = agentSpawnEnv({
    ...(config.binPath ? { binPath: config.binPath } : {}),
    ...(extraPath ? { extraPath } : {}),
  });
  Object.assign(env, adapter.env ?? {});
  if (config.binPath && adapter.binPathEnvVar) env[adapter.binPathEnvVar] = config.binPath;

  // The claude adapter computes `ALLOW_BYPASS = !IS_ROOT || !!IS_SANDBOX` at
  // module load and silently downgrades the requested mode when it is false.
  // Running as root is the only case where that bites, and it is exactly the
  // case where an unattended gateway most needs the non-interactive mode, so
  // we opt in explicitly — and say so, rather than letting the user discover
  // it as a mysteriously stalled tool call.
  if (adapter.bypassNeedsSandboxWhenRoot && isRoot() && !env.IS_SANDBOX) {
    env.IS_SANDBOX = '1';
    notices.push({
      type: 'notice',
      level: 'warn',
      code: 'root_bypass_optin',
      message:
        'Running as root: the agent’s non-interactive permission mode was enabled explicitly ' +
        '(IS_SANDBOX). Tool calls run without approval prompts — prefer running the gateway as ' +
        'a normal user.',
    });
  }

  // `process.execPath` (not a node_modules/.bin shim): the adapters are ESM
  // Node programs, and `spawn-env.ts` strips `node_modules/.bin` off PATH.
  return { bin: process.execPath, args: [entry, ...extraArgs], env };
}

function isRoot(): boolean {
  return (process.geteuid?.() ?? process.getuid?.()) === 0;
}
