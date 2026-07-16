// Opt-in idle-device queue runner (issue #414 D11). The gateway remains the
// authority for enrollment and TTL leases; this browser host proves current
// charging/network state, computes one bounded job, contributes derivatives,
// then completes (or releases) the token-bound lease.

import {
  computeDeviceWorkContributions,
  type DeviceWorkContribution,
} from './device-enrichment-compute.js';
import {
  finishGatewayDeviceWork,
  leaseGatewayDeviceWork,
  listGatewayDevices,
  readGatewayDeviceWorkSource,
  releaseGatewayDeviceWork,
  setGatewayDeviceCompute,
  stageGatewayDeviceWorkDerivative,
  type CentraidGatewayDevice,
  type DeviceEnrichmentLease,
} from './gateway-client-devices.js';

const POLL_INTERVAL_MS = 5 * 60 * 1_000;
const DRAIN_INTERVAL_MS = 1_000;
const INITIAL_DELAY_MS = 10_000;
// The host advertisement is authoritative: web filters transcript out, while
// desktop enables it only after its device-local file-ASR adapter answers.
const WORK_CAPABILITIES = ['poster', 'pdfText', 'transcript'] as const;

export interface DeviceWorkConditions {
  charging: boolean;
  unmetered: boolean;
}

export interface DeviceWorkSource {
  contentId: string;
  sha256: string;
  mediaType: string;
}

export interface DeviceWorkerApi {
  conditions(): Promise<DeviceWorkConditions>;
  devices(): Promise<CentraidGatewayDevice[]>;
  advertise(device: CentraidGatewayDevice): Promise<CentraidGatewayDevice>;
  lease(input: {
    vaultId: string;
    capabilities: DeviceEnrichmentLease['capability'][];
    charging: boolean;
    unmetered: boolean;
  }): Promise<DeviceEnrichmentLease | null>;
  read(vaultId: string, source: DeviceWorkSource): Promise<Blob>;
  compute(lease: DeviceEnrichmentLease, source: Blob): Promise<DeviceWorkContribution[]>;
  stage(vaultId: string, parentSha256: string, contribution: DeviceWorkContribution): Promise<void>;
  finish(vaultId: string, lease: DeviceEnrichmentLease): Promise<boolean>;
  release(vaultId: string, lease: DeviceEnrichmentLease): Promise<boolean>;
}

export type DeviceWorkerResult =
  | { status: 'completed'; requestId: string }
  | { status: 'idle' | 'ineligible' | 'disabled' }
  | { status: 'released'; requestId: string };

interface NavigatorPower extends Navigator {
  getBattery?: () => Promise<{ charging: boolean }>;
  connection?: { saveData?: boolean; type?: string };
}

export async function browserDeviceWorkConditions(): Promise<DeviceWorkConditions> {
  const browser = navigator as NavigatorPower;
  const battery = await browser.getBattery?.().catch(() => undefined);
  const connection = browser.connection;
  return {
    // Unknown power state is not consent to burn battery.
    charging: battery?.charging === true,
    // Chromium does not expose `type` on every desktop. A missing type is
    // accepted only when the user did not request data-saving; explicit
    // cellular/save-data signals always stop contribution.
    unmetered:
      navigator.onLine !== false &&
      connection?.saveData !== true &&
      connection?.type !== 'cellular',
  };
}

export function parseDeviceWorkSource(lease: DeviceEnrichmentLease): DeviceWorkSource | null {
  try {
    const value = JSON.parse(lease.detail ?? '') as Partial<DeviceWorkSource>;
    if (
      typeof value.contentId !== 'string' ||
      typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      typeof value.mediaType !== 'string' ||
      value.mediaType.length === 0
    ) {
      return null;
    }
    return { contentId: value.contentId, sha256: value.sha256, mediaType: value.mediaType };
  } catch {
    return null;
  }
}

