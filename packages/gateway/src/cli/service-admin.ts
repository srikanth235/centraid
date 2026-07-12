/*
 * `centraid-gateway service install|uninstall|status` — an OS service unit
 * for the headless daemon (issue #351 wave 4). Waves 1-3 gave the daemon
 * supervised restart, health probes, and an instance lease; this closes
 * the last gap the audit named: "ships with no service unit" — nothing
 * brings it back after a reboot or a crash unless the operator hand-rolls
 * one.
 *
 *   centraid-gateway service install   [--data-dir <path> | --config <path>] [--host <h>] [--port <p>] [--dry-run] [--label <id>]
 *   centraid-gateway service uninstall [--dry-run] [--label <id>]
 *   centraid-gateway service status    [--dry-run] [--label <id>]
 *
 * macOS: a LaunchAgent plist at ~/Library/LaunchAgents/<label>.plist,
 * bootstrapped into `gui/$UID`. Linux: a systemd user unit at
 * ~/.config/systemd/user/<label>.service, enabled into `default.target`.
 * Both point at the CURRENT node binary + this CLI's compiled entry with
 * absolute paths, and redirect stdout/stderr into the same `gateway-logs/`
 * directory `serve` itself writes its persisted log ring under (issue
 * #351's other durability leg) — a post-mortem finds both in one place.
 *
 * `install` needs `--data-dir`/`--config` (same resolution `serve` uses)
 * because the generated unit's argv is `serve --data-dir <path>` (or
 * `--config <path>`) — the service has to know what to run. `uninstall`
 * and `status` only need the label; they never touch dataDir.
 *
 * `--dry-run` never writes a file or shells out — it prints exactly what
 * would be written/run so an operator (or a test) can review it first.
 */

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonLayoutFor } from './paths.js';
import { resolveDaemonConfig } from './resolve-config.js';
import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  launchAgentPlistPath,
  systemdUnitPath,
  type ServiceUnitSpec,
} from './service-unit.js';

type Fail = (message: string, code?: number) => never;

interface ServiceArgs {
  configPath?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  dryRun: boolean;
  label?: string;
}

function parseServiceArgs(args: string[], fail: Fail): ServiceArgs {
  const out: ServiceArgs = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case '--config':
        out.configPath = next();
        break;
      case '--data-dir':
        out.dataDir = next();
        break;
      case '--host':
        out.host = next();
        break;
      case '--port': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          fail(`--port must be an integer in [0, 65535]`, 2);
        }
        out.port = n;
        break;
      }
      case '--label':
        out.label = next();
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      default:
        fail(`unknown flag "${flag}"`, 2);
    }
  }
  return out;
}

/** This module's compiled sibling `cli.js` — the actual daemon entry, resolved
 *  from where THIS file was loaded from rather than `process.argv`, so it's
 *  correct whether invoked via the `centraid-gateway` bin, `node dist/cli/cli.js`,
 *  or a dev `tsx` run. */
function resolveCliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.extname(fileURLToPath(import.meta.url));
  return path.join(here, `cli${ext}`);
}

function buildServeArgs(parsed: ServiceArgs, resolvedDataDir: string): string[] {
  const args = ['serve'];
  if (parsed.configPath) {
    args.push('--config', path.resolve(parsed.configPath));
  } else {
    args.push('--data-dir', path.resolve(resolvedDataDir));
  }
  if (parsed.host) args.push('--host', parsed.host);
  if (parsed.port !== undefined) args.push('--port', String(parsed.port));
  return args;
}

async function buildSpec(parsed: ServiceArgs, fail: Fail): Promise<ServiceUnitSpec> {
  if (!parsed.dataDir && !parsed.configPath) {
    fail('service install requires --data-dir or --config, same as `serve`', 2);
  }
  const config = await resolveDaemonConfig(
    { configPath: parsed.configPath, dataDir: parsed.dataDir },
    fail,
  );
  const layout = daemonLayoutFor(config.dataDir);
  const logsDir = layout.logsDir ?? path.join(path.resolve(config.dataDir), 'gateway-logs');
  return {
    nodeBin: process.execPath,
    cliEntry: resolveCliEntry(),
    args: buildServeArgs(parsed, config.dataDir),
    stdoutLog: path.join(logsDir, 'service-stdout.log'),
    stderrLog: path.join(logsDir, 'service-stderr.log'),
    workingDirectory: path.resolve(config.dataDir),
  };
}

function printWouldWrite(unitPath: string, content: string): void {
  process.stdout.write(`# would write ${unitPath}\n${content}\n`);
}

function printWouldRun(commands: string[]): void {
  for (const cmd of commands) process.stdout.write(`# would run: ${cmd}\n`);
}

function run(fail: Fail, command: string, args: string[]): { code: number; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    fail(`failed to run "${command} ${args.join(' ')}": ${result.error.message}`, 1);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { code: result.status ?? 1, output };
}

