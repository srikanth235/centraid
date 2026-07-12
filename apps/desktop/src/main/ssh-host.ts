/*
 * SSH admin channel (issue #382) — impure half. Shells out to the system
 * `ssh` binary and drives the remote `centraid-gateway` CLI's `--json`
 * surface; `ssh-host-core.ts` owns argv construction, output parsing, and
 * failure-code mapping (see its header for the pure/impure split rationale).
 *
 * `sshBin` is overridable via `CENTRAID_SSH_BIN` — the E2E rig points this
 * at a stub script that execs the "remote" command against a second local
 * daemon's data-dir, so the whole ConnectFlow "Over SSH" path is testable
 * without a real second host.
 */

import { spawn } from 'node:child_process';
import {
  buildRemoteArgv,
  buildSshArgv,
  mapSshFailure,
  parseSshJsonOutput,
  parseSshVersionOutput,
  validateSshDestination,
  DEFAULT_REMOTE_CLI,
  SSH_CONNECT_TIMEOUT_SECONDS,
  type SshFailureCode,
  type SshRemoteCommand,
  type SshRunResult,
} from './ssh-host-core.js';

export type { SshFailureCode } from './ssh-host-core.js';

/** The `ssh` block persisted on a `GatewayProfile` (see `gateway-store.ts`). */
export interface SshHostProfile {
  destination: string;
  dataDir?: string;
  remoteCli?: string;
}

export type SshCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SshFailureCode; message: string };

/** Slack beyond ssh's own `ConnectTimeout` for the remote COMMAND to run
 *  once connected (mint a ticket, open the vault registry, …). */
const COMMAND_SLACK_SECONDS = 12;
const TOTAL_TIMEOUT_MS = (SSH_CONNECT_TIMEOUT_SECONDS + COMMAND_SLACK_SECONDS) * 1000;

function sshBinary(): string {
  return process.env.CENTRAID_SSH_BIN ?? 'ssh';
}

/** Spawn `ssh` and collect stdout/stderr, killing it on our own timeout —
 *  distinct from ssh's own `ConnectTimeout`, which only bounds the initial
 *  connection, not the remote command's runtime. */
async function runSsh(destination: string, remoteArgv: string[]): Promise<SshRunResult> {
  const args = buildSshArgv({ destination, remoteArgv });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);
  // Never hold the event loop open on a leaked timer — a hung ssh child is
  // already being reaped by the abort above.
  timer.unref?.();

  return new Promise<SshRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Same "settle(() => …)" guard shape as `preflight.ts`'s `execVersion` —
    // at most one of spawn-failure / 'error' / 'exit' ever actually resolves.
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sshBinary(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
      });
    } catch (err) {
      settle(() =>
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      // An AbortError from OUR timeout still lands here — `timedOut` is
      // already set, so the caller sees a timeout, not a raw spawn error.
      settle(() =>
        resolve({
          code: null,
          stdout,
          stderr,
          timedOut,
          spawnError: timedOut ? undefined : err.message,
        }),
      );
    });
    child.on('exit', (code) => {
      settle(() => resolve({ code, stdout, stderr, timedOut }));
    });
  });
}

/** Run one whitelisted remote command and fold its `--json` output through
 *  the CLI's own `{ok:true,...}` / `{ok:false,error,message}` contract —
 *  see `packages/gateway/src/cli/json-cli.ts`. A `{ok:false,...}` line the
 *  remote CLI printed on purpose (bad flags, unknown vault, …) becomes a
 *  `daemon_error` here with the CLI's own message; anything that never
 *  produced parseable JSON at all falls back to `mapSshFailure`'s
 *  exit-code/stderr heuristics (unreachable / auth / cli-not-found /
 *  bad-output). */
async function runJsonCommand(
  profile: SshHostProfile,
  cmd: SshRemoteCommand,
): Promise<SshCommandResult<Record<string, unknown>>> {
  const validation = validateSshDestination(profile.destination);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'ssh_unreachable',
      message: validation.reason ?? 'invalid destination',
    };
  }
  const remoteArgv = buildRemoteArgv(profile.remoteCli ?? DEFAULT_REMOTE_CLI, profile.dataDir, cmd);
  const raw = await runSsh(profile.destination, remoteArgv);

  const parsed = parseSshJsonOutput(raw.stdout);
  if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object') {
    const obj = parsed.value as Record<string, unknown>;
    if (obj.ok === false) {
      const message =
        typeof obj.message === 'string' ? obj.message : 'remote command reported failure';
      return { ok: false, error: 'daemon_error', message };
    }
    return { ok: true, value: obj };
  }

  const mapped = mapSshFailure(raw);
  return { ok: false, error: mapped.code, message: mapped.detail };
}

