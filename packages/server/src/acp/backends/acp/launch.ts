/*
 * Launch planning per harness kind. Native kinds spawn their own CLI + ACP
 * flag; adapter-backed spawn `node <adapter entry>` with `binPath` redirected
 * into the adapter's CLI locator env var. `config.env` is the ONE launch-env
 * field for both flavours.
 */

import type { TurnStreamEvent } from "@centraid/server/engine";

import { harnessSpawnEnv } from "../../spawn-env.js";
import { resolveAdapterEntry } from "./adapter-bin.js";
import type { AcpTurnConfig } from "./types.js";

export interface LaunchPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Throws when impossible; owner-facing findings ride `notices` (turn order). */
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
    // Native kinds get the same per-kind launch env; auggie/droid need it to
    // stop mid-session self-update.
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

  // The claude adapter downgrades the requested mode when root-without-
  // sandbox; opt in explicitly for root unattended gateways, and say so.
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

  // `process.execPath`, not a .bin shim — spawn-env strips .bin off PATH.
  return { bin: process.execPath, args: [entry, ...extraArgs], env };
}

function isRoot(): boolean {
  return (process.geteuid?.() ?? process.getuid?.()) === 0;
}