function guiTarget(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) throw new Error('launchctl gui domain requires a POSIX uid');
  return `gui/${uid}`;
}

// ---- macOS / launchd -------------------------------------------------

async function launchdInstall(parsed: ServiceArgs, fail: Fail): Promise<void> {
  const spec = await buildSpec(parsed, fail);
  const label = parsed.label ?? DEFAULT_LAUNCHD_LABEL;
  const home = os.homedir();
  const plistPath = launchAgentPlistPath(home, label);
  const plist = buildLaunchdPlist(label, spec);
  const bootstrapCmd = `launchctl bootstrap ${guiTarget()} ${plistPath}`;

  if (parsed.dryRun) {
    printWouldWrite(plistPath, plist);
    printWouldRun([bootstrapCmd]);
    return;
  }

  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.stdoutLog), { recursive: true });
  await fs.writeFile(plistPath, plist, 'utf8');

  const { code, output } = run(fail, 'launchctl', ['bootstrap', guiTarget(), plistPath]);
  if (code !== 0) fail(`launchctl bootstrap failed (exit ${code}): ${output.trim()}`, 1);
  process.stdout.write(
    `centraid-gateway: wrote ${plistPath} and bootstrapped ${guiTarget()}/${label}\n`,
  );
}

async function launchdUninstall(parsed: ServiceArgs, fail: Fail): Promise<void> {
  const label = parsed.label ?? DEFAULT_LAUNCHD_LABEL;
  const home = os.homedir();
  const plistPath = launchAgentPlistPath(home, label);
  const bootoutCmd = `launchctl bootout ${guiTarget()}/${label}`;

  if (parsed.dryRun) {
    printWouldRun([bootoutCmd, `rm ${plistPath}`]);
    return;
  }

  // bootout errors when the label isn't currently loaded — that's fine,
  // uninstall is idempotent; the plist removal below is what matters.
  run(fail, 'launchctl', ['bootout', `${guiTarget()}/${label}`]);
  await fs.rm(plistPath, { force: true });
  process.stdout.write(
    `centraid-gateway: booted out ${guiTarget()}/${label} and removed ${plistPath}\n`,
  );
}

/** Structured counterpart of {@link launchdStatus}'s JSON print — extracted
 *  so `centraid-gateway status` (status-admin.ts, issue #382) can fold the
 *  OS service state into its combined summary without shelling out twice.
 *  Never used by `service status` itself, which keeps printing exactly what
 *  it always has. */
export interface ServiceStatusInfo {
  label: string;
  installed: boolean;
  running?: boolean;
  state?: string;
  pid?: number;
}

function launchdStatusInfo(label: string, fail: Fail): ServiceStatusInfo {
  const { code, output } = run(fail, 'launchctl', ['print', `${guiTarget()}/${label}`]);
  if (code !== 0) return { label, installed: false };
  const state = output.match(/state\s*=\s*(\S+)/)?.[1];
  const pid = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
  return {
    label,
    installed: true,
    running: state === 'running',
    state: state ?? 'unknown',
    ...(pid ? { pid: Number(pid) } : {}),
  };
}

/** systemd counterpart of {@link launchdStatusInfo} — `systemctl --user show`
 *  gives structured `Key=Value` properties directly, unlike `status`'s
 *  free-text report (which `systemdStatus` below still prints verbatim). */
function systemdStatusInfo(unitName: string, fail: Fail): ServiceStatusInfo {
  const { code, output } = run(fail, 'systemctl', [
    '--user',
    'show',
    `${unitName}.service`,
    '--property=LoadState,ActiveState,MainPID',
  ]);
  if (code !== 0) return { label: unitName, installed: false };
  const props = new Map<string, string>();
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    props.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  // `systemctl show` on an unknown unit still exits 0 — LoadState is how it
  // says "never heard of it" (`not-found`).
  const loadState = props.get('LoadState');
  const installed = loadState !== undefined && loadState !== 'not-found';
  if (!installed) return { label: unitName, installed: false };
  const activeState = props.get('ActiveState');
  const mainPid = Number(props.get('MainPID') ?? '0');
  return {
    label: unitName,
    installed: true,
    running: activeState === 'active',
    state: activeState ?? 'unknown',
    ...(Number.isFinite(mainPid) && mainPid > 0 ? { pid: mainPid } : {}),
  };
}

/**
 * Platform-appropriate structured service status — no dry-run branch (a
 * read has nothing to preview or write). `label` falls back to each
 * platform's default the same way `install`/`uninstall`/`status` do.
 */
export function queryServiceStatus(label: string | undefined, fail: Fail): ServiceStatusInfo {
  const platform = process.platform;
  if (platform === 'darwin') return launchdStatusInfo(label ?? DEFAULT_LAUNCHD_LABEL, fail);
  if (platform === 'linux') return systemdStatusInfo(label ?? DEFAULT_SYSTEMD_UNIT_NAME, fail);
  fail(
    `service status is not supported on "${platform}" — only macOS (launchd) and ` +
      'Linux (systemd --user) have a generator today.',
    1,
  );
}

