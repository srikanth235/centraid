/*
 * Device-key allowlist for the phone tunnel (issue #263).
 *
 * Replaces bearer-token pairing at the transport: a device is authorized by
 * its iroh EndpointId (ed25519 public key), named, and revocable. Persisted
 * as a small JSON file (mode 0600, atomic rename on write) — the same v0
 * on-disk posture (mode 0600, atomic replace) the gateway uses for its other
 * small control files (e.g. `devices.json`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PairedDevice {
  deviceId: string;
  name: string;
  platform: string;
  /** Base32 iroh EndpointId — the device's transport identity. */
  endpointId: string;
  addedAt: string;
}

interface DeviceFile {
  version: 1;
  devices: PairedDevice[];
}

const MAX_NAME_LENGTH = 64;

export function sanitizeDeviceName(raw: string): string {
  // Names come off the wire from an unpaired device - strip control
  // characters (C0 + DEL) before they reach any UI surface.
  const stripped = Array.from(raw)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
  const clipped = stripped.trim().slice(0, MAX_NAME_LENGTH).trim();
  return clipped.length > 0 ? clipped : 'Phone';
}

export class DeviceStore {
  private devices: PairedDevice[];

  private constructor(
    private readonly file: string,
    devices: PairedDevice[],
  ) {
    this.devices = devices;
  }

  static open(file: string): DeviceStore {
    let devices: PairedDevice[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeviceFile>;
      if (parsed.version === 1 && Array.isArray(parsed.devices)) {
        devices = parsed.devices.filter(
          (d): d is PairedDevice =>
            typeof d?.deviceId === 'string' &&
            typeof d?.endpointId === 'string' &&
            typeof d?.name === 'string',
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return new DeviceStore(file, devices);
  }

  list(): PairedDevice[] {
    return this.devices.map((d) => ({ ...d }));
  }

  findByEndpointId(endpointId: string): PairedDevice | undefined {
    const found = this.devices.find((d) => d.endpointId === endpointId);
    return found ? { ...found } : undefined;
  }

  /**
   * Add a device. Re-pairing the same endpoint (e.g. after a reinstall that
   * kept the key) replaces the prior entry rather than duplicating it.
   */
  add(input: { name: string; platform: string; endpointId: string }): PairedDevice {
    const device: PairedDevice = {
      deviceId: crypto.randomUUID(),
      name: sanitizeDeviceName(input.name),
      platform: input.platform.slice(0, 32),
      endpointId: input.endpointId,
      addedAt: new Date().toISOString(),
    };
    this.devices = [...this.devices.filter((d) => d.endpointId !== input.endpointId), device];
    this.persist();
    return { ...device };
  }

  /** Remove by deviceId. Returns the removed device, if any. */
  remove(deviceId: string): PairedDevice | undefined {
    const removed = this.devices.find((d) => d.deviceId === deviceId);
    if (!removed) return undefined;
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    this.persist();
    return { ...removed };
  }

  private persist(): void {
    const payload: DeviceFile = { version: 1, devices: this.devices };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
