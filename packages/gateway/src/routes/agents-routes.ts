// HTTP surface for gateway-owned coding-agent detection.
//
// The desktop main process used to probe the on-machine state itself and
// hand the renderer a snapshot over IPC. But the agent runs wherever the
// GATEWAY runs, and Centraid is agnostic to how each agent authenticates —
// every runner owns its own auth. So detection asks one question only: is
// the CLI runnable on the gateway host? We run `<bin> --version` for each
// v0-supported runner and report success.
//
//   GET /centraid/_agents/status → { agents: AgentStatusEntry[] }
//
// The response is a LIST, one entry per supported/offered runner kind, derived
// from `SUPPORTED_RUNNER_KINDS`. The broader backend registry remains intact
// so persisted non-roster pins keep resolving, but adding an experimental
// backend does not silently expand the v0 product surface.
//
// `?refresh=1` re-enumerates each agent's models; a plain read returns them
// from the catalog cache (and, when a surface is cold, kicks a background
// warm). `modelsStatus` carries the load tri-state so the client shows a
// loading placeholder and polls.
//
// The per-agent TOOLS listing that used to ride this route (`codexTools`,
// `?refreshTools=1`, …) is gone — Connections is where the user reasons about
// what an agent can reach. Host-tool enumeration itself is untouched: it still
// feeds the builder's grounding block (`src/skills/`), read off the same
// catalog by `makeUnifiedConversationRunner`.
//
// Mounted via `startRuntimeHttpServer`'s `extraHandlers` seam, after the
// bearer check. A remote gateway reports its own host's CLIs, not the
// desktop's.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  SUPPORTED_RUNNER_BACKENDS,
  minVersionString,
  probeCliAvailability,
} from "@centraid/agent-runtime";
import type {
  RunnerHealthEntry,
  RunnerKind,
  RunnerModel,
  SurfaceStatus,
} from "@centraid/app-engine";

import { sendJson } from "./route-helpers.js";

/**
 * A resolved catalog surface: the cached list plus its load tri-state
 * (`loading` while the warmer enumerates, `ready` once cached, `empty` when
 * enumeration found nothing / the CLI is unavailable). The client polls while
 * `loading`.
 */
export interface ResolvedSurface<T> {
  list: T[];
  status: SurfaceStatus;
}

/**
 * Resolve the models for a single runner kind from the catalog (a `refresh` —
 * or a cold cache — kicks the warmer fire-and-forget). Supplied by the gateway
 * so this route can report EACH agent's models, not just the active runner's
 * (all `runner-status` knows). Degrades to `{ list: [], status: 'empty' }`.
 */
export type ResolveAgentModels = (
  kind: RunnerKind,
  refresh: boolean
) => Promise<ResolvedSurface<RunnerModel>>;

/**
 * The binary this gateway would actually invoke for a kind, when the owner
 * configured an override. Only the custom `acp` kind NEEDS one (it ships no
 * default binary, so it is unavailable until a path is set); for the rest an
 * override just makes the probe hit the same binary a turn would.
 */
export type BinPathForKind = (kind: RunnerKind) => string | undefined;

/**
 * Optional ACP capability probe (spawn + initialize). Supplied by the gateway
 * so Settings can show vault/resume/auth honesty without the route owning
 * agent-runtime spawn details.
 */
export type ResolveAgentCapabilities = (
  kind: RunnerKind,
  refresh: boolean
) => Promise<AgentAcpCapabilities | undefined>;

export type ResolveAgentHealth = (kind: RunnerKind) => RunnerHealthEntry[];

/**
 * ACP capability strip from a real `initialize` probe (optional; filled when
 * the host probes available agents — typically on `?refresh=1`).
 */
export interface AgentAcpCapabilities {
  reachable: boolean;
  loadSession: boolean;
  resume: boolean;
  close: boolean;
  additionalDirectories: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  modelConfigurable: boolean;
  configOptions?: Array<{
    id: string;
    category: string;
    type: string;
    values: Array<{ value: string; name?: string }>;
    currentValue?: string;
  }>;
  usageUpdateObserved?: boolean;
  configOptionUpdateObserved?: boolean;
  locationsObserved?: boolean;
  authRequired: boolean;
  promptImage: boolean;
  promptAudio?: boolean;
  promptEmbeddedContext?: boolean;
  probedAt?: number;
  /** Human reason when the probe could not reach the agent. */
  reason?: string;
}

