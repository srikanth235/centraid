/**
 * Locker user-presence authentication (issue #630).
 *
 * Credentials are verified with scrypt over an HMAC keyed by the vault seal
 * key. The database therefore contains no verifier that can be attacked from
 * a vault.db copy alone. Unlock sessions and one-time item permits exist only
 * in this gateway instance's memory; restarting the gateway always relocks.
 */

import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";
import { writeReceipt } from "./evidence.js";

export const LOCKER_PRIMARY_CREDENTIAL_ID = "primary";
export const LOCKER_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
export const LOCKER_ITEM_PERMIT_MS = 30 * 1000;
const MIN_PASSPHRASE_LENGTH = 12;
const MIN_DEVICE_SECRET_LENGTH = 32;
const MAX_FAILURE_DELAY_MS = 60 * 1000;
const SCRYPT_OPTIONS = {
  N: 1 << 15,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export type LockerAuthRequest =
  | { operation: "status"; sessionToken?: string }
  | { operation: "configure"; secret: string }
  | {
      operation: "unlock";
      secret: string;
      credentialId?: string;
    }
  | {
      operation: "authorize-item";
      sessionToken: string;
      secret: string;
      itemId: string;
      credentialId?: string;
    }
  | { operation: "lock"; sessionToken?: string }
  | {
      operation: "enroll-device";
      sessionToken: string;
      secret: string;
      label: string;
    }
  | {
      operation: "revoke-device";
      sessionToken: string;
      credentialId: string;
    };

export interface LockerAuthResult {
  ok: boolean;
  configured: boolean;
  authenticated?: boolean;
  /** True when any unlock session is live on this gateway (not caller-specific). */
  unlocked?: boolean;
  sessionToken?: string;
  itemToken?: string;
  credentialId?: string;
  expiresAt?: string;
  retryAfterMs?: number;
  code?: string;
  message?: string;
}

interface CredentialRow {
  credential_id: string;
  kind: "passphrase" | "device";
  salt: Uint8Array;
  verifier: Uint8Array;
}

interface Session {
  expiresAt: number;
}

interface ItemPermit {
  sessionToken: string;
  itemId: string;
  expiresAt: number;
}

interface FailureState {
  failures: number;
  blockedUntil: number;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class LockerAuthentication {
  private readonly sessions = new Map<string, Session>();
  private readonly itemPermits = new Map<string, ItemPermit>();
  private readonly failures = new Map<string, FailureState>();

  constructor(
    private readonly db: VaultDb,
    private readonly clock: () => number = Date.now
  ) {}

  handle(request: LockerAuthRequest): LockerAuthResult {
    this.sweep();
    switch (request.operation) {
      case "status":
        return this.status(request.sessionToken);
      case "configure":
        return this.configure(request.secret);
      case "unlock":
        return this.unlock(
          request.secret,
          request.credentialId ?? LOCKER_PRIMARY_CREDENTIAL_ID
        );
      case "authorize-item":
        return this.authorizeItem(request);
      case "lock":
        return this.lock(request.sessionToken);
      case "enroll-device":
        return this.enrollDevice(request);
      case "revoke-device":
        return this.revokeDevice(request);
    }
  }

  /** True once a passphrase or device credential has been configured. */
  isConfigured(): boolean {
    return this.configured();
  }

  /**
   * True while any unlock session is still live on this gateway process.
   * Companion fill and candidate listing use this so the locked state is
   * data-keyed rather than caller-keyed at the HTTP layer.
   */
  isUnlocked(): boolean {
    this.sweep();
    return this.sessions.size > 0;
  }

  /**
   * Gate every Locker sealed-column reveal when authentication is configured.
   *
   * - UI / agent reveals consume a one-time item permit bound to the session.
   * - Companion fill only requires the vault to be unlocked (any live session);
   *   the origin re-check still lives on the fill query. While locked, fill
   *   cannot harvest passwords from a paired device.
   */
  authorizeReveal(
    authentication: { sessionToken?: string; itemToken?: string } | undefined,
    itemId: string,
    mode: "ui" | "fill"
  ): void {
    this.sweep();
    if (!this.configured()) return;
    if (mode === "fill") {
      if (this.sessions.size === 0) {
        throw new Error("Locker is locked; authenticate before revealing.");
      }
      return;
    }
    this.consumeItemPermit(authentication, itemId);
  }

  /**
   * Consume one item permit before plaintext leaves the vault. A permit is
   * bound to both the unlock session and item id, expires in 30 seconds, and
   * is deleted before reveal so retries cannot replay it.
   */
  consumeItemPermit(
    authentication: { sessionToken?: string; itemToken?: string } | undefined,
    itemId: string
  ): void {
    this.sweep();
    const sessionToken = authentication?.sessionToken;
    const itemToken = authentication?.itemToken;
    if (!sessionToken || !itemToken || !this.touchSession(sessionToken)) {
      throw new Error("Locker is locked; authenticate before revealing.");
    }
    const permit = this.itemPermits.get(itemToken);
    this.itemPermits.delete(itemToken);
    if (
      !permit ||
      permit.expiresAt <= this.clock() ||
      permit.sessionToken !== sessionToken ||
      permit.itemId !== itemId
    ) {
      throw new Error(
        "Locker item authorization expired; authenticate for this item again."
      );
    }
  }

  private configured(): boolean {
    const row = this.db.vault
      .prepare(`SELECT 1 AS present FROM locker_auth_credential LIMIT 1`)
      .get();
    return row !== undefined;
  }

  private status(sessionToken?: string): LockerAuthResult {
    // Status is a passive read — do not slide the session timeout, or any
    // automation/device writing to locker.item (which triggers client refresh)
    // would keep the unlock window open with nobody at the keyboard.
    const authenticated = sessionToken ? this.peekSession(sessionToken) : false;
    const unlocked = this.sessions.size > 0;
    this.receipt("status", authenticated || unlocked ? "allow" : "deny", null, {
      configured: this.configured(),
      unlocked,
    });
    return {
      ok: true,
      configured: this.configured(),
      authenticated,
      unlocked,
      ...(authenticated
        ? { expiresAt: iso(this.sessions.get(sessionToken!)!.expiresAt) }
        : {}),
    };
  }

  private configure(secret: string): LockerAuthResult {
    if (this.configured()) {
      return this.failure(
        "ALREADY_CONFIGURED",
        "Locker authentication is already configured.",
        LOCKER_PRIMARY_CREDENTIAL_ID,
        "configure"
      );
    }
    if (secret.length < MIN_PASSPHRASE_LENGTH) {
      return this.failure(
        "WEAK_PASSPHRASE",
        `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`,
        LOCKER_PRIMARY_CREDENTIAL_ID,
        "configure",
        false
      );
    }
    this.insertCredential(
      LOCKER_PRIMARY_CREDENTIAL_ID,
      "passphrase",
      "Primary passphrase",
      secret
    );
    const session = this.mintSession();
    this.receipt("configure", "allow");
    return {
      ok: true,
      configured: true,
      authenticated: true,
      ...session,
    };
  }

  private unlock(secret: string, credentialId: string): LockerAuthResult {
    const blocked = this.retryAfter(credentialId);
    if (blocked > 0) {
      return this.failure(
        "RATE_LIMITED",
        "Too many failed attempts. Wait before trying again.",
        credentialId,
        "unlock",
        false,
        blocked
      );
    }
    if (!this.verify(credentialId, secret)) {
      const retryAfterMs = this.recordFailure(credentialId);
      return this.failure(
        "INVALID_CREDENTIAL",
        "The passphrase was not accepted.",
        credentialId,
        "unlock",
        false,
        retryAfterMs
      );
    }
    this.failures.delete(credentialId);
    const session = this.mintSession();
    this.receipt("unlock", "allow", null, { credentialId });
    return {
      ok: true,
      configured: true,
      authenticated: true,
      credentialId,
      ...session,
    };
  }

  private authorizeItem(
    request: Extract<LockerAuthRequest, { operation: "authorize-item" }>
  ): LockerAuthResult {
    if (!this.touchSession(request.sessionToken)) {
      return this.failure(
        "SESSION_EXPIRED",
        "Locker relocked. Unlock it before opening an item.",
        request.credentialId ?? LOCKER_PRIMARY_CREDENTIAL_ID,
        "authorize-item",
        false,
        undefined,
        request.itemId
      );
    }
    const credentialId = request.credentialId ?? LOCKER_PRIMARY_CREDENTIAL_ID;
    const blocked = this.retryAfter(credentialId);
    if (blocked > 0) {
      return this.failure(
        "RATE_LIMITED",
        "Too many failed attempts. Wait before trying again.",
        credentialId,
        "authorize-item",
        false,
        blocked,
        request.itemId
      );
    }
    if (!this.verify(credentialId, request.secret)) {
      const retryAfterMs = this.recordFailure(credentialId);
      return this.failure(
        "INVALID_CREDENTIAL",
        "The passphrase was not accepted.",
        credentialId,
        "authorize-item",
        false,
        retryAfterMs,
        request.itemId
      );
    }
    this.failures.delete(credentialId);
    const itemToken = token();
    const expiresAt = this.clock() + LOCKER_ITEM_PERMIT_MS;
    this.itemPermits.set(itemToken, {
      sessionToken: request.sessionToken,
      itemId: request.itemId,
      expiresAt,
    });
    this.receipt("authorize-item", "allow", request.itemId, { credentialId });
    return {
      ok: true,
      configured: true,
      authenticated: true,
      itemToken,
      expiresAt: iso(expiresAt),
    };
  }

  private lock(sessionToken?: string): LockerAuthResult {
    if (sessionToken) {
      this.sessions.delete(sessionToken);
      for (const [key, permit] of this.itemPermits) {
        if (permit.sessionToken === sessionToken) this.itemPermits.delete(key);
      }
    } else {
      this.sessions.clear();
      this.itemPermits.clear();
    }
    this.receipt("lock", "allow");
    return { ok: true, configured: this.configured(), authenticated: false };
  }

  private enrollDevice(
    request: Extract<LockerAuthRequest, { operation: "enroll-device" }>
  ): LockerAuthResult {
    if (!this.touchSession(request.sessionToken)) {
      return this.failure(
        "SESSION_EXPIRED",
        "Unlock Locker before enrolling this device.",
        "device",
        "enroll-device",
        false
      );
    }
    if (request.secret.length < MIN_DEVICE_SECRET_LENGTH) {
      return this.failure(
        "WEAK_DEVICE_SECRET",
        "The device credential is too short.",
        "device",
        "enroll-device",
        false
      );
    }
    const credentialId = uuidv7();
    this.insertCredential(
      credentialId,
      "device",
      request.label.trim() || "Biometric device",
      request.secret
    );
    this.receipt("enroll-device", "allow", credentialId);
    return {
      ok: true,
      configured: true,
      authenticated: true,
      credentialId,
    };
  }

  private revokeDevice(
    request: Extract<LockerAuthRequest, { operation: "revoke-device" }>
  ): LockerAuthResult {
    if (!this.touchSession(request.sessionToken)) {
      return this.failure(
        "SESSION_EXPIRED",
        "Unlock Locker before revoking a device.",
        request.credentialId,
        "revoke-device",
        false
      );
    }
    if (request.credentialId === LOCKER_PRIMARY_CREDENTIAL_ID) {
      return this.failure(
        "PRIMARY_CREDENTIAL",
        "The primary passphrase cannot be revoked.",
        request.credentialId,
        "revoke-device",
        false
      );
    }
    this.db.vault
      .prepare(
        `DELETE FROM locker_auth_credential
          WHERE credential_id = ? AND kind = 'device'`
      )
      .run(request.credentialId);
    this.receipt("revoke-device", "allow", request.credentialId);
    return { ok: true, configured: true, authenticated: true };
  }

  private insertCredential(
    credentialId: string,
    kind: "passphrase" | "device",
    label: string,
    secret: string
  ): void {
    const salt = randomBytes(16);
    const verifier = this.derive(secret, salt);
    const now = nowIso();
    this.db.vault
      .prepare(
        `INSERT INTO locker_auth_credential
           (credential_id, kind, label, salt, verifier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(credentialId, kind, label, salt, verifier, now, now);
  }

  private credential(credentialId: string): CredentialRow | undefined {
    return this.db.vault
      .prepare(
        `SELECT credential_id, kind, salt, verifier
           FROM locker_auth_credential WHERE credential_id = ?`
      )
      .get(credentialId) as CredentialRow | undefined;
  }

  private verify(credentialId: string, secret: string): boolean {
    const row = this.credential(credentialId);
    if (!row) {
      // Equal-cost fake derivation prevents a missing id from becoming a
      // credential-enumeration timing oracle.
      this.derive(secret, Buffer.alloc(16));
      return false;
    }
    const actual = this.derive(secret, Buffer.from(row.salt));
    const expected = Buffer.from(row.verifier);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private derive(secret: string, salt: Uint8Array): Buffer {
    const peppered = createHmac("sha256", this.db.sealKey)
      .update(secret, "utf8")
      .digest();
    return scryptSync(peppered, salt, 32, SCRYPT_OPTIONS);
  }

  private mintSession(): { sessionToken: string; expiresAt: string } {
    const sessionToken = token();
    const expiresAt = this.clock() + LOCKER_SESSION_TIMEOUT_MS;
    this.sessions.set(sessionToken, { expiresAt });
    return { sessionToken, expiresAt: iso(expiresAt) };
  }

  /** Read-only session check — does not extend expiry. */
  private peekSession(sessionToken: string): boolean {
    const session = this.sessions.get(sessionToken);
    if (!session || session.expiresAt <= this.clock()) {
      this.sessions.delete(sessionToken);
      return false;
    }
    return true;
  }

  private touchSession(sessionToken: string): boolean {
    if (!this.peekSession(sessionToken)) return false;
    this.sessions.get(sessionToken)!.expiresAt =
      this.clock() + LOCKER_SESSION_TIMEOUT_MS;
    return true;
  }

  private retryAfter(credentialId: string): number {
    const state = this.failures.get(credentialId);
    return state ? Math.max(0, state.blockedUntil - this.clock()) : 0;
  }

  private recordFailure(credentialId: string): number {
    const previous = this.failures.get(credentialId);
    const failures = (previous?.failures ?? 0) + 1;
    const delay =
      failures < 3
        ? 0
        : Math.min(MAX_FAILURE_DELAY_MS, 1000 * 2 ** (failures - 3));
    this.failures.set(credentialId, {
      failures,
      blockedUntil: this.clock() + delay,
    });
    return delay;
  }

  private failure(
    code: string,
    message: string,
    credentialId: string,
    operation: string,
    configured = this.configured(),
    retryAfterMs?: number,
    objectId: string | null = null
  ): LockerAuthResult {
    this.receipt(operation, "deny", objectId, {
      credentialId,
      code,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    return {
      ok: false,
      configured,
      authenticated: false,
      code,
      message,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  private receipt(
    operation: string,
    decision: "allow" | "deny",
    objectId: string | null = null,
    detail?: Record<string, unknown>
  ): void {
    writeReceipt(this.db.journal, {
      grantId: null,
      invocationId: null,
      action: `authenticate locker.${operation}`,
      objectType: "locker.auth",
      objectId,
      purpose: "dpv:Security",
      decision,
      detail,
    });
  }

  private sweep(): void {
    const now = this.clock();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    for (const [key, permit] of this.itemPermits) {
      if (permit.expiresAt <= now || !this.sessions.has(permit.sessionToken)) {
        this.itemPermits.delete(key);
      }
    }
  }
}
