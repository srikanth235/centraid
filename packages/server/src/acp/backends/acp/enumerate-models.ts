import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { methods } from "@agentclientprotocol/sdk";

import type { HarnessModel } from "@centraid/server/engine";

import { unrefTimer } from "../../../lib/unref-timer.js";
import { lowPriorityCommand } from "../../low-priority.js";
import { ACP_PROTOCOL_VERSION, createAcpConnection } from "./connection.js";
import { planLaunch } from "./launch.js";
import { readConfigOptions, readOfferedModels } from "./session-config.js";
import type { OfferedModel } from "./session-config.js";
import type { AcpTurnConfig } from "./types.js";

const PROBE_TIMEOUT_MS = 12_000;

const KILL_GRACE_MS = 2_000;

export async function enumerateAcpModels(
  config: AcpTurnConfig
): Promise<HarnessModel[]> {
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  try {
    launch = planLaunch(config, undefined, []);
  } catch {
    return [];
  }

  let cwd: string;
  try {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "centraid-acp-models-"));
  } catch {
    return [];
  }

  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    const command = lowPriorityCommand(launch.bin, launch.args);
    child = spawn(command.bin, command.args, {
      cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
  } catch {
    await removeQuietly(cwd);
    return [];
  }

  const conn = createAcpConnection(child);

  try {
    return await withTimeout(probe(conn, cwd), PROBE_TIMEOUT_MS);
  } catch {
    return [];
  } finally {
    try {
      child.stdin.end();
    } catch {
      // Intentionally empty.
    }
    if (!child.killed) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    unrefTimer(killTimer);
    await conn.exited;
    clearTimeout(killTimer);
    await removeQuietly(cwd);
  }
}

async function probe(
  conn: ReturnType<typeof createAcpConnection>,
  cwd: string
): Promise<HarnessModel[]> {
  await conn.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: "centraid-local-harness",
      title: "Centraid",
      version: "0.1.0",
    },
  });

  const created = await conn.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
  });

  const { models, currentValue } = readOfferedModels(
    readConfigOptions(created)
  );
  return mapOfferedModels(models, currentValue);
}

export function mapOfferedModels(
  offered: OfferedModel[],
  currentValue?: string
): HarnessModel[] {
  const seen = new Set<string>();
  const models: HarnessModel[] = [];
  for (const entry of offered) {
    const id = entry.value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model: HarnessModel = { id };
    const name = entry.name?.trim();
    if (name && name !== id) model.name = name;
    if (currentValue && id === currentValue) model.default = true;
    models.push(model);
  }
  return models;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("acp model probe timed out")),
      ms
    );
    unrefTimer(timer);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function removeQuietly(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
