/*
 * Probe an ACP agent for the capabilities Settings and pre-send checks need.
 *
 * Launches the agent the same way a turn would, runs `initialize` (+ a
 * session/new when possible), then tears down. Results are pure data —
 * no stream events. Used by the agents-status route and vault preflight.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { lowPriorityCommand } from "../../low-priority.js";
import { classifyAgentFailureDetail } from "./agent-errors.js";
import { ACP_PROTOCOL_VERSION, createAcpConnection } from "./json-rpc.js";
import { planLaunch } from "./launch.js";
import {
  findConfigOption,
  hasSessionCapability,
  readConfigOptions,
  readOfferedModels,
  type InitializeResult,
  type SessionSetupResult,
} from "./session-config.js";
import type { AcpTurnConfig } from "./types.js";

/** Persistable, adapter-neutral view of one ACP session config option. */
export interface AcpConfigOptionSnapshot {
  id: string;
  category: string;
  type: string;
  values: Array<{ value: string; name?: string }>;
  currentValue?: string;
}

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
  /** Full config option surface observed on session/new. */
  configOptions: AcpConfigOptionSnapshot[];
  /**
   * The bounded diagnostic prompt actually ran (it is opt-in — see
   * `probeLivePrompt`). When false the three `*Observed` flags below mean
   * "not observed", never "unsupported".
   */
  livePromptProbed: boolean;
  /** Optional ACP signals observed during the bounded diagnostic prompt. */
  usageUpdateObserved: boolean;
  configOptionUpdateObserved: boolean;
  locationsObserved: boolean;
  /** session/new failed with AUTH_REQUIRED. */
  authRequired: boolean;
  /** Prompt image capability. */
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  /** Epoch milliseconds when this evidence was collected. */
  probedAt: number;
  /**
   * Set by the capabilities cache when a snapshot has outlived its TTL: the
   * data is still displayable, but its verdicts (notably `authRequired`) are
   * no longer evidence of the CURRENT state.
   */
  stale?: boolean;
  /** Human reason when `reachable` is false. */
  reason?: string;
}

const emptyCaps = (
  over: Partial<AcpAgentCapabilities> = {}
): AcpAgentCapabilities => ({
  reachable: false,
  loadSession: false,
  resume: false,
  close: false,
  additionalDirectories: false,
  mcpHttp: false,
  mcpSse: false,
  mcpAcp: false,
  modelConfigurable: false,
  configOptions: [],
  livePromptProbed: false,
  usageUpdateObserved: false,
  configOptionUpdateObserved: false,
  locationsObserved: false,
  authRequired: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  probedAt: Date.now(),
  ...over,
});

function snapshotConfigOptions(
  options: ReturnType<typeof readConfigOptions>
): AcpConfigOptionSnapshot[] {
  return options.flatMap((option) => {
    if (
      typeof option.id !== "string" ||
      typeof option.category !== "string" ||
      typeof option.type !== "string"
    ) {
      return [];
    }
    const offered =
      option.category === "model"
        ? readOfferedModels(options).models
        : (() => {
            const selected = option.options;
            if (!Array.isArray(selected)) return [];
            const values: Array<{ value: string; name?: string }> = [];
            const visit = (entries: unknown[]): void => {
              for (const entry of entries) {
                if (!entry || typeof entry !== "object") continue;
                const record = entry as Record<string, unknown>;
                if (Array.isArray(record.options)) visit(record.options);
                else if (typeof record.value === "string") {
                  values.push({
                    value: record.value,
                    ...(typeof record.name === "string"
                      ? { name: record.name }
                      : {}),
                  });
                }
              }
            };
            visit(selected);
            return values;
          })();
    return [
      {
        id: option.id,
        category: option.category,
        type: option.type,
        values: offered,
        ...(typeof option.currentValue === "string"
          ? { currentValue: option.currentValue }
          : {}),
      },
    ];
  });
}

/**
 * Spawn → initialize → optional session/new → teardown. Bounded so a wedged
 * agent can't hang Settings forever.
 */
