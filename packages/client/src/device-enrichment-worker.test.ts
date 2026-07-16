import { expect, test, vi } from 'vitest';
import type { DeviceWorkContribution } from './device-enrichment-compute.js';
import { computeDeviceWorkContributions } from './device-enrichment-compute.js';
import { runDeviceEnrichmentWorkerOnce, type DeviceWorkerApi } from './device-enrichment-worker.js';
import type { CentraidGatewayDevice, DeviceEnrichmentLease } from './gateway-client-devices.js';

vi.mock('./gateway-client-devices.js', () => ({
  finishGatewayDeviceWork: vi.fn(),
  leaseGatewayDeviceWork: vi.fn(),
  listGatewayDevices: vi.fn(),
  readGatewayDeviceWorkSource: vi.fn(),
  releaseGatewayDeviceWork: vi.fn(),
  setGatewayDeviceCompute: vi.fn(),
  stageGatewayDeviceWorkDerivative: vi.fn(),
}));

const SHA = 'a'.repeat(64);

function device(optedIn = true, transcript = false): CentraidGatewayDevice {
  return {
    deviceId: 'enrollment-1',
    endpointId: 'http:laptop',
    label: 'Laptop',
    transport: 'http',
    vaultId: 'vault-1',
    current: true,
    trust: 'full',
    rememberDevice: true,
    compute: {
      contributeWhileCharging: optedIn,
      updatedAt: '2026-07-15T00:00:00.000Z',
      capabilities: {
        previews: true,
        poster: true,
        pdfText: true,
        ocr: false,
        embedding: false,
        transcript,
        edgeSeal: true,
        backgroundTransfer: false,
      },
    },
  };
}

const lease: DeviceEnrichmentLease = {
  requestId: 'poster-job',
  entityType: 'core.content_item',
  entityId: 'content-1',
  reason: 'manual',
  detail: JSON.stringify({ contentId: 'content-1', sha256: SHA, mediaType: 'video/mp4' }),
  capability: 'poster',
  contributionVariant: 'poster',
  deviceId: 'http:laptop',
  token: 'lease-token',
  expiresAt: '2026-07-15T00:10:00.000Z',
  attempt: 1,
};

function workerApi(overrides: Partial<DeviceWorkerApi> = {}): DeviceWorkerApi {
  const contribution: DeviceWorkContribution = {
    variant: 'poster',
    body: new Blob(['jpeg'], { type: 'image/jpeg' }),
    mediaType: 'image/jpeg',
  };
  return {
    conditions: vi.fn().mockResolvedValue({ charging: true, unmetered: true }),
    devices: vi.fn().mockResolvedValue([device()]),
    advertise: vi.fn().mockResolvedValue(device()),
    lease: vi.fn().mockResolvedValue(lease),
    read: vi.fn().mockResolvedValue(new Blob(['video'], { type: 'video/mp4' })),
    compute: vi.fn().mockResolvedValue([contribution]),
    stage: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

test('opted-in charging and unmetered client leases, contributes, then completes', async () => {
  const api = workerApi();
  await expect(runDeviceEnrichmentWorkerOnce(api)).resolves.toEqual({
    status: 'completed',
    requestId: 'poster-job',
  });
  expect(api.advertise).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'enrollment-1' }));
  expect(api.lease).toHaveBeenCalledWith({
    vaultId: 'vault-1',
    capabilities: ['poster', 'pdfText'],
    charging: true,
    unmetered: true,
  });
  expect(api.read).toHaveBeenCalledWith('vault-1', {
    contentId: 'content-1',
    sha256: SHA,
    mediaType: 'video/mp4',
  });
  expect(api.stage).toHaveBeenCalledWith(
    'vault-1',
    SHA,
    expect.objectContaining({ variant: 'poster', mediaType: 'image/jpeg' }),
  );
  expect(api.finish).toHaveBeenCalledWith('vault-1', lease);
  expect(api.release).not.toHaveBeenCalled();
});

