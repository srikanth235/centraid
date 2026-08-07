import path from "node:path";

// Every path in this file is resolved from THIS file's location rather than
// process.cwd() — `bun run --cwd tools/enrichment-service serve` and a
// future systemd/launchd unit that invokes the entry file directly by
// absolute path must resolve the same runtime/ directory either way.
const packageDir = path.resolve(import.meta.dirname, "..");

export const RUNTIME_DIR = path.join(packageDir, "runtime");
export const MODELS_DIR = path.join(RUNTIME_DIR, "models");

export const DEFAULT_PORT = 8787;

function readIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ServiceConfig {
  port: number;
  /** Bearer token required on every request when set; auth is optional otherwise. */
  authToken: string | undefined;
  /** OpenAI-compatible /v1/audio/transcriptions endpoint; transcript is only advertised when this is set AND probes reachable. */
  transcriptUrl: string | undefined;
  /** Request body cap in bytes — keeps a single oversized upload from exhausting memory. */
  maxBodyBytes: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): ServiceConfig {
  return {
    port: readIntEnv(env, "ENRICH_SERVICE_PORT", DEFAULT_PORT),
    authToken: env.ENRICH_SERVICE_TOKEN || undefined,
    transcriptUrl: env.ENRICH_SERVICE_TRANSCRIPT_URL || undefined,
    maxBodyBytes: readIntEnv(
      env,
      "ENRICH_SERVICE_MAX_BODY_BYTES",
      64 * 1024 * 1024
    ),
  };
}
