import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { KeyStore } from "./key-store.js";

export const SEALED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  "locker.item": ["password", "otp_seed", "card_number", "cvv", "content"],
  "locker.item_field": ["value_sealed"],
  "locker.item_passkey": ["private_key"],
  "sync.connection_credential": [
    "client_secret",
    "access_token",
    "refresh_token",
    "refresh_capability",
    "api_key",
  ],
};

export const SEALED_ENFORCEMENT_POINTS = [
  "ciphertext-at-rest",
  "default-read-placeholder",
  "receipted-reveal",
  "journal-hash",
  "fts-exclusion",
  "draft-stage-sealing",
] as const;

export const SEALED_LEAK_SURFACES = [
  "logs",
  "sse",
  "errors",
  "backup-manifest",
  "portable-export",
  "fts-index",
  "replica-snapshot",
  "provider-egress",
] as const;

export function sealedColumnsOf(
  entity: string,
  vault?: DatabaseSync
): readonly string[] {
  const canonical = SEALED_COLUMNS[entity];
  if (canonical) return canonical;
  if (vault && (entity.startsWith("ext.") || entity.startsWith("extdraft."))) {
    return extSealedColumns(vault, entity);
  }
  return [];
}

function extSealedColumns(
  vault: DatabaseSync,
  entity: string
): readonly string[] {
  const parts = entity.split(".");
  if (parts.length !== 3) return [];
  const [prefix, appId, table] = parts;
  const band =
    prefix === "ext" ? "live" : prefix === "extdraft" ? "draft" : null;
  if (!band || !appId || !table) return [];
  try {
    const row = vault
      .prepare(
        `SELECT spec_json FROM access_app_ext WHERE app_id = ? AND band = ? AND table_name = ?`
      )
      .get(appId, band, table) as { spec_json: string } | undefined;
    if (!row) return [];
    const sealed = (JSON.parse(row.spec_json) as { sealed?: unknown }).sealed;
    return Array.isArray(sealed)
      ? (sealed.filter((c) => typeof c === "string") as string[])
      : [];
  } catch {
    return [];
  }
}

function camelCase(column: string): string {
  return column.replace(/_(?<letter>[a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase()
  );
}

export const SEALED_PAYLOAD_FIELDS: Readonly<
  Record<string, readonly string[]>
> = Object.fromEntries(
  Object.entries(SEALED_COLUMNS).map(([entity, columns]) => [
    entity,
    [...new Set(columns.flatMap((column) => [column, camelCase(column)]))],
  ])
);

export function sealedPayloadFieldsOf(entityType: string): readonly string[] {
  return SEALED_PAYLOAD_FIELDS[entityType] ?? [];
}

export const SEALED_PREFIX = "sealed:v1:";

export const SEALED_PLACEHOLDER = "«sealed»";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const SEALED_BODY_RE = /^[A-Za-z0-9+/]{38,}={0,2}$/u;

export function isSealedValue(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(SEALED_PREFIX))
    return false;
  const body = value.slice(SEALED_PREFIX.length);
  if (!SEALED_BODY_RE.test(body) || body.length % 4 !== 0) return false;
  return Buffer.from(body, "base64").length >= NONCE_BYTES + TAG_BYTES;
}

export function sealAad(
  physical: string,
  column: string,
  rowId: string
): string {
  return `${physical}.${column}:${rowId}`;
}

export function sealValue(key: Buffer, aad: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SEALED_PREFIX + Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function unsealValue(key: Buffer, aad: string, sealed: string): string {
  if (!sealed.startsWith(SEALED_PREFIX)) {
    throw new Error("value is not sealed");
  }
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES)
    throw new Error("sealed value truncated");
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8"
  );
}

export function ephemeralSealKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function loadSealKey(file: string, keyStore?: KeyStore): Buffer | null {
  return keyStoreForFile(file, keyStore).load(path.basename(file));
}

export function writeSealKeyFile(
  file: string,
  key: Buffer,
  keyStore?: KeyStore
): void {
  keyStoreForFile(file, keyStore).store(path.basename(file), key);
}

export function createSealKey(file: string, keyStore?: KeyStore): Buffer {
  return keyStoreForFile(file, keyStore).create(path.basename(file));
}

export function sealKeyFileFor(vaultDir: string): string {
  const resolved = path.resolve(vaultDir);
  const vaultRoot = path.dirname(resolved);
  const dataRoot =
    path.basename(vaultRoot) === "vault" ? path.dirname(vaultRoot) : vaultRoot;
  return path.join(dataRoot, "keys", `${path.basename(resolved)}.sealkey`);
}

export function keyStoreForFile(file: string, keyStore?: KeyStore): KeyStore {
  const expectedDir = path.dirname(path.resolve(file));
  if (keyStore && keyStore.dir !== expectedDir) {
    throw new Error(
      `seal key custody store ${keyStore.dir} does not own ${path.resolve(file)} (expected ${expectedDir})`
    );
  }
  return keyStore ?? new KeyStore(expectedDir);
}

