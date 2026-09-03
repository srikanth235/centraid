import { promises as fs } from "node:fs";

import { HARNESS_KINDS, isHarnessKind } from "@centraid/server/engine";
import type { HarnessKind } from "@centraid/server/engine";

import { validateBackupConfig } from "../backup/backup-config.js";
import type { BackupConfig } from "../backup/backup-config.js";
import { EXPERIMENTAL_FEATURES } from "../serve/experimental-features.js";
import type { ExperimentalFeature } from "../serve/experimental-features.js";

export interface DaemonHarnessConfig {
  kind: HarnessKind;
  binPath?: string;
  extraArgs?: string[];
}

export type DaemonResourceMode =
  | "auto"
  | "conserve"
  | "balanced"
  | "performance";

export interface DaemonConfig {
  dataDir: string;
  host?: string;
  port?: number;
  harness?: DaemonHarnessConfig;
  endpoint?: boolean;
  backup?: BackupConfig;
  resourceMode?: DaemonResourceMode;
  experimental?: Partial<Record<ExperimentalFeature, boolean>>;
}

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = "DaemonConfigError";
  }
}

export async function loadConfigFile(path: string): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    throw new DaemonConfigError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DaemonConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateConfig(parsed);
}

export function validateConfig(value: unknown): DaemonConfig {
  if (!isRecord(value))
    throw new DaemonConfigError("top-level value must be an object");
  const dataDir = value.dataDir;
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new DaemonConfigError(
      "`dataDir` is required and must be a non-empty string"
    );
  }
  const out: DaemonConfig = { dataDir };
  if (value.host !== undefined) {
    if (typeof value.host !== "string" || value.host.length === 0) {
      throw new DaemonConfigError("`host` must be a non-empty string when set");
    }
    out.host = value.host;
  }
  if (value.port !== undefined) {
    const port = value.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535
    ) {
      throw new DaemonConfigError("`port` must be an integer in [0, 65535]");
    }
    out.port = port;
  }
  if (value.harness !== undefined) {
    out.harness = validateHarness(value.harness);
  }
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== "boolean") {
      throw new DaemonConfigError("`endpoint` must be a boolean when set");
    }
    out.endpoint = value.endpoint;
  }
  if (value.backup !== undefined) {
    try {
      out.backup = validateBackupConfig(value.backup);
    } catch (error) {
      throw new DaemonConfigError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  if (value.resourceMode !== undefined) {
    if (
      value.resourceMode !== "auto" &&
      value.resourceMode !== "conserve" &&
      value.resourceMode !== "balanced" &&
      value.resourceMode !== "performance"
    ) {
      throw new DaemonConfigError(
        '`resourceMode` must be one of "auto", "conserve", "balanced", "performance"'
      );
    }
    out.resourceMode = value.resourceMode;
  }
  if (value.experimental !== undefined) {
    out.experimental = validateExperimental(value.experimental);
  }
  return out;
}

function validateExperimental(
  value: unknown
): Partial<Record<ExperimentalFeature, boolean>> {
  if (!isRecord(value))
    throw new DaemonConfigError("`experimental` must be an object");
  const out: Partial<Record<ExperimentalFeature, boolean>> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (!(EXPERIMENTAL_FEATURES as readonly string[]).includes(key)) {
      throw new DaemonConfigError(
        `\`experimental.${key}\` is not a known experimental feature (${EXPERIMENTAL_FEATURES.map((f) => `"${f}"`).join(", ")})`
      );
    }
    if (typeof flag !== "boolean") {
      throw new DaemonConfigError(
        `\`experimental.${key}\` must be a boolean when set`
      );
    }
    out[key as ExperimentalFeature] = flag;
  }
  return out;
}

function validateHarness(value: unknown): DaemonHarnessConfig {
  if (!isRecord(value))
    throw new DaemonConfigError("`harness` must be an object");
  const kind = value.kind;
  if (!isHarnessKind(kind)) {
    throw new DaemonConfigError(
      `\`harness.kind\` must be one of ${HARNESS_KINDS.map((k) => `"${k}"`).join(", ")}`
    );
  }
  const out: DaemonHarnessConfig = { kind };
  if (value.binPath !== undefined) {
    if (typeof value.binPath !== "string") {
      throw new DaemonConfigError(
        "`harness.binPath` must be a string when set"
      );
    }
    out.binPath = value.binPath;
  }
  if (value.extraArgs !== undefined) {
    if (
      !Array.isArray(value.extraArgs) ||
      value.extraArgs.some((v) => typeof v !== "string")
    ) {
      throw new DaemonConfigError(
        "`harness.extraArgs` must be an array of strings when set"
      );
    }
    out.extraArgs = value.extraArgs as string[];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
