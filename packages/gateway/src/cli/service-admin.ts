/** `centraid-gateway service` owns launchd/systemd user units; dry-run never mutates. */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostCredentialKey, keychainAccountFor } from './key-store.js';
import { daemonLayoutFor } from './paths.js';
import { resolveDaemonConfig } from './resolve-config.js';
import { adoptKeyStoreCredential, type ServiceKeyCredential } from './service-credential.js';
import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  launchAgentPlistPath,
  systemdUnitPath,
  systemdCredentialPath,
  type ServiceUnitSpec,
} from './service-unit.js';

type Fail = (message: string, code?: number) => never;

/** Stand-in for the real wrapping key under `--dry-run`; never leaves memory. */
const DRY_RUN_CREDENTIAL = Buffer.alloc(32).toString('base64');

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
    const readValue = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case '--config':
        out.configPath = readValue();
        break;
      case '--data-dir':
        out.dataDir = readValue();
        break;
      case '--host':
        out.host = readValue();
        break;
      case '--port': {
        const n = Number(readValue());
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          fail(`--port must be an integer in [0, 65535]`, 2);
        }
        out.port = n;
        break;
      }
      case '--label':
        out.label = readValue();
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

/** Resolve this module's compiled sibling instead of trusting `process.argv`. */
function resolveCliEntry(): string {
  const here = import.meta.dirname;
  const ext = path.extname(import.meta.filename);
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

interface PreparedServiceSpec {
  unit: ServiceUnitSpec;
  keyCredential?: ServiceKeyCredential;
}

async function buildSpec(parsed: ServiceArgs, fail: Fail): Promise<PreparedServiceSpec> {
  const config = await resolveDaemonConfig(
    { configPath: parsed.configPath, dataDir: parsed.dataDir },
    fail,
  );
  const layout = daemonLayoutFor(config.dataDir);
  const logsDir = layout.logsDir ?? path.join(path.resolve(config.dataDir), 'gateway-logs');
  const env: Record<string, string> = {
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(process.env.CENTRAID_DESKTOP_ENDPOINT_ID?.trim()
      ? {
          CENTRAID_DESKTOP_ENDPOINT_ID: process.env.CENTRAID_DESKTOP_ENDPOINT_ID.trim(),
        }
      : {}),
  };
  // Never a fresh `randomBytes(32)`: a headless `serve` has already wrapped
  // every key under the external host credential, and handing the service a
  // key that cannot decrypt them poisons custody (issue #568 item E). The
  // desktop path still wins via `CENTRAID_KEYSTORE_MASTER_KEY`.
  // `--dry-run` promises zero host mutation, and `hostCredentialKey` creates
  // the fallback file on first call — so keep the placeholder there (every
  // dry-run print redacts the value anyway).
  const encoded =
    process.env.CENTRAID_KEYSTORE_MASTER_KEY?.trim() ||
    (parsed.dryRun ? DRY_RUN_CREDENTIAL : hostCredentialKey(layout.keysDir));
  const label =
    parsed.label ??
    (process.platform === 'darwin' ? DEFAULT_LAUNCHD_LABEL : DEFAULT_SYSTEMD_UNIT_NAME);
  const keyCredential =
    process.platform === 'linux'
      ? ({
          kind: 'systemd',
          path: systemdCredentialPath(os.homedir(), parsed.label ?? DEFAULT_SYSTEMD_UNIT_NAME),
          encoded,
          keysDir: layout.keysDir,
        } as const)
      : process.platform === 'darwin'
        ? ({
            kind: 'keychain',
            service: 'dev.centraid.gateway.keystore',
            // Per data directory, not per label: one shared account name let
            // an install for one data dir overwrite (`-U`) the credential
            // another data dir's keys were wrapped under (#568 item E).
            account: keychainAccountFor(layout.keysDir, label),
            encoded,
            keysDir: layout.keysDir,
          } as const)
        : undefined;
  if (keyCredential?.kind === 'systemd') {
    env.CENTRAID_KEYSTORE_CREDENTIAL_ENCRYPTED = keyCredential.path;
  } else if (keyCredential?.kind === 'keychain') {
    env.CENTRAID_KEYSTORE_KEYCHAIN_SERVICE = keyCredential.service;
    env.CENTRAID_KEYSTORE_KEYCHAIN_ACCOUNT = keyCredential.account;
  }
  const unit: ServiceUnitSpec = {
    nodeBin: process.execPath,
    cliEntry: resolveCliEntry(),
    args: buildServeArgs(parsed, config.dataDir),
    stdoutLog: path.join(logsDir, 'service-stdout.log'),
    stderrLog: path.join(logsDir, 'service-stderr.log'),
    workingDirectory: path.resolve(config.dataDir),
    // Electron installs need ELECTRON_RUN_AS_NODE; real Node installs omit it.
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(keyCredential?.kind === 'systemd'
      ? {
          encryptedCredential: {
            id: 'centraid-keystore',
            path: keyCredential.path,
          },
        }
      : {}),
  };
  return { unit, ...(keyCredential ? { keyCredential } : {}) };
}

function printWouldWrite(unitPath: string, content: string): void {
  process.stdout.write(`# would write ${unitPath}\n${content}\n`);
}

function printWouldRun(commands: string[]): void {
  for (const cmd of commands) process.stdout.write(`# would run: ${cmd}\n`);
}

function run(
  fail: Fail,
  command: string,
  args: string[],
  input?: string,
): { code: number; output: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...(input ? { input } : {}),
  });
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
  const prepared = await buildSpec(parsed, fail);
  const spec = prepared.unit;
  const label = parsed.label ?? DEFAULT_LAUNCHD_LABEL;
  const home = os.homedir();
  const plistPath = launchAgentPlistPath(home, label);
  const plist = buildLaunchdPlist(label, spec);
  const credentialCommand =
    prepared.keyCredential?.kind === 'keychain'
      ? `security add-generic-password -U -a ${prepared.keyCredential.account} -s ${prepared.keyCredential.service} -w <redacted>`
      : undefined;
  const bootstrapCmd = `launchctl bootstrap ${guiTarget()} ${plistPath}`;

  if (parsed.dryRun) {
    printWouldWrite(plistPath, plist);
    printWouldRun([...(credentialCommand ? [credentialCommand] : []), bootstrapCmd]);
    return;
  }

  if (prepared.keyCredential?.kind === 'keychain') {
    // Adopt FIRST, commit the Keychain entry LAST (issue #568 item E).
    // `add-generic-password -U` overwrites in place, so a credential written
    // before validation and then rejected by adoption leaves the poisoned
    // value behind — and `cli/key-store.ts` finds it on every darwin boot
    // thereafter, making every key in the data dir undecryptable. Failing
    // here leaves custody exactly as it was found.
    await adoptKeyStoreCredential(fail, prepared.keyCredential);
    const stored = run(fail, '/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-a',
      prepared.keyCredential.account,
      '-s',
      prepared.keyCredential.service,
      '-w',
      prepared.keyCredential.encoded,
    ]);
    if (stored.code !== 0) {
      fail(`could not store service KeyStore credential: ${stored.output.trim()}`, 1);
    }
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

