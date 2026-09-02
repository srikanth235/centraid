import {
  isHarnessKind,
  resolveSubsystemConfigPins,
  resolveSubsystemHarness,
  resolveSubsystemHarnessLadder,
} from "@centraid/server/engine";
import type {
  ModelSubsystem,
  HarnessKind,
  HarnessPrefs,
} from "@centraid/server/engine";

const HARNESS_SUBSYSTEMS: readonly ModelSubsystem[] = [
  "assistant",
  "ask",
  "builder",
  "automations",
];

/**
 * `binPath`/`extraArgs` are one configured harness's settings, not portable
 * flags — a different requested harness must use its registry defaults.
 */
export function resolveGatewayHarnessPrefs(
  allPrefs: Record<string, unknown>,
  subsystem?: ModelSubsystem,
  requestedHarness?: HarnessKind
): HarnessPrefs {
  const kindRaw =
    requestedHarness ??
    (subsystem
      ? resolveSubsystemHarness(allPrefs, subsystem)
      : allPrefs["harness.kind"]);
  const kind: HarnessKind = isHarnessKind(kindRaw) ? kindRaw : "codex";
  const configuredKind: HarnessKind = isHarnessKind(allPrefs["harness.kind"])
    ? allPrefs["harness.kind"]
    : "codex";
  const useConfiguredLaunch = kind === configuredKind;
  const binPath =
    useConfiguredLaunch && typeof allPrefs["harness.binPath"] === "string"
      ? allPrefs["harness.binPath"]
      : undefined;
  const extraArgsRaw = allPrefs["harness.extraArgs"];
  const extraArgs =
    useConfiguredLaunch && Array.isArray(extraArgsRaw)
      ? extraArgsRaw.filter(
          (value): value is string => typeof value === "string"
        )
      : undefined;
  return {
    kind,
    ...(binPath ? { binPath } : {}),
    ...(extraArgs ? { extraArgs } : {}),
    ...(subsystem
      ? {
          configPins: resolveSubsystemConfigPins(allPrefs, kind, subsystem),
        }
      : {}),
  };
}

/**
 * Reject a harness this host cannot execute instead of coercing: the Settings
 * patch path must not silently persist an unregistered `harness.<subsystem>`
 * value as `codex` (the lenient variant deliberately degrades so a live turn
 * always has a harness).
 */
export function resolveStrictGatewayHarnessPrefs(
  allPrefs: Record<string, unknown>,
  subsystem?: ModelSubsystem
): HarnessPrefs | undefined {
  const kindRaw = subsystem
    ? resolveSubsystemHarness(allPrefs, subsystem)
    : allPrefs["harness.kind"];
  // Unset is legitimate — it means the default harness.
  if (kindRaw !== undefined && kindRaw !== null && !isHarnessKind(kindRaw))
    return undefined;
  return resolveGatewayHarnessPrefs(allPrefs, subsystem);
}

/**
 * Membership is subsystem-scoped: retaining a harness in one ladder must not
 * preserve consent derived from a different ladder.
 */
export function removedHarnessLadderMembers(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Array<{ subsystem: ModelSubsystem; kind: HarnessKind }> {
  const members = (
    snapshot: Record<string, unknown>,
    subsystem: ModelSubsystem
  ): Set<HarnessKind> => {
    const primary = resolveGatewayHarnessPrefs(snapshot, subsystem).kind;
    return new Set(
      resolveSubsystemHarnessLadder(snapshot, subsystem, primary).slice(1)
    );
  };
  const removed: Array<{ subsystem: ModelSubsystem; kind: HarnessKind }> = [];
  for (const subsystem of HARNESS_SUBSYSTEMS) {
    const afterMembers = members(after, subsystem);
    for (const kind of members(before, subsystem)) {
      if (!afterMembers.has(kind)) removed.push({ subsystem, kind });
    }
  }
  return removed;
}
