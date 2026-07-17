// Share-target ingest routing and lifecycle. The hook wires real producers and
// Expo modules; the core is exercised here with fakes (the M0 injection rig),
// so no React renderer or native module is loaded.

import { describe, expect, it, vi } from 'vitest';

import type { NativeReplicaSession } from '../../lib/replica/native-session';
import {
  ShareIntentGate,
  processShareIntent,
  type ShareIngestPorts,
  type SharedIntentFileLike,
} from './share-ingest';

const session = {} as NativeReplicaSession;
const GATEWAY = 'http://127.0.0.1:8787';

function fakePorts(overrides: Partial<ShareIngestPorts> = {}): ShareIngestPorts {
  return {
    backupDeviceMedia: vi.fn(async () => 'sha-media'),
    backupDocument: vi.fn(async () => 'sha-doc'),
    fileSize: vi.fn(() => 1234),
    reset: vi.fn(),
    alert: vi.fn(),
    ...overrides,
  };
}

function file(
  overrides: Partial<SharedIntentFileLike> & { mimeType: string },
): SharedIntentFileLike {
  return { path: 'file:///share/x', fileName: 'x', size: 10, ...overrides };
}

describe('processShareIntent routing', () => {
  it('routes images and videos to the media producer with the right kind', async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [
        file({ mimeType: 'image/jpeg', fileName: 'p.jpg', width: 4, height: 3 }),
        file({ mimeType: 'video/mp4', fileName: 'v.mp4', duration: 12 }),
      ],
    });
    expect(ports.backupDeviceMedia).toHaveBeenCalledTimes(2);
    expect(ports.backupDocument).not.toHaveBeenCalled();
    expect(ports.backupDeviceMedia).toHaveBeenNthCalledWith(
      1,
      session,
      GATEWAY,
      expect.objectContaining({
        kind: 'photo',
        width: 4,
        height: 3,
        deleteSourceAfterSettle: true,
      }),
    );
    expect(ports.backupDeviceMedia).toHaveBeenNthCalledWith(
      2,
      session,
      GATEWAY,
      expect.objectContaining({ kind: 'video', durationS: 12, deleteSourceAfterSettle: true }),
    );
  });

  it('routes shared audio through the media producer as kind audio (F14e)', async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: 'audio/mpeg', fileName: 'song.mp3' })],
    });
    expect(ports.backupDeviceMedia).toHaveBeenCalledWith(
      session,
      GATEWAY,
      expect.objectContaining({ kind: 'audio', deleteSourceAfterSettle: true }),
    );
    expect(ports.backupDocument).not.toHaveBeenCalled();
  });

  it('routes documents to the docs producer', async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: 'application/pdf', fileName: 'doc.pdf' })],
    });
    expect(ports.backupDocument).toHaveBeenCalledWith(
      session,
      GATEWAY,
      expect.objectContaining({
        title: 'doc.pdf',
        mediaType: 'application/pdf',
        deleteSourceAfterSettle: true,
      }),
    );
    expect(ports.backupDeviceMedia).not.toHaveBeenCalled();
  });

  it('falls back to fileSize when the intent carries no size', async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: 'application/pdf', size: null })],
    });
    expect(ports.fileSize).toHaveBeenCalledWith('file:///share/x');
    expect(ports.backupDocument).toHaveBeenCalledWith(
      session,
      GATEWAY,
      expect.objectContaining({ plaintextSize: 1234 }),
    );
  });
});

describe('processShareIntent lifecycle', () => {
  it('alerts honestly and resets on an unsupported (text) share, touching no producer', async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, { files: [], text: 'hello' });
    expect(ports.backupDeviceMedia).not.toHaveBeenCalled();
    expect(ports.backupDocument).not.toHaveBeenCalled();
    expect(ports.alert).toHaveBeenCalledTimes(1);
    expect(ports.alert).toHaveBeenCalledWith('Can’t save this to Centraid', expect.any(String));
    expect(ports.reset).toHaveBeenCalledTimes(1);
  });

  it('always resets — on success', async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: 'image/png' })],
    });
    expect(ports.reset).toHaveBeenCalledTimes(1);
  });

  it('always resets — and surfaces a paused alert on producer failure', async () => {
    const ports = fakePorts({
      backupDeviceMedia: vi.fn(async () => {
        throw new Error('gateway unreachable');
      }),
    });
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: 'image/png' })],
    });
    expect(ports.alert).toHaveBeenCalledWith('Save to Centraid paused', 'gateway unreachable');
    expect(ports.reset).toHaveBeenCalledTimes(1);
  });
});

describe('ShareIntentGate', () => {
  it('does not double-ingest while a pass is still in flight', async () => {
    const gate = new ShareIntentGate();
    let started = 0;
    let release!: () => void;
    const task = () => {
      started += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = gate.run(task);
    const second = gate.run(task); // in flight → must no-op
    release();
    await Promise.all([first, second]);
    expect(started).toBe(1);
  });

  it('runs again once the previous pass settled', async () => {
    const gate = new ShareIntentGate();
    const task = vi.fn(async () => {});
    await gate.run(task);
    await gate.run(task);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