export async function probeAcpCapabilities(
  config: AcpTurnConfig,
  opts?: { cwd?: string; timeoutMs?: number; probeLivePrompt?: boolean }
): Promise<AcpAgentCapabilities> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const cwd =
    opts?.cwd ?? (await fs.mkdtemp(path.join(tmpdir(), "centraid-acp-cap-")));

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
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let usageUpdateObserved = false;
  let configOptionUpdateObserved = false;
  let locationsObserved = false;
  const conn = createAcpConnection(child, {
    onServerRequest: (id, method) => {
      conn.respondMethodNotFound(id, method);
    },
    onNotification: (method, params) => {
      if (method !== "session/update" || !params || typeof params !== "object")
        return;
      const update = (params as { update?: Record<string, unknown> }).update;
      if (!update) return;
      if (update.sessionUpdate === "usage_update") usageUpdateObserved = true;
      if (update.sessionUpdate === "config_option_update")
        configOptionUpdateObserved = true;
      if (
        (update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update") &&
        Array.isArray(update.locations) &&
        update.locations.length > 0
      ) {
        locationsObserved = true;
      }
    },
  });

  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const init = await conn.request<InitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "centraid-capability-probe",
        title: "Centraid",
        version: "0.1.0",
      },
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
      resume: hasSessionCapability(sc, "resume"),
      close: hasSessionCapability(sc, "close"),
      additionalDirectories: hasSessionCapability(sc, "additionalDirectories"),
      mcpHttp: mcp?.http === true,
      mcpSse: mcp?.sse === true,
      mcpAcp: mcp?.acp === true,
      promptImage: prompt?.image === true,
      promptAudio: prompt?.audio === true,
      promptEmbeddedContext: prompt?.embeddedContext === true,
    });

    try {
      const created = await conn.request<SessionSetupResult>("session/new", {
        cwd,
        mcpServers: [],
      });
      const configOptions = readConfigOptions(created);
      const offered = readOfferedModels(configOptions);
      caps.modelConfigurable = offered.models.length > 0;
      caps.configOptions = snapshotConfigOptions(configOptions);

      // `config_option_update`, context usage and tool locations are optional
      // runtime signals rather than initialize capabilities — the only way to
      // observe them is to run a real turn, which costs the owner a live
      // provider request. So this diagnostic prompt is OPT-IN
      // (`probeLivePrompt`): the explicit Settings refresh and the
      // `probe-all-adapters` evidence dump ask for it; readiness checks that
      // only need reachability/auth never do. Without it the three
      // `*Observed` flags stay false, which reads as "not observed", not
      // "unsupported".
      const sessionId =
        typeof created.sessionId === "string" ? created.sessionId : undefined;
      if (sessionId && opts?.probeLivePrompt === true) {
        const model = findConfigOption(configOptions, "model");
        const current = offered.models.find(
          (entry) => entry.value === offered.currentValue
        );
        if (model && typeof model.id === "string" && current) {
          // Re-apply the observed value rather than selecting an arbitrary
          // alternative. Some native agents persist config-option changes
          // globally, so a diagnostics refresh must never move the owner's
          // default model or choose a provider for which they have no key.
          await conn
            .request("session/set_config_option", {
              sessionId,
              configId: model.id,
              value: current.value,
            })
            .catch(() => undefined);
        }
        await conn
          .request("session/prompt", {
            sessionId,
            prompt: [
              {
                type: "text",
                text: "Centraid capability probe: reply briefly and do not modify files.",
              },
            ],
          })
          .catch((error: unknown) => {
            const classified = classifyAgentFailureDetail(
              error,
              conn.stderrTail(),
              config
            );
            if (classified.failureClass === "auth") {
              caps.authRequired = true;
              caps.reason = classified.message;
            }
          });
        caps.livePromptProbed = true;
      }
      caps.usageUpdateObserved = usageUpdateObserved;
      caps.configOptionUpdateObserved = configOptionUpdateObserved;
      caps.locationsObserved = locationsObserved;
    } catch (err) {
      const classified = classifyAgentFailureDetail(
        err,
        conn.stderrTail(),
        config
      );
      if (classified.failureClass === "auth") {
        caps.authRequired = true;
        caps.reason = classified.message;
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
    if (!child.killed) child.kill("SIGTERM");
    await conn.exited.catch(() => undefined);
  }
}