const productionApi: DeviceWorkerApi = {
  conditions: browserDeviceWorkConditions,
  devices: listGatewayDevices,
  advertise: (device) => setGatewayDeviceCompute(device, true),
  lease: leaseGatewayDeviceWork,
  read: (vaultId, source) => readGatewayDeviceWorkSource({ vaultId, ...source }),
  compute: computeDeviceWorkContributions,
  stage: (vaultId, parentSha256, contribution) =>
    stageGatewayDeviceWorkDerivative({
      vaultId,
      parentSha256,
      variant: contribution.variant,
      body: contribution.body,
      mediaType: contribution.mediaType,
    }),
  finish: (vaultId, lease) =>
    finishGatewayDeviceWork({ vaultId, requestId: lease.requestId, token: lease.token }),
  release: (vaultId, lease) =>
    releaseGatewayDeviceWork({ vaultId, requestId: lease.requestId, token: lease.token }),
};

/** Run at most one job; the scheduler immediately re-enters after success. */
export async function runDeviceEnrichmentWorkerOnce(
  api: DeviceWorkerApi = productionApi,
): Promise<DeviceWorkerResult> {
  const conditions = await api.conditions();
  if (!conditions.charging || !conditions.unmetered) return { status: 'ineligible' };
  const optedIn = (await api.devices()).filter(
    (device) => device.current && device.compute?.contributeWhileCharging === true,
  );
  if (optedIn.length === 0) return { status: 'disabled' };

  for (const device of optedIn) {
    let lease: DeviceEnrichmentLease | null = null;
    try {
      // Refresh capability advertisement without changing the existing opt-in.
      const advertised = await api.advertise(device);
      const capabilities = WORK_CAPABILITIES.filter(
        (capability) => advertised.compute?.capabilities[capability] === true,
      );
      if (capabilities.length === 0) continue;
      lease = await api.lease({ vaultId: device.vaultId, capabilities, ...conditions });
      if (!lease) continue;
      const pointer = parseDeviceWorkSource(lease);
      if (!pointer) {
        await api.release(device.vaultId, lease);
        return { status: 'released', requestId: lease.requestId };
      }
      const source = await api.read(device.vaultId, pointer);
      const contributions = await api.compute(lease, source);
      const stillEligible = await api.conditions();
      if (!stillEligible.charging || !stillEligible.unmetered || contributions.length === 0) {
        await api.release(device.vaultId, lease);
        return { status: 'released', requestId: lease.requestId };
      }
      for (const contribution of contributions) {
        await api.stage(device.vaultId, pointer.sha256, contribution);
      }
      if (await api.finish(device.vaultId, lease)) {
        return { status: 'completed', requestId: lease.requestId };
      }
      return { status: 'released', requestId: lease.requestId };
    } catch {
      if (lease) await api.release(device.vaultId, lease).catch(() => false);
    }
  }
  return { status: 'idle' };
}

let installed = false;

/** Install the long-lived shell loop once; it never blocks renderer boot. */
export function installDeviceEnrichmentWorker(): () => void {
  if (installed) return () => undefined;
  installed = true;
  let stopped = false;
  let timer: number | undefined;
  const schedule = (delay: number): void => {
    if (stopped) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const run = (): void => {
        void runDeviceEnrichmentWorkerOnce()
          .then((result) =>
            schedule(result.status === 'completed' ? DRAIN_INTERVAL_MS : POLL_INTERVAL_MS),
          )
          .catch(() => schedule(POLL_INTERVAL_MS));
      };
      if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 10_000 });
      else run();
    }, delay);
  };
  const wake = (): void => schedule(DRAIN_INTERVAL_MS);
  window.addEventListener('online', wake);
  const offGateway = window.CentraidApi.onGatewayChanged(wake);
  const offVault = window.CentraidApi.onVaultChanged?.(wake);
  schedule(INITIAL_DELAY_MS);
  return () => {
    stopped = true;
    installed = false;
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener('online', wake);
    offGateway();
    offVault?.();
  };
}
