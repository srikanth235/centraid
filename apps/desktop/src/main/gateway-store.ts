/*
 * Desktop connection registry (issue #555).
 *
 * Electron main owns one `<userData>/connections.json`; it never scans or
 * creates a directory per connection. Remote gateways are keyed by their
 * stable iroh EndpointId. Relay hints are refreshable address cache, not
 * identity, and device secrets live separately behind safeStorage.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { connectionsFile, LOCAL_GATEWAY_ID } from './gateway-paths.js';
import { clearGatewayCredentials } from './gateway-secrets.js';
import {
  defaultAvatarColor,
  isValidAvatarColor,
  isValidGatewayId,
  normalizeProfile,
  sortGatewayProfiles,
  validateAddGatewayFields,
  type GatewayProfileShape,
} from './gateway-store-core.js';
import { ensureIrohProxy } from './iroh-dialer.js';

export { defaultAvatarColor } from './gateway-store-core.js';

export type GatewayProfile = GatewayProfileShape;

export interface ResolvedGateway {
  readonly profile: GatewayProfile;
  /** Loopback URL: embedded server for local, iroh proxy for remote. */
  readonly url: string;
  /** Temporary local loopback bearer; remote iroh connections use no bearer. */
  readonly token: string;
}

class GatewayError extends Error {
  constructor(
    public readonly code:
      | 'unknown_gateway'
      | 'local_not_removable'
      | 'invalid_input'
      | 'already_exists',
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

let localGatewayInfo: (gatewayId: string) => { url: string; token: string } | undefined = () =>
  undefined;

export function setLocalGatewayInfoProvider(
  fn: (gatewayId: string) => { url: string; token: string } | undefined,
): void {
  localGatewayInfo = fn;
}

const DEFAULT_LOCAL_LABEL = 'Local';

async function readProfiles(): Promise<GatewayProfile[]> {
  let raw: string;
  try {
    raw = await fs.readFile(connectionsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new GatewayError('invalid_input', 'connections.json must contain an array.');
  }
  return parsed.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string') return [];
    const profile = normalizeProfile(id, row as Partial<GatewayProfile>);
    return profile ? [profile] : [];
  });
}

async function writeProfiles(profiles: readonly GatewayProfile[]): Promise<void> {
  const file = connectionsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(profiles, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readProfile(id: string): Promise<GatewayProfile | undefined> {
  return (await readProfiles()).find((profile) => profile.id === id);
}

async function replaceProfile(profile: GatewayProfile): Promise<void> {
  const profiles = await readProfiles();
  const index = profiles.findIndex((row) => row.id === profile.id);
  if (index < 0) profiles.push(profile);
  else profiles[index] = profile;
  await writeProfiles(profiles);
}

export async function ensureLocalGateway(): Promise<GatewayProfile> {
  const existing = await readProfile(LOCAL_GATEWAY_ID);
  if (existing) return existing;
  const profile: GatewayProfile = {
    id: LOCAL_GATEWAY_ID,
    kind: 'local',
    label: DEFAULT_LOCAL_LABEL,
    createdAt: new Date().toISOString(),
  };
  await replaceProfile(profile);
  return normalizeProfile(LOCAL_GATEWAY_ID, profile) as GatewayProfile;
}

export async function listGateways(): Promise<GatewayProfile[]> {
  await ensureLocalGateway();
  return sortGatewayProfiles(await readProfiles(), LOCAL_GATEWAY_ID);
}

export interface AddGatewayInput {
  label: string;
  endpointId: string;
  /** Current relay cache from the one-time pairing ticket. */
  relayHint?: string;
  displayName?: string;
  avatarColor?: string;
  rememberDevice?: boolean;
}

export async function addGateway(input: AddGatewayInput): Promise<GatewayProfile> {
  const fields = validateAddGatewayFields(input);
  if (!fields.ok) throw new GatewayError(fields.code, fields.message);
  const { endpointId, label, relayHint, displayName } = fields;
  if (await readProfile(endpointId)) {
    throw new GatewayError('already_exists', `Gateway "${endpointId}" already exists.`);
  }
  const profile: GatewayProfile = {
    id: endpointId,
    kind: 'remote',
    label,
    displayName,
    avatarColor: isValidAvatarColor(input.avatarColor)
      ? input.avatarColor
      : defaultAvatarColor(endpointId),
    endpointId,
    ...(relayHint ? { relayHint } : {}),
    rememberDevice: input.rememberDevice === true,
    createdAt: new Date().toISOString(),
  };
  await replaceProfile(profile);
  return profile;
}

export async function updateGatewayRememberDevice(
  id: string,
  rememberDevice: boolean,
): Promise<GatewayProfile> {
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `Unknown gateway "${id}".`);
  const next = { ...current, rememberDevice };
  await replaceProfile(next);
  return next;
}

/** Refresh address cache without changing a gateway's identity. */
export async function updateGatewayRelayHint(
  id: string,
  relayHint: string | undefined,
): Promise<GatewayProfile> {
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `Unknown gateway "${id}".`);
  const { relayHint: _old, ...rest } = current;
  const next: GatewayProfile = relayHint ? { ...rest, relayHint } : rest;
  await replaceProfile(next);
  return next;
}

export async function updateProfileMetadata(
  id: string,
  patch: { displayName?: string; avatarColor?: string },
): Promise<GatewayProfile> {
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  const next: GatewayProfile = { ...current };
  if (patch.displayName !== undefined) {
    const displayName = patch.displayName.trim() || current.label;
    (next as { displayName: string }).displayName = displayName;
  }
  if (patch.avatarColor !== undefined) {
    if (!isValidAvatarColor(patch.avatarColor)) {
      throw new GatewayError(
        'invalid_input',
        `Avatar color "${patch.avatarColor}" must match #RRGGBB.`,
      );
    }
    (next as { avatarColor: string }).avatarColor = patch.avatarColor;
  }
  await replaceProfile(next);
  return next;
}

export async function removeGateway(id: string): Promise<void> {
  if (id === LOCAL_GATEWAY_ID) {
    throw new GatewayError('local_not_removable', 'The default local profile cannot be removed.');
  }
  if (!isValidGatewayId(id)) {
    throw new GatewayError('invalid_input', `Invalid gateway id "${id}".`);
  }
  const profiles = await readProfiles();
  if (!profiles.some((profile) => profile.id === id)) {
    throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  }
  const { closeIrohDialer } = await import('./iroh-dialer.js');
  await closeIrohDialer(id);
  clearGatewayCredentials(id);
  await writeProfiles(profiles.filter((profile) => profile.id !== id));
}

export async function renameGateway(id: string, nextLabel: string): Promise<GatewayProfile> {
  const label = nextLabel.trim();
  if (!label) throw new GatewayError('invalid_input', 'Gateway label cannot be empty.');
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  const next: GatewayProfile = { ...current, label };
  await replaceProfile(next);
  return next;
}

export async function updateGatewaySsh(
  id: string,
  ssh: { destination: string; dataDir?: string; remoteCli?: string } | undefined,
): Promise<GatewayProfile> {
  const current = await readProfile(id);
  if (!current) throw new GatewayError('unknown_gateway', `No such gateway: ${id}`);
  if (id === LOCAL_GATEWAY_ID) return current;
  const { ssh: _old, ...rest } = current;
  const next: GatewayProfile = ssh ? { ...rest, ssh } : rest;
  await replaceProfile(next);
  return next;
}

export async function resolveGateway(id: string): Promise<ResolvedGateway | undefined> {
  const profile = await readProfile(id);
  if (!profile) return undefined;
  if (profile.kind === 'local') {
    const info = localGatewayInfo(profile.id);
    return { profile, url: info?.url ?? '', token: info?.token ?? '' };
  }
  if (!profile.endpointId) return { profile, url: '', token: '' };
  try {
    const url = await ensureIrohProxy(profile.id, profile.endpointId, profile.relayHint);
    return { profile, url, token: '' };
  } catch {
    return { profile, url: '', token: '' };
  }
}

export { GatewayError };
