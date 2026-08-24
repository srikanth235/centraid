/*
 * Named gateway/vault key custody (issue #555).
 *
 * A KeyStore file is never a bare secret. Every backend writes the same
 * self-describing envelope so custody can move between host and OS wrappers
 * without changing callers or filenames. The unprotected file scheme remains
 * only for legacy adoption and low-level compatibility; production gateway
 * hosts supply a protector (OS/service custody or an external 0600 host
 * credential).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const KEY_STORE_SECRET_BYTES = 32;
export const KEY_STORE_ENVELOPE_MAGIC = "CENTRAID-KEY-V1\n";

const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const FILE_SCHEME = "file-0600-v1";
const AES_GCM_SCHEME = "aes-256-gcm-v1";

interface KeyEnvelope {
  scheme: string;
  payload: string;
}

export interface KeyProtector {
  readonly scheme: string;
  protect: (secret: Buffer) => Buffer;
  unprotect: (payload: Buffer) => Buffer;
}

export interface KeyStoreOptions {
  protector?: KeyProtector;
  warn?: (message: string) => void;
  /** Fault-injection seam used to prove first-mint atomicity. */
  beforeCommit?: (file: string, tempFile: string) => void;
}

/** AES-256-GCM envelope protector backed by a device-custodied wrapping key. */
export function aesGcmKeyProtector(masterKey: Buffer): KeyProtector {
  if (masterKey.length !== KEY_STORE_SECRET_BYTES) {
    throw new KeyStoreError(
      "corrupt",
      `KeyStore wrapping key is ${masterKey.length} bytes, expected ${KEY_STORE_SECRET_BYTES}`
    );
  }
  return {
    scheme: AES_GCM_SCHEME,
    protect(secret) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    unprotect(payload) {
      if (payload.length < 28) {
        throw new KeyStoreError(
          "corrupt",
          "KeyStore AES-GCM payload is truncated"
        );
      }
      const nonce = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const ciphertext = payload.subarray(28);
      try {
        const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch (error) {
        throw new KeyStoreError(
          "corrupt",
          `KeyStore AES-GCM authentication failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}

export class KeyStoreError extends Error {
  constructor(
    readonly code: "corrupt" | "unsupported_scheme" | "invalid_name",
    message: string
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}

/**
 * Persistent named-secret store. Construction is side-effect free: a
 * vaultless gateway creates `keys/` only when the endpoint identity is
 * actually requested.
 */
/* oxlint-disable max-classes-per-file -- the typed custody error is colocated with the KeyStore boundary that throws it (#555) */
export class KeyStore {
  readonly dir: string;
  private readonly protector: KeyProtector | undefined;
  private readonly warn: (message: string) => void;
  private readonly beforeCommit:
    | ((file: string, tempFile: string) => void)
    | undefined;

  constructor(dir: string, options: KeyStoreOptions = {}) {
    this.dir = path.resolve(dir);
    this.protector = options.protector;
    this.warn = options.warn ?? (() => undefined);
    this.beforeCommit = options.beforeCommit;
  }

  file(name: string): string {
    assertKeyName(name);
    return path.join(this.dir, name);
  }

  load(name: string): Buffer | null {
    const secret = this.read(name);
    if (secret !== null) assertSecretLength(this.file(name), secret);
    return secret;
  }

  private read(name: string): Buffer | null {
    const file = this.file(name);
    let raw: Buffer;
    try {
      raw = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    this.repairMode(file);

    // One-time adoption of the pre-#555 raw 32-byte files. Rewrite before
    // returning so a successful open never leaves live raw material behind.
    if (
      raw.length === KEY_STORE_SECRET_BYTES &&
      !raw.toString().startsWith(KEY_STORE_ENVELOPE_MAGIC)
    ) {
      this.store(name, raw);
      return Buffer.from(raw);
    }

    const envelope = parseEnvelope(file, raw);
    let secret: Buffer;
    if (envelope.scheme === FILE_SCHEME) {
      secret = decodePayload(file, envelope.payload);
      // Desktop adoption: once an OS-custodied protector is available, a
      // successfully-read headless/legacy envelope is immediately rewrapped.
      if (this.protector) this.write(name, secret);
    } else if (this.protector?.scheme === envelope.scheme) {
      secret = this.protector.unprotect(decodePayload(file, envelope.payload));
    } else {
      throw new KeyStoreError(
        "unsupported_scheme",
        `key ${file} uses unavailable custody scheme "${envelope.scheme}"`
      );
    }
    return Buffer.from(secret);
  }

  loadOrCreate(name: string): Buffer {
    return this.load(name) ?? this.create(name);
  }

  create(name: string): Buffer {
    const secret = randomBytes(KEY_STORE_SECRET_BYTES);
    this.store(name, secret);
    return secret;
  }

  store(name: string, secret: Buffer): void {
    assertSecretLength(this.file(name), secret);
    this.write(name, secret);
  }

  private write(name: string, secret: Buffer): void {
    const file = this.file(name);
    const scheme = this.protector?.scheme ?? FILE_SCHEME;
    const payload = this.protector?.protect(secret) ?? Buffer.from(secret);
    const envelope: KeyEnvelope = {
      scheme,
      payload: payload.toString("base64"),
    };
    const bytes = Buffer.from(
      `${KEY_STORE_ENVELOPE_MAGIC}${JSON.stringify(envelope)}\n`,
      "utf8"
    );
    atomicWrite(file, bytes, this.beforeCommit);
  }

  rotate(name: string): Buffer {
    const next = randomBytes(KEY_STORE_SECRET_BYTES);
    const sidecar = `${name}.next`;
    this.store(sidecar, next);
    renameSync(this.file(sidecar), this.file(name));
    chmodSync(this.file(name), 0o600);
    return next;
  }

  export(name: string): Buffer | null {
    return this.read(name);
  }

  import(name: string, secret: Buffer): void {
    if (secret.length === 0) {
      throw new KeyStoreError(
        "corrupt",
        `key at ${this.file(name)} cannot be empty`
      );
    }
    this.write(name, secret);
  }

  destroy(name: string): boolean {
    let destroyed = false;
    try {
      unlinkSync(this.file(name));
      destroyed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!name.endsWith(".next")) {
      try {
        unlinkSync(this.file(`${name}.next`));
        destroyed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return destroyed;
  }

  private repairMode(file: string): void {
    const mode = statSync(file).mode & 0o777;
    if (mode === 0o600) return;
    chmodSync(file, 0o600);
    this.warn(
      `repaired key permissions on ${file} from ${mode.toString(8)} to 600`
    );
  }
}

function assertKeyName(name: string): void {
  if (!KEY_NAME_RE.test(name)) {
    throw new KeyStoreError("invalid_name", `invalid key name "${name}"`);
  }
}

function assertSecretLength(file: string, secret: Buffer): void {
  if (secret.length !== KEY_STORE_SECRET_BYTES) {
    throw new KeyStoreError(
      "corrupt",
      `key at ${file} is ${secret.length} bytes, expected ${KEY_STORE_SECRET_BYTES}`
    );
  }
}

function parseEnvelope(file: string, raw: Buffer): KeyEnvelope {
  const text = raw.toString("utf8");
  if (!text.startsWith(KEY_STORE_ENVELOPE_MAGIC)) {
    throw new KeyStoreError(
      "corrupt",
      `key at ${file} has no KeyStore envelope`
    );
  }
  try {
    const parsed = JSON.parse(
      text.slice(KEY_STORE_ENVELOPE_MAGIC.length)
    ) as Partial<KeyEnvelope>;
    if (
      typeof parsed.scheme !== "string" ||
      typeof parsed.payload !== "string"
    ) {
      throw new Error("missing scheme or payload");
    }
    return { scheme: parsed.scheme, payload: parsed.payload };
  } catch (error) {
    throw new KeyStoreError(
      "corrupt",
      `key at ${file} has a corrupt KeyStore envelope: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function decodePayload(file: string, payload: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      payload
    )
  ) {
    throw new KeyStoreError(
      "corrupt",
      `key at ${file} has invalid base64 payload`
    );
  }
  return Buffer.from(payload, "base64");
}

function atomicWrite(
  file: string,
  bytes: Buffer,
  beforeCommit?: (file: string, tempFile: string) => void
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  let committed = false;
  try {
    beforeCommit?.(file, temp);
    renameSync(temp, file);
    committed = true;
    chmodSync(file, 0o600);
  } finally {
    if (!committed) rmSync(temp, { force: true });
  }
}
