// HTTP surface for gateway-owned harness detection.
//
// The desktop main process used to probe the on-machine state itself and
// hand the renderer a snapshot over IPC. But the harness runs wherever the
// GATEWAY runs, and Centraid is agnostic to how each harness authenticates —
// every harness owns its own auth. So detection asks one question only: is
// the CLI runnable on the gateway host? We run `<bin> --version` for each
// v0-supported harness and report success.
//
//   GET /centraid/_harnesses/status → { harnesses: HarnessStatusEntry[] }
//
// The response is a LIST, one entry per supported/offered harness kind, derived
// from `SUPPORTED_HARNESS_KINDS`. The broader harness registry remains intact
// so persisted non-roster pins keep resolving, but adding an experimental
// harness does not silently expand the v0 product surface.
//
// `?refresh=1` re-enumerates each harness's models; a plain read returns them
// from the catalog cache (and, when a surface is cold, kicks a background
// warm). `modelsStatus` carries the load tri-state so the client shows a
// loading placeholder and polls.
//
// The per-harness TOOLS listing that used to ride this route (`codexTools`,
// `?refreshTools=1`, …) is gone — Connections is where the user reasons about
// what a harness can reach. Host-tool enumeration itself is untouched: it still
// feeds the builder's grounding block (`src/skills/`), read off the same
// catalog by `makeUnifiedConversationRunner`.
//
// Mounted via `startRuntimeHttpServer`'s `extraHandlers` seam, after the
// bearer check. A remote gateway reports its own host's CLIs, not the
// desktop's.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  SUPPORTED_HARNESSES,
  minVersionString,
  probeCliAvailability,
} from "@centraid/server/acp";
import type {
  HarnessHealthEntry,
  HarnessKind,
  HarnessModel,
  SurfaceStatus,
} from "@centraid/server/engine";

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
 * Resolve the models for a single harness kind from the catalog (a `refresh` —
 * or a cold cache — kicks the warmer fire-and-forget). Supplied by the gateway
 * so this route can report EACH harness's models, not just the active harness's
 * (all `harness-status` knows). Degrades to `{ list: [], status: 'empty' }`.
 */
export type ResolveHarnessModels = (
  kind: HarnessKind,
  refresh: boolean
) => Promise<ResolvedSurface<HarnessModel>>;

/**
 * The binary this gateway would actually invoke for a kind, when the owner
 * configured an override. Only the custom `acp` kind NEEDS one (it ships no
 * default binary, so it is unavailable until a path is set); for the rest an
 * override just makes the probe hit the same binary a turn would.
 */
export type BinPathForKind = (kind: HarnessKind) => string | undefined;

/**
 * Optional ACP capability probe (spawn + initialize). Supplied by the gateway
 * so Settings can show vault/resume/auth honesty without the route owning
 * harness-runtime spawn details.
 */
export type ResolveHarnessCapabilities = (
  kind: HarnessKind,
  refresh: boolean
) => Promise<HarnessAcpCapabilities | undefined>;

export type ResolveHarnessHealth = (kind: HarnessKind) => HarnessHealthEntry[];

/**
 * The models a capability probe already saw the harness offer.
 *
 * Model enumeration into the CATALOG is opt-in per kind (`probeModels`, on for
 * codex + claude-code) because the boot warmer would otherwise spawn a process
 * per installed harness. But the capability probe launches those same harnesses
 * anyway and reads the very same `session/new` model config option — so for a
 * native ACP kind like opencode the answer (76 models) was already sitting in
 * `capabilities.configOptions`, while the picker showed "Built-in model"
 * because the catalog was empty.
 *
 * So an empty catalog falls back to that evidence rather than to nothing. No
 * extra spawn, and nothing is fabricated: this only echoes `{value, name}`
 * pairs the harness itself offered. `currentValue` is what the harness says it
 * would use, which is exactly `default`.
 */
export function modelsFromCapabilities(
  capabilities: HarnessAcpCapabilities | undefined
): HarnessModel[] {
  const option = capabilities?.configOptions?.find(
    (entry) => entry.category === "model"
  );
  if (!option) return [];
  return option.values.map((value) => ({
    id: value.value,
    ...(value.name ? { name: value.name } : {}),
    ...(value.value === option.currentValue ? { default: true } : {}),
  }));
}

/**
 * ACP capability strip from a real `initialize` probe (optional; filled when
 * the host probes available harnesses — typically on `?refresh=1`).
 */
export interface HarnessAcpCapabilities {
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
  /** Human reason when the probe could not reach the harness. */
  reason?: string;
}