export function sealKeyFingerprint(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export class SealKeyError extends Error {
  constructor(
    readonly code: "missing" | "mismatch",
    message: string
  ) {
    super(message);
    this.name = "SealKeyError";
  }
}

const SETTINGS_KEY = "seal_key";

export function readSealKeyFingerprint(vault: DatabaseSync): string | null {
  try {
    const row = vault
      .prepare("SELECT settings_json FROM core_vault LIMIT 1")
      .get() as { settings_json: string | null } | undefined;
    if (!row?.settings_json) return null;
    const bag = (JSON.parse(row.settings_json) as Record<string, unknown>)[
      SETTINGS_KEY
    ];
    const fp =
      bag && typeof bag === "object"
        ? (bag as { fingerprint?: unknown }).fingerprint
        : null;
    return typeof fp === "string" && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
}

export function stampSealKeyFingerprint(
  vault: DatabaseSync,
  key: Buffer
): void {
  const fp = sealKeyFingerprint(key);
  const row = vault
    .prepare("SELECT settings_json FROM core_vault LIMIT 1")
    .get() as { settings_json: string } | undefined;
  if (!row) return;
  const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  const bag = settings[SETTINGS_KEY] as { fingerprint?: string } | undefined;
  if (bag?.fingerprint === fp) return;
  settings[SETTINGS_KEY] = {
    fingerprint: fp,
    stamped_at: new Date().toISOString(),
  };
  vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
}

export function resolveSealKey(
  vault: DatabaseSync,
  file: string,
  keyStore?: KeyStore
): Buffer {
  const expected = readSealKeyFingerprint(vault);
  const key = loadSealKey(file, keyStore);
  if (expected === null) return key ?? createSealKey(file, keyStore);
  if (key && sealKeyFingerprint(key) === expected) return key;
  const next = loadSealKey(`${file}.next`, keyStore);
  if (next && sealKeyFingerprint(next) === expected) {
    renameSync(`${file}.next`, file); // finish the interrupted rotation
    return next;
  }
  if (!key) {
    throw new SealKeyError(
      "missing",
      `seal key file missing at ${file} — this vault has sealed secrets (key ${expected}) and they are unrecoverable without that key. If you exported it, run \`key restore\`; a directory copy alone never carries the key.`
    );
  }
  throw new SealKeyError(
    "mismatch",
    `seal key at ${file} (${sealKeyFingerprint(key)}) is not the key this vault's secrets were sealed with (${expected}) — refusing to open with a regenerated key. Restore the original via \`key restore\`.`
  );
}

export function sealedHashToken(key: Buffer, value: string): string {
  const mac = createHmac("sha256", key)
    .update(value)
    .digest("hex")
    .slice(0, 16);
  return `sealed:sha256:${mac}`;
}

export function redactSealedInput(
  key: Buffer,
  input: Record<string, unknown>,
  sealedPaths: readonly string[]
): Record<string, unknown> {
  if (sealedPaths.length === 0) return input;
  const out: Record<string, unknown> = { ...input };
  for (const p of sealedPaths) {
    const v = out[p];
    if (typeof v === "string" && v.length > 0 && !isSealedValue(v)) {
      out[p] = sealedHashToken(key, v);
    }
  }
  return out;
}

export function scrubSealedText(
  key: Buffer,
  text: string,
  values: readonly string[]
): string {
  let out = text;
  for (const v of values) {
    if (v.length > 0 && !isSealedValue(v) && out.includes(v)) {
      out = out.split(v).join(sealedHashToken(key, v));
    }
  }
  return out;
}

function extSecretContainer(commandName: string): "values" | "set" | null {
  if (/^ext\.[a-z0-9-]+\.insert$/u.test(commandName)) return "values";
  if (/^ext\.[a-z0-9-]+\.update$/u.test(commandName)) return "set";
  return null;
}

function extEntityOfInput(
  commandName: string,
  input: Record<string, unknown>
): string | null {
  const appId = commandName.split(".")[1];
  const table = input["table"];
  if (!appId || typeof table !== "string") return null;
  const prefix = input["band"] === "draft" ? "extdraft" : "ext";
  return `${prefix}.${appId}.${table}`;
}

export function sealedValuesForCommand(
  commandName: string,
  input: Record<string, unknown>,
  sealedInput: readonly string[],
  vault?: DatabaseSync
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && !isSealedValue(v)) out.push(v);
  };
  for (const p of sealedInput) push(input[p]);
  const container = extSecretContainer(commandName);
  if (container && vault) {
    const entity = extEntityOfInput(commandName, input);
    const payload = input[container];
    if (entity && payload && typeof payload === "object") {
      for (const col of sealedColumnsOf(entity, vault)) {
        push((payload as Record<string, unknown>)[col]);
      }
    }
  }
  return out;
}

export function redactCommandInput(
  key: Buffer,
  commandName: string,
  input: Record<string, unknown>,
  sealedInput: readonly string[],
  vault?: DatabaseSync
): Record<string, unknown> {
  let out = redactSealedInput(key, input, sealedInput);
  const container = extSecretContainer(commandName);
  if (container && vault) {
    const entity = extEntityOfInput(commandName, input);
    const payload = out[container];
    if (entity && payload && typeof payload === "object") {
      const cols = sealedColumnsOf(entity, vault);
      if (cols.length > 0) {
        out = {
          ...out,
          [container]: redactSealedInput(
            key,
            payload as Record<string, unknown>,
            cols
          ),
        };
      }
    }
  }
  return out;
}