function launchdStatus(parsed: ServiceArgs, fail: Fail): void {
  const label = parsed.label ?? DEFAULT_LAUNCHD_LABEL;
  const printCmd = `launchctl print ${guiTarget()}/${label}`;

  if (parsed.dryRun) {
    printWouldRun([printCmd]);
    return;
  }

  const { code, output } = run(fail, 'launchctl', ['print', `${guiTarget()}/${label}`]);
  if (code !== 0) {
    process.stdout.write(`${JSON.stringify({ label, installed: false })}\n`);
    return;
  }
  const state = output.match(/state\s*=\s*(\S+)/)?.[1];
  const pid = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
  process.stdout.write(
    `${JSON.stringify({
      label,
      installed: true,
      running: state === 'running',
      state: state ?? 'unknown',
      ...(pid ? { pid: Number(pid) } : {}),
    })}\n`,
  );
}

// ---- Linux / systemd --------------------------------------------------

async function systemdInstall(parsed: ServiceArgs, fail: Fail): Promise<void> {
  const spec = await buildSpec(parsed, fail);
  const unitName = parsed.label ?? DEFAULT_SYSTEMD_UNIT_NAME;
  const home = os.homedir();
  const unitPath = systemdUnitPath(home, unitName);
  const unit = buildSystemdUnit(spec);
  const commands = [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${unitName}.service`,
  ];

  if (parsed.dryRun) {
    printWouldWrite(unitPath, unit);
    printWouldRun(commands);
    return;
  }

  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.mkdir(path.dirname(spec.stdoutLog), { recursive: true });
  await fs.writeFile(unitPath, unit, 'utf8');

  const reload = run(fail, 'systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) fail(`systemctl --user daemon-reload failed: ${reload.output.trim()}`, 1);
  const enable = run(fail, 'systemctl', ['--user', 'enable', '--now', `${unitName}.service`]);
  if (enable.code !== 0) {
    fail(`systemctl --user enable --now failed (exit ${enable.code}): ${enable.output.trim()}`, 1);
  }
  process.stdout.write(`centraid-gateway: wrote ${unitPath} and enabled ${unitName}.service\n`);
}

async function systemdUninstall(parsed: ServiceArgs, fail: Fail): Promise<void> {
  const unitName = parsed.label ?? DEFAULT_SYSTEMD_UNIT_NAME;
  const home = os.homedir();
  const unitPath = systemdUnitPath(home, unitName);
  const commands = [
    `systemctl --user disable --now ${unitName}.service`,
    `rm ${unitPath}`,
    'systemctl --user daemon-reload',
  ];

  if (parsed.dryRun) {
    printWouldRun(commands);
    return;
  }

  // disable errors when the unit isn't loaded — uninstall stays idempotent.
  run(fail, 'systemctl', ['--user', 'disable', '--now', `${unitName}.service`]);
  await fs.rm(unitPath, { force: true });
  run(fail, 'systemctl', ['--user', 'daemon-reload']);
  process.stdout.write(`centraid-gateway: disabled and removed ${unitPath}\n`);
}

function systemdStatus(parsed: ServiceArgs, fail: Fail): void {
  const unitName = parsed.label ?? DEFAULT_SYSTEMD_UNIT_NAME;
  const cmd = `systemctl --user status ${unitName}.service`;

  if (parsed.dryRun) {
    printWouldRun([cmd]);
    return;
  }

  const { output } = run(fail, 'systemctl', ['--user', 'status', `${unitName}.service`]);
  process.stdout.write(output);
}

// ---- dispatch -----------------------------------------------------------

export async function commandService(args: string[], fail: Fail): Promise<void> {
  const [action, ...rest] = args;
  if (!action || !['install', 'uninstall', 'status'].includes(action)) {
    fail('service subcommand must be one of: install, uninstall, status', 2);
  }
  const parsed = parseServiceArgs(rest, fail);
  const platform = process.platform;

  if (platform === 'darwin') {
    if (action === 'install') return launchdInstall(parsed, fail);
    if (action === 'uninstall') return launchdUninstall(parsed, fail);
    return launchdStatus(parsed, fail);
  }
  if (platform === 'linux') {
    if (action === 'install') return systemdInstall(parsed, fail);
    if (action === 'uninstall') return systemdUninstall(parsed, fail);
    return systemdStatus(parsed, fail);
  }
  fail(
    `centraid-gateway service is not supported on "${platform}" — only macOS (launchd) and ` +
      "Linux (systemd --user) have a generator today. Front the daemon with your OS's own " +
      'service supervisor instead.',
    1,
  );
}
