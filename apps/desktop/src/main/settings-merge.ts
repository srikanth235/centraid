import { clampAlertSeconds } from "./gateway-monitor-core.js";
import type { PersistedSettings } from "./settings.js";

export interface PersistedSettingsPatch {
  activeGatewayId?: string;
  activeVaultByGateway?: Record<string, string>;
  onboardingCompletedAt?: string;
  gatewayAlertSeconds?: number;
  gatewayAlertsEnabled?: boolean;
  changelogSeenVersion?: string;
  launchAtLogin?: boolean;
  offerGatewayService?: boolean;
}

function preserveOrSet<K extends string>(
  key: K,
  patched: string | undefined,
  currentValue: string | undefined
): Record<K, string> | Record<string, never> {
  if (patched !== undefined) return { [key]: patched } as Record<K, string>;
  if (currentValue !== undefined)
    return { [key]: currentValue } as Record<K, string>;
  return {};
}

export function mergePersistedSettings(
  current: PersistedSettings,
  patch: PersistedSettingsPatch
): PersistedSettings {
  const activeVaultByGateway =
    patch.activeVaultByGateway ?? current.activeVaultByGateway;
  return {
    activeGatewayId: patch.activeGatewayId?.trim() || current.activeGatewayId,
    ...(activeVaultByGateway !== undefined &&
    Object.keys(activeVaultByGateway).length
      ? { activeVaultByGateway }
      : {}),
    ...preserveOrSet(
      "onboardingCompletedAt",
      patch.onboardingCompletedAt,
      current.onboardingCompletedAt
    ),
    ...(() => {
      const next =
        clampAlertSeconds(patch.gatewayAlertSeconds) ??
        current.gatewayAlertSeconds;
      return next === undefined ? {} : { gatewayAlertSeconds: next };
    })(),
    ...(patch.gatewayAlertsEnabled === undefined
      ? current.gatewayAlertsEnabled === undefined
        ? {}
        : { gatewayAlertsEnabled: current.gatewayAlertsEnabled }
      : { gatewayAlertsEnabled: patch.gatewayAlertsEnabled }),
    ...preserveOrSet(
      "changelogSeenVersion",
      patch.changelogSeenVersion,
      current.changelogSeenVersion
    ),
    ...(patch.launchAtLogin === undefined
      ? current.launchAtLogin === undefined
        ? {}
        : { launchAtLogin: current.launchAtLogin }
      : { launchAtLogin: patch.launchAtLogin }),
    ...(patch.offerGatewayService === undefined
      ? current.offerGatewayService === undefined
        ? {}
        : { offerGatewayService: current.offerGatewayService }
      : { offerGatewayService: patch.offerGatewayService }),
  };
}