/** One registered harness kind's state on this gateway host. */
export interface HarnessStatusEntry {
  /**
   * The harness kind (`codex`, `claude-code`, `gemini`, …). Typed as the
   * gateway's `HarnessKind` here because the gateway only ever emits kinds it
   * has registered; clients parse it as an open string so a kind added by a
   * newer gateway still renders (docs/protocol.md C1a).
   */
  kind: HarnessKind;
  /** Human label for pickers and cards, from the harness spec. */
  label: string;
  /** The CLI is runnable on the gateway host (`<bin> --version` succeeded). */
  available: boolean;
  /** Trimmed `<bin> --version` output, when available. */
  version?: string;
  /** Minimum CLI version whose protocol we've verified, e.g. `"0.128.0"`. */
  minVersion: string;
  /** Install/setup hint — present only when the CLI is NOT available. */
  hint?: string;
  /** Models this harness can serve, from the catalog (issue #188). */
  models: HarnessModel[];
  /** Load state of `models` — lets the picker show loading vs empty. */
  modelsStatus: SurfaceStatus;
  /** The model this harness defaults to, when its catalog names one. */
  defaultModel?: string;
  /**
   * Live ACP capabilities (vault HTTP, session resume, model pin, auth).
   * Absent until the host has probed this kind at least once.
   */
  capabilities?: HarnessAcpCapabilities;
  /** Persisted, real-turn breaker state for this harness. */
  health?: HarnessHealthEntry[];
}

export interface HarnessesStatus {
  /** One entry per product-supported harness kind, in roster order. */
  harnesses: HarnessStatusEntry[];
}

/**
 * Probe the gateway host for runnable harness CLIs and — when a model
 * resolver is supplied — each harness's models, so Settings → Agents can offer a
 * per-harness model picker with a loading/empty state independent of which
 * harness is active.
 *
 * Only the intentionally offered v0 roster is probed. Registered-but-hidden
 * kinds remain runnable for persisted preferences.
 */
export async function readHarnessesStatus(opts?: {
  resolveModels?: ResolveHarnessModels;
  resolveCapabilities?: ResolveHarnessCapabilities;
  binPathFor?: BinPathForKind;
  resolveHealth?: ResolveHarnessHealth;
  refresh?: boolean;
}): Promise<HarnessesStatus> {
  const resolveModels = opts?.resolveModels;
  const resolveCapabilities = opts?.resolveCapabilities;
  const binPathFor = opts?.binPathFor;
  const refresh = opts?.refresh ?? false;
  const emptyModels: ResolvedSurface<HarnessModel> = {
    list: [],
    status: "empty",
  };

  const harnesses = await Promise.all(
    SUPPORTED_HARNESSES.map(async (harness): Promise<HarnessStatusEntry> => {
      const binPath = binPathFor?.(harness.kind);
      const [availability, models] = await Promise.all([
        probeCliAvailability(harness.kind, binPath, { refresh }),
        resolveModels
          ? resolveModels(harness.kind, refresh).catch(() => emptyModels)
          : Promise.resolve(emptyModels),
      ]);
      const capabilities =
        availability.available && resolveCapabilities
          ? await resolveCapabilities(harness.kind, refresh).catch(
              () => undefined
            )
          : undefined;
      // A kind outside the catalog's opt-in probe still gets its models from
      // the capability snapshot — see `modelsFromCapabilities`. `loading` is
      // left alone: a warm in flight may still be about to fill the catalog.
      const probed =
        models.status === "empty" && models.list.length === 0
          ? modelsFromCapabilities(capabilities)
          : [];
      const resolvedModels = probed.length > 0 ? probed : models.list;
      const modelsStatus =
        probed.length > 0 ? ("ready" as SurfaceStatus) : models.status;
      const defaultModel = resolvedModels.find((m) => m.default)?.id;
      const health = opts?.resolveHealth?.(harness.kind) ?? [];
      return {
        kind: harness.kind,
        label: harness.label,
        available: availability.available,
        ...(availability.version ? { version: availability.version } : {}),
        minVersion: minVersionString(harness.kind),
        // The hint is the "what do I do about it" half of an unavailable
        // harness; on an available one it would just be noise in the payload.
        ...(availability.available ? {} : { hint: harness.installHint }),
        models: resolvedModels,
        modelsStatus,
        ...(defaultModel ? { defaultModel } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(health.length > 0 ? { health } : {}),
      };
    })
  );

  return { harnesses };
}

/**
 * Build the harnesses route handler. Returns a function suitable for
 * `startRuntimeHttpServer`'s `extraHandlers`: resolves `true` when it owned the
 * request, `false` otherwise. `?refresh=1` invalidates availability and
 * re-enumerates each harness's models; otherwise the caches answer, with a
 * background model warm kicked when a surface is cold.
 */
export function makeHarnessesRouteHandler(opts?: {
  resolveModels?: ResolveHarnessModels;
  resolveCapabilities?: ResolveHarnessCapabilities;
  binPathFor?: BinPathForKind;
  resolveHealth?: ResolveHarnessHealth;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/centraid/_harnesses/status") return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") return false;

    const refresh = url.searchParams.get("refresh") === "1";
    sendJson(
      res,
      200,
      await readHarnessesStatus({
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
