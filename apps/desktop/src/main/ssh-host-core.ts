/*
 * Pure core for the SSH admin channel (issue #382) — the desktop drives a
 * remote `centraid-gateway` CLI over `ssh` to bootstrap/administer a
 * headless gateway (Step "Over SSH" in the ConnectFlow wizard, plus the
 * switcher's per-gateway "New vault…"/"Test connection" actions for an
 * ssh-capable profile). Everything here is synchronous, side-effect-free,
 * and node-import-free (beyond types) — `ssh-host.ts` wires the real
 * `spawn()` around it, the same "electron-free pure core" split as
 * `gateway-pairing-core.ts` / `gateway-vaults-core.ts`.
 *
 * The remote CLI's `--json` contract (`packages/gateway/src/cli/json-cli.ts`)
 * is: success prints one `{ok:true, ...}` line; failure prints one
 * `{ok:false, error, message}` line AND exits non-zero. `--version` is the
 * one exception (no `--json` support, plain text) — `centraid-gateway` was
 * never given a machine-readable version flag, so we just read its last
 * non-empty stdout line.
 */

/** ssh's own `ConnectTimeout` (seconds) — how long the TCP/handshake layer
 *  gets before ssh itself gives up. The impure spawn wrapper allows some
 *  slack beyond this for the remote COMMAND to run once connected. */
export const SSH_CONNECT_TIMEOUT_SECONDS = 8;

/** The remote gateway CLI binary, when the profile doesn't override it. */
export const DEFAULT_REMOTE_CLI = 'centraid-gateway';

// ── destination validation ────────────────────────────────────────────

export interface DestinationValidation {
  ok: boolean;
  /** Human-actionable reason, set only when `ok` is false. */
  reason?: string;
}

/**
 * `user@host`, bare `host`, or an `~/.ssh/config` alias — anything ssh
 * itself would accept as its first positional argument. Deliberately
 * conservative: alphanumerics, dots, hyphens, underscores, and one `@`
 * separator. Rejects whitespace and shell metacharacters (`; | & $ \` ' " ( )
 * < > \n`) outright — the destination becomes an argv element we pass to
 * `spawn()` directly (never through a shell), so this isn't an injection
 * defense so much as a "did you paste something that isn't a hostname"
 * sanity check, but it closes the door on a destination string that some
 * OTHER layer might one day interpolate into a shell command.
 */
const DESTINATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function validateSshDestination(destination: string): DestinationValidation {
  const trimmed = destination.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'ssh destination is empty' };
  if (trimmed !== destination) {
    return { ok: false, reason: 'ssh destination must not have leading/trailing whitespace' };
  }
  if (!DESTINATION_RE.test(trimmed)) {
    return {
      ok: false,
      reason:
        `"${destination}" is not a valid ssh destination — use "user@host", "host", or an ` +
        'ssh config alias (letters, digits, dots, hyphens, underscores, one "@" only).',
    };
  }
  return { ok: true };
}

// ── remote command + shell quoting ──────────────────────────────────────

