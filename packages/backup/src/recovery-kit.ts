/*
 * The recovery-kit READER (issue #439 R1) — the counterpart to
 * `writeRecoveryKit` (engine.ts). `writeRecoveryKit` emits
 * `{version, kind, createdAt, keyring, targets}` (FORMAT.md § Recovery kit);
 * this parses + validates that document back into a typed shape so `recover()`
 * can restore "from nothing but this document". It is deliberately strict:
 * the kit is the ONLY thing standing between a blank machine and a vault, so a
 * wrong `kind`, an unsupported `version`, a malformed keyring, or a target
 * missing its addressing is rejected here rather than surfacing as an opaque
 * provider error three phases later.
 *
 * What the kit does NOT carry, by design (FORMAT.md): the provider API key. The
 * `target.provider` field is the provider's base URL (for a remote home) or a
 * `local:<dir>` moniker (an operator/test local provider) — enough to reach the
 * provider, but never the credential to authenticate. The recovering operator
 * supplies the key out-of-band (the invite email at beta; the provisioning
 * handshake at GA).
 */

import { validateKeyring, type Keyring } from './crypto.js';
import type { RecoveryKitTarget } from './engine.js';

/** A parsed + validated recovery kit (the shape `writeRecoveryKit` emits). */
export interface RecoveryKitDocument {
  version: 1;
  kind: 'centraid-recovery-kit';
  /** ISO-8601 stamp the kit was written at (advisory). */
  createdAt: string;
  /** Every key epoch — the master material every snapshot was sealed under. */
  keyring: Keyring;
  /** One row per vault this gateway backs up: how to reach + address it. */
  targets: RecoveryKitTarget[];
}

const KIT_KIND = 'centraid-recovery-kit';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTarget(value: unknown, index: number): RecoveryKitTarget {
  if (!isRecord(value)) throw new Error(`recovery kit: target ${index} is not an object`);
  // `provider` is the base URL (remote) or `local:<dir>` moniker — the
  // addressing recover() dials; `targetId` + `vaultId` are the storage-target
  // and vault ids; `label` is the opaque provider-side label (never the vault
  // name). All four are load-bearing for a restore, so all four are required.
  for (const field of ['provider', 'targetId', 'vaultId', 'label'] as const) {
    if (typeof value[field] !== 'string' || (value[field] as string).length === 0) {
      throw new Error(`recovery kit: target ${index} is missing "${field}"`);
    }
  }
  return {
    provider: value['provider'] as string,
    targetId: value['targetId'] as string,
    vaultId: value['vaultId'] as string,
    label: value['label'] as string,
  };
}

/**
 * Parse + validate a recovery-kit document (already JSON-parsed into `value`).
 * Throws a descriptive `Error` on anything that is not a well-formed
 * `centraid-recovery-kit` version 1: wrong kind, unsupported version, a
 * malformed keyring (via the same `validateKeyring` `loadKeyring` uses), or a
 * target missing its addressing. Returns the typed document on success.
 */
export function parseRecoveryKit(value: unknown): RecoveryKitDocument {
  if (!isRecord(value)) throw new Error('recovery kit: not an object');
  if (value['kind'] !== KIT_KIND) {
    throw new Error(
      `recovery kit: not a ${KIT_KIND} (kind=${JSON.stringify(value['kind'])}) — ` +
        'this is not a centraid recovery kit',
    );
  }
  if (value['version'] !== 1) {
    throw new Error(
      `recovery kit: unsupported version ${JSON.stringify(value['version'])} — update the gateway`,
    );
  }
  const keyring = validateKeyring(value['keyring']);
  if (!Array.isArray(value['targets']) || value['targets'].length === 0) {
    throw new Error('recovery kit: "targets" must be a non-empty array');
  }
  const targets = (value['targets'] as unknown[]).map((t, i) => validateTarget(t, i));
  const createdAt = typeof value['createdAt'] === 'string' ? value['createdAt'] : '';
  return { version: 1, kind: KIT_KIND, createdAt, keyring, targets };
}
