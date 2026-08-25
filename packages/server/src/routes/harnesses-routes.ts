// GET /centraid/_harnesses/status. Detection runs on the GATEWAY host, not the
// desktop: it asks only whether each CLI is runnable there. The response covers
// `SUPPORTED_HARNESSES`; the registry stays broader so non-roster pins resolve.

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

export interface ResolvedSurface<T> {
  list: T[];
  status: SurfaceStatus;
}

/** `refresh` or a cold cache kicks the warmer; degrades to an empty surface. */
export type ResolveHarnessModels = (
  kind: HarnessKind,
  refresh: boolean
) => Promise<ResolvedSurface<HarnessModel>>;

/** Only the custom `acp` kind NEEDS one — it ships no default binary. */
export type BinPathForKind = (kind: HarnessKind) => string | undefined;

export type ResolveHarnessCapabilities = (
  kind: HarnessKind,
  refresh: boolean
) => Promise<HarnessAcpCapabilities | undefined>;

export type ResolveHarnessHealth = (kind: HarnessKind) => HarnessHealthEntry[];

/**
 * Catalog enumeration is opt-in per kind (else one spawn per harness), so a
 * kind's models can be absent there yet present in `capabilities.configOptions`.
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
  reason?: string;
}

export interface HarnessStatusEntry {
  /** Gateway-typed; clients parse it as an open string (docs/protocol.md C1a). */
  kind: HarnessKind;
  label: string;
  available: boolean;
  version?: string;
  minVersion: string;
  hint?: string;
  models: HarnessModel[];
  modelsStatus: SurfaceStatus;
  defaultModel?: string;
  capabilities?: HarnessAcpCapabilities;
  health?: HarnessHealthEntry[];
}

export interface HarnessesStatus {
  harnesses: HarnessStatusEntry[];
}

/** Only the offered v0 roster is probed; hidden kinds stay runnable. */
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
      // `loading` is left alone: a warm in flight may still fill the catalog.
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
