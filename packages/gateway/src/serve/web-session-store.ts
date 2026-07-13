/*
 * Persistent CONTROL browser sessions — the durable half of
 * `web-app-sessions.ts`.
 *
 * The PWA's control cookie is the browser's long-lived credential to the
 * gateway's owner surface (it proxies `/_apps`, settings, etc. via
 * `WEB_CONTROL_PATH`). Keeping it in-memory with a 12h TTL meant every
 * gateway restart — or every 12h — kicked the browser back to the pairing
 * ceremony, even though the pairing flow deliberately throws the device
 * token away for XSS hygiene. That is the usability cliff this store fixes:
 * a control session survives a restart, on a SLIDING 30-day idle window
 * (the cookie's own `Max-Age` carries a 180-day absolute wall).
 *
 * Active per-app sessions stay in-memory (they're re-minted per launch and
 * short-lived by design) — only CONTROL sessions persist here.
 *
 * Persistence mirrors the sibling stores (`device-token-store.ts`,
 * `enrollment-store.ts`): a JSON file (mode 0600, atomic replace), re-read
 * on mtime change so the admin CLI and the daemon agree without
 * coordination. Only the cookie token's SHA-256 lands on disk — never the
 * secret. When no `file` is given (desktop embed, unit tests, an e2e
 * `serve()` without wiring), the store is purely in-memory and behaves
 * exactly as the old `Map<string, ControlSession>` did.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Sliding idle window: each successful authorize extends expiry to now + this. */
export const CONTROL_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Absolute wall the browser cookie's `Max-Age` carries (client-side cap). */
export const CONTROL_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days
/**
 * Throttle sliding-expiry disk writes: only rewrite when the last persisted
 * extension is older than this, so an active session doesn't cost a write
 * per request. The window is 30 days, so a disk value lagging by up to an
 * hour of live use is immaterial.
 */
const TOUCH_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

export interface ControlSessionRow {
  /** SHA-256 hex of the cookie token — never the secret itself. */
  tokenHash: string;
  /** The vault this control session proxies to. */
  vaultId: string;
  /**
   * The calling device's key (joins `EnrollmentStore.endpointId`) when the
   * session was established over an enrolled transport; absent for the
   * admin/shared-bearer plane (loopback embed, dev/e2e), which skips the
   * revocation check.
   */
  deviceKey?: string;
  /** The PWA shell origin this session is bound to. */
  shellOrigin: string;
  /** ISO establish time. */
  createdAt: string;
  /** Epoch ms — the sliding idle wall (extended on use, throttled to disk). */
  expiresAt: number;
  /** Epoch ms — last successful authorize, best-effort (advanced on persist). */
  lastUsedAt: number;
}

interface WebSessionFile {
  version: 1;
  controls: ControlSessionRow[];
}

/** SHA-256 hex of a cookie token, the only form the token takes on disk. */
export function hashControlToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export class WebControlSessionStore {
  private controls: ControlSessionRow[] = [];
  private loadedMtimeMs = -1;

  private constructor(
    private readonly file: string | undefined,
    private readonly now: () => number,
  ) {}

  /**
   * Open a store. Without `file` the store is in-memory only. `now` is a
   * clock seam (tests inject a fake clock to exercise the sliding window).
   */
  static open(file?: string, now: () => number = Date.now): WebControlSessionStore {
    const store = new WebControlSessionStore(file, now);
    store.reloadIfChanged();
    store.sweepExpired();
    return store;
  }

  /** Re-read the file when another process (CLI ↔ daemon) rewrote it. No-op in-memory. */
  private reloadIfChanged(): void {
    if (this.file === undefined) return;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.controls = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<WebSessionFile>;
      this.controls = Array.isArray(raw.controls)
        ? raw.controls.filter(
            (c): c is ControlSessionRow =>
              typeof c === 'object' &&
              c !== null &&
              typeof (c as ControlSessionRow).tokenHash === 'string' &&
              typeof (c as ControlSessionRow).vaultId === 'string' &&
              typeof (c as ControlSessionRow).shellOrigin === 'string' &&
              typeof (c as ControlSessionRow).expiresAt === 'number',
          )
        : [];
      this.loadedMtimeMs = mtimeMs;
    } catch {
      // Unreadable file: keep an empty set (never widen access on a parse
      // failure — an empty set only denies), same posture as the siblings.
      this.controls = [];
      this.loadedMtimeMs = mtimeMs;
    }
  }

  private persist(): void {
    if (this.file === undefined) return;
    const payload: WebSessionFile = { version: 1, controls: this.controls };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
  }

  /**
   * Establish (or replace) a control session for a freshly-minted cookie.
   * Same-hash rows are replaced; OTHER rows survive — multiple browsers /
   * devices legitimately hold concurrent control sessions.
   */
  establish(input: {
    tokenHash: string;
    vaultId: string;
    deviceKey?: string;
    shellOrigin: string;
  }): ControlSessionRow {
    this.reloadIfChanged();
    const now = this.now();
    this.controls = this.controls.filter((r) => r.tokenHash !== input.tokenHash);
    const row: ControlSessionRow = {
      tokenHash: input.tokenHash,
      vaultId: input.vaultId,
      ...(input.deviceKey ? { deviceKey: input.deviceKey } : {}),
      shellOrigin: input.shellOrigin,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + CONTROL_IDLE_TTL_MS,
      lastUsedAt: now,
    };
    this.controls.push(row);
    this.persist();
    return row;
  }

  /** A live (non-expired) row matching a presented-cookie hash, timing-safe over the hash. */
  find(tokenHash: string): ControlSessionRow | undefined {
    this.reloadIfChanged();
    const now = this.now();
    const expected = Buffer.from(tokenHash, 'hex');
    for (const row of this.controls) {
      if (row.expiresAt <= now) continue;
      const actual = Buffer.from(row.tokenHash, 'hex');
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return row;
    }
    return undefined;
  }

  /**
   * Extend a session's sliding idle window on use. The disk write is
   * throttled: `expiresAt` only advances (and persists) when the last
   * persisted extension is more than an hour old, so a busy session costs
   * at most one write per hour instead of one per request.
   */
  touch(tokenHash: string): void {
    this.reloadIfChanged();
    const row = this.controls.find((r) => r.tokenHash === tokenHash);
    if (!row) return;
    const now = this.now();
    const nextExpiry = now + CONTROL_IDLE_TTL_MS;
    if (nextExpiry - row.expiresAt >= TOUCH_THROTTLE_MS) {
      row.expiresAt = nextExpiry;
      row.lastUsedAt = now;
      this.persist();
    }
  }

  /** Delete one session by cookie hash (logout, revocation). Returns whether a row went. */
  remove(tokenHash: string): boolean {
    this.reloadIfChanged();
    const before = this.controls.length;
    this.controls = this.controls.filter((r) => r.tokenHash !== tokenHash);
    if (this.controls.length === before) return false;
    this.persist();
    return true;
  }

  /** Drop every expired row, persisting only if anything changed. */
  sweepExpired(): void {
    this.reloadIfChanged();
    const now = this.now();
    const before = this.controls.length;
    this.controls = this.controls.filter((r) => r.expiresAt > now);
    if (this.controls.length !== before) this.persist();
  }

  /** Every live (non-expired) row — for tests/inspection (secrets never included). */
  list(): ControlSessionRow[] {
    this.reloadIfChanged();
    const now = this.now();
    return this.controls.filter((r) => r.expiresAt > now).map((r) => ({ ...r }));
  }
}