/** POSIX single-quote an argv element, unless it's already shell-safe bare. */
export function shellQuoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join a whitelisted argv into one shell-safe command string — this is
 *  what rides after `ssh <destination> --` (ssh itself just space-joins its
 *  trailing argv and hands it to the remote shell verbatim, with NO
 *  quoting of its own, so if we don't quote, the remote shell will). */
export function shellQuoteArgv(argv: readonly string[]): string {
  return argv.map(shellQuoteArg).join(' ');
}

/** The whitelisted remote operations the desktop ever drives over ssh. */
export type SshRemoteCommand =
  | { kind: 'version' }
  | { kind: 'status' }
  | { kind: 'vault-list' }
  | { kind: 'vault-create'; name?: string }
  | { kind: 'pair'; vaultId: string; ttlMinutes?: number };

/**
 * Build the remote `centraid-gateway …` argv for one whitelisted command.
 * `dataDir`, when set, is always threaded through as `--data-dir` (except
 * for `--version`, which takes no flags at all) — the profile's
 * `ssh.dataDir` is optional, but every other remote CLI invocation needs
 * SOME data-dir/config resolution or the remote CLI itself refuses.
 */
export function buildRemoteArgv(
  remoteCli: string,
  dataDir: string | undefined,
  cmd: SshRemoteCommand,
): string[] {
  const argv = [remoteCli];
  if (cmd.kind === 'version') {
    argv.push('--version');
    return argv;
  }
  switch (cmd.kind) {
    case 'status':
      argv.push('status');
      break;
    case 'vault-list':
      argv.push('vault', 'list');
      break;
    case 'vault-create':
      argv.push('vault', 'create');
      if (cmd.name) argv.push('--name', cmd.name);
      break;
    case 'pair':
      argv.push('pair', '--vault', cmd.vaultId);
      if (cmd.ttlMinutes !== undefined) argv.push('--ttl-minutes', String(cmd.ttlMinutes));
      break;
  }
  if (dataDir) argv.push('--data-dir', dataDir);
  argv.push('--json');
  return argv;
}

export interface BuildSshArgvInput {
  destination: string;
  /** The remote argv (see {@link buildRemoteArgv}) — quoted into one string. */
  remoteArgv: string[];
}

/** Build the full `ssh` argv (everything after the `ssh` binary itself). */
export function buildSshArgv(input: BuildSshArgvInput): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    input.destination,
    '--',
    shellQuoteArgv(input.remoteArgv),
  ];
}

// ── output parsing ───────────────────────────────────────────────────────

/**
 * Scan stdout from the LAST line backward for the first one that parses as
 * JSON — tolerates leading noise (MOTD, `.bashrc` login banners) that ssh
 * or the remote shell may print before our command's own output, which is
 * always the final line the `--json` contract writes.
 */
export function parseSshJsonOutput(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return { ok: true, value: JSON.parse(line) };
    } catch {
      continue;
    }
  }
  return { ok: false };
}

/** `--version` has no `--json` — just the last non-empty output line. */
export function parseSshVersionOutput(stdout: string): string | undefined {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

// ── failure mapping ──────────────────────────────────────────────────────

export type SshFailureCode =
  | 'ssh_unreachable'
  | 'ssh_auth'
  | 'cli_not_found'
  | 'daemon_error'
  | 'bad_output';

export interface SshRunResult {
  /** Process exit code, or `null` if it never ran / was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the run was killed by OUR timeout, not ssh's own ConnectTimeout. */
  timedOut: boolean;
  /** Set when the local `spawn()` call itself failed (e.g. `ssh` binary missing). */
  spawnError?: string;
}

function textDetail(result: SshRunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

/**
 * Map a completed (non-JSON-parseable, or non-zero-exit-with-no-JSON) ssh
 * run to a stable failure code. `ssh` itself exits 255 for every
 * connection-layer failure (unreachable host, refused connection, host key
 * mismatch) — text-sniffing `stderr` is the only way to split "auth failed"
 * from "couldn't connect at all", same tradeoff `handshakeGateway` makes
 * for HTTP status text.
 */
export function mapSshFailure(result: SshRunResult): { code: SshFailureCode; detail: string } {
  if (result.spawnError) return { code: 'ssh_unreachable', detail: result.spawnError };
  if (result.timedOut) {
    return {
      code: 'ssh_unreachable',
      detail: `ssh timed out after ${SSH_CONNECT_TIMEOUT_SECONDS}s`,
    };
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.code === 255) {
    if (/permission denied/i.test(combined)) {
      return { code: 'ssh_auth', detail: textDetail(result) };
    }
    return {
      code: 'ssh_unreachable',
      detail: textDetail(result) || 'ssh connection failed (exit 255)',
    };
  }
  if (/permission denied/i.test(result.stderr)) {
    return { code: 'ssh_auth', detail: textDetail(result) };
  }
  if (/command not found|no such file or directory/i.test(combined)) {
    return { code: 'cli_not_found', detail: textDetail(result) };
  }
  if (result.code === 0) {
    // Ran fine, produced no parseable output — a CLI/protocol mismatch,
    // not a connectivity problem.
    return {
      code: 'bad_output',
      detail: textDetail(result) || 'remote command produced no parseable output',
    };
  }
  return {
    code: 'daemon_error',
    detail: textDetail(result) || `remote command exited ${result.code ?? 'null'}`,
  };
}