/** One registered runner kind's state on this gateway host. */
export interface AgentStatusEntry {
  /**
   * The runner kind (`codex`, `claude-code`, `gemini`, …). Typed as the
   * gateway's `RunnerKind` here because the gateway only ever emits kinds it
   * has registered; clients parse it as an open string so a kind added by a
   * newer gateway still renders (docs/protocol.md C1a).
   */
  kind: RunnerKind;
  /** Human label for pickers and cards, from the runner backend. */
  label: string;
  /** The CLI is runnable on the gateway host (`<bin> --version` succeeded). */
  available: boolean;
  /** Trimmed `<bin> --version` output, when available. */
  version?: string;
  /** Minimum CLI version whose protocol we've verified, e.g. `"0.128.0"`. */
  minVersion: string;
  /** Install/setup hint — present only when the CLI is NOT available. */
  hint?: string;
  /** Models this runner can serve, from the catalog (issue #188). */
  models: RunnerModel[];
  /** Load state of `models` — lets the picker show loading vs empty. */
  modelsStatus: SurfaceStatus;
  /** The model this runner defaults to, when its catalog names one. */
  defaultModel?: string;
  /**
   * Live ACP capabilities (vault HTTP, session resume, model pin, auth).
   * Absent until the host has probed this kind at least once.
   */
  capabilities?: AgentAcpCapabilities;
  /** Persisted, real-turn breaker state for this runner. */
  health?: RunnerHealthEntry[];
}

export interface AgentsStatus {
  /** One entry per product-supported runner kind, in roster order. */
  agents: AgentStatusEntry[];
}

/**
 * Probe the gateway host for runnable coding-agent CLIs and — when a model
 * resolver is supplied — each agent's models, so Settings → Agents can offer a
 * per-agent model picker with a loading/empty state independent of which
 * runner is active.
 *
 * Only the intentionally offered v0 roster is probed. Registered-but-hidden
 * kinds remain runnable for persisted preferences.
 */
export async function readAgentsStatus(opts?: {
  resolveModels?: ResolveAgentModels;
  resolveCapabilities?: ResolveAgentCapabilities;
  binPathFor?: BinPathForKind;
  resolveHealth?: ResolveAgentHealth;
  refresh?: boolean;
}): Promise<AgentsStatus> {
  const resolveModels = opts?.resolveModels;
  const resolveCapabilities = opts?.resolveCapabilities;
  const binPathFor = opts?.binPathFor;
  const refresh = opts?.refresh ?? false;
  const emptyModels: ResolvedSurface<RunnerModel> = {
    list: [],
    status: "empty",
  };

  const agents = await Promise.all(
    SUPPORTED_RUNNER_BACKENDS.map(
      async (backend): Promise<AgentStatusEntry> => {
        const binPath = binPathFor?.(backend.kind);
        const [availability, models] = await Promise.all([
          probeCliAvailability(backend.kind, binPath, { refresh }),
          resolveModels
            ? resolveModels(backend.kind, refresh).catch(() => emptyModels)
            : Promise.resolve(emptyModels),
        ]);
        const defaultModel = models.list.find((m) => m.default)?.id;
        const capabilities =
          availability.available && resolveCapabilities
            ? await resolveCapabilities(backend.kind, refresh).catch(
                () => undefined
              )
            : undefined;
        const health = opts?.resolveHealth?.(backend.kind) ?? [];
        return {
          kind: backend.kind,
          label: backend.label,
          available: availability.available,
          ...(availability.version ? { version: availability.version } : {}),
          minVersion: minVersionString(backend.kind),
          // The hint is the "what do I do about it" half of an unavailable
          // agent; on an available one it would just be noise in the payload.
          ...(availability.available ? {} : { hint: backend.installHint }),
          models: models.list,
          modelsStatus: models.status,
          ...(defaultModel ? { defaultModel } : {}),
          ...(capabilities ? { capabilities } : {}),
          ...(health.length > 0 ? { health } : {}),
        };
      }
    )
  );

  return { agents };
}

/**
 * Build the agents route handler. Returns a function suitable for
 * `startRuntimeHttpServer`'s `extraHandlers`: resolves `true` when it owned the
 * request, `false` otherwise. `?refresh=1` invalidates availability and
 * re-enumerates each agent's models; otherwise the caches answer, with a
 * background model warm kicked when a surface is cold.
 */
export function makeAgentsRouteHandler(opts?: {
  resolveModels?: ResolveAgentModels;
  resolveCapabilities?: ResolveAgentCapabilities;
  binPathFor?: BinPathForKind;
  resolveHealth?: ResolveAgentHealth;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/centraid/_agents/status") return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") return false;

    const refresh = url.searchParams.get("refresh") === "1";
    sendJson(
      res,
      200,
      await readAgentsStatus({
        ...(opts?.resolveModels ? { resolveModels: opts.resolveModels } : {}),
        ...(opts?.resolveCapabilities
          ? { resolveCapabilities: opts.resolveCapabilities }
          : {}),
        ...(opts?.binPathFor ? { binPathFor: opts.binPathFor } : {}),
        ...(opts?.resolveHealth ? { resolveHealth: opts.resolveHealth } : {}),
        refresh,
      })
    );
    return true;
  };
}
