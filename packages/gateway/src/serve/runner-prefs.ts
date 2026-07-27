import {
  isRunnerKind,
  resolveSubsystemConfigPins,
  resolveSubsystemRunner,
  resolveSubsystemRunnerLadder,
  type ModelSubsystem,
  type RunnerKind,
  type RunnerPrefs,
} from '@centraid/app-engine';

const RUNNER_SUBSYSTEMS: readonly ModelSubsystem[] = ['assistant', 'ask', 'builder', 'automations'];

/**
 * Resolve gateway launch prefs for one turn. `binPath`/`extraArgs` are one
 * configured runner's settings, not portable flags; a different requested
 * runner must use its registry defaults.
 */
export function resolveGatewayRunnerPrefs(
  allPrefs: Record<string, unknown>,
  subsystem?: ModelSubsystem,
  requestedRunner?: RunnerKind,
): RunnerPrefs {
  const kindRaw =
    requestedRunner ??
    (subsystem ? resolveSubsystemRunner(allPrefs, subsystem) : allPrefs['agent.runner.kind']);
  const kind: RunnerKind = isRunnerKind(kindRaw) ? kindRaw : 'codex';
  const configuredKind: RunnerKind = isRunnerKind(allPrefs['agent.runner.kind'])
    ? allPrefs['agent.runner.kind']
    : 'codex';
  const useConfiguredLaunch = kind === configuredKind;
  const binPath =
    useConfiguredLaunch && typeof allPrefs['agent.runner.binPath'] === 'string'
      ? allPrefs['agent.runner.binPath']
      : undefined;
  const extraArgsRaw = allPrefs['agent.runner.extraArgs'];
  const extraArgs =
    useConfiguredLaunch && Array.isArray(extraArgsRaw)
      ? extraArgsRaw.filter((value): value is string => typeof value === 'string')
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
 * Return every fallback membership removed by a Settings patch. Membership is
 * subsystem-scoped: retaining a runner in one ladder must not preserve consent
 * derived from a different ladder.
 */
export function removedRunnerLadderMembers(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Array<{ subsystem: ModelSubsystem; kind: RunnerKind }> {
  const members = (
    snapshot: Record<string, unknown>,
    subsystem: ModelSubsystem,
  ): Set<RunnerKind> => {
    const primary = resolveGatewayRunnerPrefs(snapshot, subsystem).kind;
    return new Set(resolveSubsystemRunnerLadder(snapshot, subsystem, primary).slice(1));
  };
  const removed: Array<{ subsystem: ModelSubsystem; kind: RunnerKind }> = [];
  for (const subsystem of RUNNER_SUBSYSTEMS) {
    const afterMembers = members(after, subsystem);
    for (const kind of members(before, subsystem)) {
      if (!afterMembers.has(kind)) removed.push({ subsystem, kind });
    }
  }
  return removed;
}