test('battery/network and standing opt-in gates run before a lease', async () => {
  const ineligible = workerApi({
    conditions: vi.fn().mockResolvedValue({ charging: true, unmetered: false }),
  });
  await expect(runDeviceEnrichmentWorkerOnce(ineligible)).resolves.toEqual({
    status: 'ineligible',
  });
  expect(ineligible.devices).not.toHaveBeenCalled();

  const disabled = workerApi({ devices: vi.fn().mockResolvedValue([device(false)]) });
  await expect(runDeviceEnrichmentWorkerOnce(disabled)).resolves.toEqual({ status: 'disabled' });
  expect(disabled.lease).not.toHaveBeenCalled();
});

test('eligibility loss after compute releases the TTL lease without submitting', async () => {
  const conditions = vi
    .fn()
    .mockResolvedValueOnce({ charging: true, unmetered: true })
    .mockResolvedValueOnce({ charging: false, unmetered: true });
  const api = workerApi({ conditions });
  await expect(runDeviceEnrichmentWorkerOnce(api)).resolves.toEqual({
    status: 'released',
    requestId: 'poster-job',
  });
  expect(api.stage).not.toHaveBeenCalled();
  expect(api.finish).not.toHaveBeenCalled();
  expect(api.release).toHaveBeenCalledWith('vault-1', lease);
});

test('desktop file-ASR adapter turns an existing media Blob into a transcript contribution', async () => {
  const original = window.CentraidApi;
  window.CentraidApi = {
    transcribeMedia: vi.fn().mockResolvedValue('adapter-backed starlight transcript'),
  } as unknown as typeof window.CentraidApi;
  const transcriptLease: DeviceEnrichmentLease = {
    ...lease,
    requestId: 'transcript-job',
    capability: 'transcript',
    contributionVariant: 'transcript',
    detail: JSON.stringify({ contentId: 'content-1', sha256: SHA, mediaType: 'audio/wav' }),
  };
  try {
    const contributions = await computeDeviceWorkContributions(
      transcriptLease,
      new Blob(['RIFF-voice'], { type: 'audio/wav' }),
    );
    expect(window.CentraidApi.transcribeMedia).toHaveBeenCalledOnce();
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      variant: 'transcript',
      mediaType: 'text/plain',
    });
    expect(contributions[0]!.body.size).toBe(
      new TextEncoder().encode('adapter-backed starlight transcript').byteLength,
    );
  } finally {
    window.CentraidApi = original;
  }
});

test('transcript-capable desktop leases, computes, stages, and completes the job', async () => {
  const original = window.CentraidApi;
  window.CentraidApi = {
    transcribeMedia: vi.fn().mockResolvedValue('worker starlight transcript'),
  } as unknown as typeof window.CentraidApi;
  const transcriptDevice = device(true, true);
  const transcriptLease: DeviceEnrichmentLease = {
    ...lease,
    requestId: 'transcript-job',
    capability: 'transcript',
    contributionVariant: 'transcript',
    detail: JSON.stringify({ contentId: 'content-1', sha256: SHA, mediaType: 'audio/wav' }),
  };
  const api = workerApi({
    devices: vi.fn().mockResolvedValue([transcriptDevice]),
    advertise: vi.fn().mockResolvedValue(transcriptDevice),
    lease: vi.fn().mockResolvedValue(transcriptLease),
    read: vi.fn().mockResolvedValue(new Blob(['RIFF-voice'], { type: 'audio/wav' })),
    compute: computeDeviceWorkContributions,
  });
  try {
    await expect(runDeviceEnrichmentWorkerOnce(api)).resolves.toEqual({
      status: 'completed',
      requestId: 'transcript-job',
    });
    expect(api.lease).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['poster', 'pdfText', 'transcript'] }),
    );
    expect(api.stage).toHaveBeenCalledWith(
      'vault-1',
      SHA,
      expect.objectContaining({ variant: 'transcript', mediaType: 'text/plain' }),
    );
    expect(api.finish).toHaveBeenCalledWith('vault-1', transcriptLease);
  } finally {
    window.CentraidApi = original;
  }
});