/** Structured status for the combined gateway status command. */
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
  const state = output.match(/state\s*=\s*(?<state>\S+)/u)?.groups?.state;
  const pid = output.match(/\bpid\s*=\s*(?<pid>\d+)/u)?.groups?.pid;
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
  const state = output.match(/state\s*=\s*(?<state>\S+)/u)?.groups?.state;
  const pid = output.match(/\bpid\s*=\s*(?<pid>\d+)/u)?.groups?.pid;
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
  const prepared = await buildSpec(parsed, fail);
  const spec = prepared.unit;
  const unitName = parsed.label ?? DEFAULT_SYSTEMD_UNIT_NAME;
  const home = os.homedir();
  const unitPath = systemdUnitPath(home, unitName);
  const unit = buildSystemdUnit(spec);
  const commands = [
    ...(prepared.keyCredential?.kind === 'systemd'
      ? [`systemd-creds encrypt --user - ${prepared.keyCredential.path}`]
      : []),
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
  if (prepared.keyCredential?.kind === 'systemd') {
    // Same ordering rule as the launchd path (#568 item E): prove the
    // credential reads this data dir's keys before committing it anywhere.
    await adoptKeyStoreCredential(fail, prepared.keyCredential);
    await fs.mkdir(path.dirname(prepared.keyCredential.path), {
      recursive: true,
    });
    const encrypted = run(
      fail,
      'systemd-creds',
      ['encrypt', '--user', '-', prepared.keyCredential.path],
      `${prepared.keyCredential.encoded}\n`,
    );
    if (encrypted.code !== 0) {
      fail(`systemd-creds encrypt failed: ${encrypted.output.trim()}`, 1);
    }
  }
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
