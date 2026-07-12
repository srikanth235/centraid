/*
 * Per-device HTTP bearer tokens (issue #376) — the tenant plane over the
 * shared-bearer HTTP surface.
 *
 * The daemon's shared token (`cli/token.ts`) is the landlord/admin plane:
 * any holder can address every vault. This store mints one token PER
 * DEVICE KEY so the HTTP transport can confine a caller to its
 * enrollments the same way the iroh endpoint already does
 * (`cli/endpoint-host.ts`'s per-boot device-proof header) — app-engine's
 * `startRuntimeHttpServer`'s pluggable `authorizeBearer` looks a presented
 * token up here and, on a match, stamps the caller's `deviceKey` onto the
 * request for `composedHandler` to resolve against `EnrollmentStore`
 * exactly like a device-scoped iroh request.
 *
 * A device token's `deviceKey` is the SAME string enrollment rows key off
 * (`EnrollmentStore`'s `endpointId` field) — for an iroh device that's its
 * EndpointId; for an HTTP-redeemed device (no iroh identity of its own)
 * it's a synthetic `http:<uuid>` minted at redemption (`routes/pair-
 * routes.ts`).
 *
 * Persistence mirrors the sibling stores (`enrollment-store.ts`,
 * `pairing-store.ts`): a JSON file (mode 0600, atomic replace), re-read on
 * mtime change so the admin CLI and the daemon agree without
 * coordination. Only the token secret's SHA-256 lands on disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_PREFIX = 'cdt_';

export interface DeviceTokenRow {
  /** Row id — the public half of the token, safe to log. */
  tokenId: string;
  /** SHA-256 hex of the token secret — never the secret itself. */
  tokenHash: string;
  /** The device key this token authenticates as (joins `EnrollmentStore.endpointId`). */
  deviceKey: string;
  /** Owner-facing label, carried over from the pairing ceremony. */
  label: string;
  /** ISO mint time. */
  createdAt: string;
  /** ISO last-authorized time, best-effort (not updated on every request). */
  lastUsedAt?: string;
}

interface DeviceTokenFile {
  version: 1;
  tokens: DeviceTokenRow[];
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Format a minted token as the pasteable `cdt_<tokenId>.<secret>` bearer string. */
export function formatDeviceToken(tokenId: string, secret: string): string {
  return `${TOKEN_PREFIX}${tokenId}.${secret}`;
}

/** Split a presented bearer into its id/secret halves, or `undefined` if malformed/foreign. */
export function parseDeviceToken(raw: string): { tokenId: string; secret: string } | undefined {
  if (!raw.startsWith(TOKEN_PREFIX)) return undefined;
  const rest = raw.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return undefined;
  return { tokenId: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

export class DeviceTokenStore {
  private tokens: DeviceTokenRow[] = [];
  private loadedMtimeMs = -1;

  private constructor(private readonly file: string) {}

  static open(file: string): DeviceTokenStore {
    const store = new DeviceTokenStore(file);
    store.reloadIfChanged();
    return store;
  }

  /** Re-read the file when another process (CLI ↔ daemon) rewrote it. */
  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.tokens = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DeviceTokenFile>;
      this.tokens = Array.isArray(raw.tokens)
        ? raw.tokens.filter(
            (t): t is DeviceTokenRow =>
              typeof t === 'object' &&
              t !== null &&
              typeof (t as DeviceTokenRow).tokenId === 'string' &&
              typeof (t as DeviceTokenRow).tokenHash === 'string' &&
              typeof (t as DeviceTokenRow).deviceKey === 'string',
          )
        : [];
      this.loadedMtimeMs = mtimeMs;
    } catch {
      // Unreadable file: keep the last good in-memory set (never widen
      // access on a parse failure — an empty set only denies).
      this.tokens = [];
      this.loadedMtimeMs = mtimeMs;
    }
  }

  private persist(): void {
    const payload: DeviceTokenFile = { version: 1, tokens: this.tokens };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
  }

  /**
   * Mint a fresh token for `deviceKey`, replacing any prior token that key
   * held — one token per device; a re-mint invalidates the old one.
   */
  mint(input: { deviceKey: string; label: string }): { token: string; tokenId: string } {
    this.reloadIfChanged();
    this.tokens = this.tokens.filter((t) => t.deviceKey !== input.deviceKey);
    const tokenId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('hex');
    this.tokens.push({
      tokenId,
      tokenHash: hashSecret(secret),
      deviceKey: input.deviceKey,
      label: input.label,
      createdAt: new Date().toISOString(),
    });
    this.persist();
    return { token: formatDeviceToken(tokenId, secret), tokenId };
  }

  /**
   * Verify a presented bearer (timing-safe over the hash) and resolve its
   * device key. `undefined` for anything that doesn't parse or doesn't
   * match — every failure looks the same to the caller, same posture as
   * the shared-token check this augments.
   */
  authorize(raw: string): { deviceKey: string } | undefined {
    const parsed = parseDeviceToken(raw);
    if (!parsed) return undefined;
    this.reloadIfChanged();
    const row = this.tokens.find((t) => t.tokenId === parsed.tokenId);
    if (!row) return undefined;
    const expected = Buffer.from(row.tokenHash, 'hex');
    const actual = Buffer.from(hashSecret(parsed.secret), 'hex');
    const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    return valid ? { deviceKey: row.deviceKey } : undefined;
  }

  /** Revoke every token belonging to a device key ("enrollment gone → token dead too"). */
  revokeForDeviceKey(deviceKey: string): DeviceTokenRow[] {
    this.reloadIfChanged();
    const removed = this.tokens.filter((t) => t.deviceKey === deviceKey);
    if (removed.length === 0) return [];
    this.tokens = this.tokens.filter((t) => t.deviceKey !== deviceKey);
    this.persist();
    return removed;
  }

  /** Every token row, for admin listing (secrets never included — only the hash). */
  list(): DeviceTokenRow[] {
    this.reloadIfChanged();
    return [...this.tokens];
  }
}
