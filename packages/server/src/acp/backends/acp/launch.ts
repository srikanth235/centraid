import type { TurnStreamEvent } from "@centraid/server/engine";

import { harnessSpawnEnv } from "../../spawn-env.js";
import { resolveAdapterEntry } from "./adapter-bin.js";
import type { AcpTurnConfig } from "./types.js";

export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function planLaunch(
  config: AcpTurnConfig,
  extraPath: string | undefined,
  notices: TurnStreamEvent[]
): LaunchPlan {
  const extraArgs = config.extraArgs ?? [];
  const adapter = config.adapter;

  if (!adapter) {
    const bin = config.binPath ?? config.defaultBin;
    if (!bin) {
      throw new Error(
        "No binary configured for the ACP harness — set its path in Settings → Agents."
      );
    }
    const nativeEnv = harnessSpawnEnv({
      ...(config.binPath ? { binPath: config.binPath } : {}),
      ...(extraPath ? { extraPath } : {}),
    });
    Object.assign(nativeEnv, config.env ?? {});
    return { bin, args: [...config.acpArgs, ...extraArgs], env: nativeEnv };
  }

  const entry = resolveAdapterEntry(adapter.packageName);
  const env = harnessSpawnEnv({
    ...(config.binPath ? { binPath: config.binPath } : {}),
    ...(extraPath ? { extraPath } : {}),
  });
  Object.assign(env, config.env ?? {});
  if (config.binPath && adapter.binPathEnvVar)
    env[adapter.binPathEnvVar] = config.binPath;

  if (adapter.bypassNeedsSandboxWhenRoot && isRoot() && !env.IS_SANDBOX) {
    env.IS_SANDBOX = "1";
    notices.push({
      type: "notice",
      level: "warn",
      code: "root_bypass_optin",
      message:
        "Running as root: the harness’s non-interactive permission mode was enabled explicitly " +
        "(IS_SANDBOX). Tool calls run without approval prompts — prefer running the gateway as " +
        "a normal user.",
    });
  }

  return { bin: process.execPath, args: [entry, ...extraArgs], env };
}

function isRoot(): boolean {
  return (process.geteuid?.() ?? process.getuid?.()) === 0;
}
