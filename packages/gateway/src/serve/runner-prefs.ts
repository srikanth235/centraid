import {
  isRunnerKind,
  resolveSubsystemRunner,
  type ModelSubsystem,
  type RunnerKind,
  type RunnerPrefs,
} from '@centraid/app-engine';

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
  };
}