/** `centraid-gateway --version` — no `--json`, plain text; used by the
 *  connectivity test's "cli" stage (the CLI is present + runnable). */
export async function sshVersion(profile: SshHostProfile): Promise<SshCommandResult<string>> {
  const validation = validateSshDestination(profile.destination);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'ssh_unreachable',
      message: validation.reason ?? 'invalid destination',
    };
  }
  const remoteArgv = buildRemoteArgv(profile.remoteCli ?? DEFAULT_REMOTE_CLI, undefined, {
    kind: 'version',
  });
  const raw = await runSsh(profile.destination, remoteArgv);
  if (raw.spawnError || raw.timedOut || raw.code !== 0) {
    const mapped = mapSshFailure(raw);
    return { ok: false, error: mapped.code, message: mapped.detail };
  }
  const version = parseSshVersionOutput(raw.stdout);
  if (!version)
    return { ok: false, error: 'bad_output', message: 'no version string in ssh output' };
  return { ok: true, value: version };
}

/** `centraid-gateway status --json` — the connectivity test's "daemon" stage. */
export async function sshStatus(
  profile: SshHostProfile,
): Promise<SshCommandResult<Record<string, unknown>>> {
  return runJsonCommand(profile, { kind: 'status' });
}

/** `centraid-gateway vault list --json` — the connectivity test's + the
 *  ConnectFlow vault-picker's "vaults" stage. */
export async function sshVaultList(
  profile: SshHostProfile,
): Promise<SshCommandResult<{ vaults: Array<Record<string, unknown>> }>> {
  const result = await runJsonCommand(profile, { kind: 'vault-list' });
  if (!result.ok) return result;
  const vaults = Array.isArray(result.value.vaults) ? result.value.vaults : [];
  return { ok: true, value: { vaults: vaults as Array<Record<string, unknown>> } };
}

/** `centraid-gateway vault create [--name <name>] --json` — the create leg
 *  of GATEWAY_SSH_CONNECT and the ssh-routed VAULTS_CREATE. */
export async function sshVaultCreate(
  profile: SshHostProfile,
  name?: string,
): Promise<SshCommandResult<{ vaultId: string; name: string }>> {
  const result = await runJsonCommand(profile, { kind: 'vault-create', ...(name ? { name } : {}) });
  if (!result.ok) return result;
  const vaultId = result.value.vaultId;
  const vaultName = result.value.name;
  if (typeof vaultId !== 'string' || typeof vaultName !== 'string') {
    return {
      ok: false,
      error: 'bad_output',
      message: 'remote vault create response missing vaultId/name',
    };
  }
  return { ok: true, value: { vaultId, name: vaultName } };
}

/** `centraid-gateway pair --vault <id> [--ttl-minutes <n>] --json` — mints a
 *  pairing ticket this device redeems LOCALLY through the existing
 *  `redeemGatewayPairing` iroh path (see `gateway-ssh-connect.ts`). */
export async function sshPair(
  profile: SshHostProfile,
  vaultId: string,
  ttlMinutes?: number,
): Promise<
  SshCommandResult<{ ticket: string; vaultId: string; vaultName: string; expiresAt: string }>
> {
  const result = await runJsonCommand(profile, { kind: 'pair', vaultId, ttlMinutes });
  if (!result.ok) return result;
  const { ticket, vaultId: mintedVaultId, vaultName, expiresAt } = result.value;
  if (
    typeof ticket !== 'string' ||
    typeof mintedVaultId !== 'string' ||
    typeof vaultName !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return {
      ok: false,
      error: 'bad_output',
      message: 'remote pair response missing expected fields',
    };
  }
  return { ok: true, value: { ticket, vaultId: mintedVaultId, vaultName, expiresAt } };
}
