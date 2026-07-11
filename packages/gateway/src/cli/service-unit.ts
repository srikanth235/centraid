/*
 * Pure OS service-unit generators for `centraid-gateway service …`
 * (issue #351 wave 4 — "the headless CLI daemon can run forever but ships
 * with no service unit, no monitor, no alerts").
 *
 * Everything here is (platform inputs in) -> (unit-file text out). No fs,
 * no child_process, no `process.platform` — the impure glue (resolving the
 * node binary, the current CLI entry, running launchctl/systemctl) lives in
 * `service-admin.ts` so this module stays trivially unit-testable and the
 * generated content stays inspectable without touching a real OS service
 * manager.
 */

import path from 'node:path';

export const DEFAULT_LAUNCHD_LABEL = 'dev.centraid.gateway';
export const DEFAULT_SYSTEMD_UNIT_NAME = 'centraid-gateway';
export const DEFAULT_SYSTEMD_RESTART_SEC = 5;

/** Everything a generated unit needs to point at THIS install. */
export interface ServiceUnitSpec {
  /** Absolute path to the node binary that should run the daemon. */
  nodeBin: string;
  /** Absolute path to the `centraid-gateway` CLI entry (dist/cli/cli.js). */
  cliEntry: string;
  /** Argv after the CLI entry, e.g. `['serve', '--data-dir', '/abs/path']`. */
  args: string[];
  /** Absolute path stdout is redirected to (gateway-logs convention). */
  stdoutLog: string;
  /** Absolute path stderr is redirected to. */
  stderrLog: string;
  /** cwd the service runs with. */
  workingDirectory: string;
}

export function launchAgentPlistPath(homeDir: string, label: string = DEFAULT_LAUNCHD_LABEL): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function systemdUnitPath(
  homeDir: string,
  unitName: string = DEFAULT_SYSTEMD_UNIT_NAME,
): string {
  return path.join(homeDir, '.config', 'systemd', 'user', `${unitName}.service`);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A macOS LaunchAgent plist. `RunAtLoad` starts it on login; `KeepAlive`
 * with `SuccessfulExit=false` restarts on crash (any non-zero exit) but
 * NOT after a clean shutdown (the daemon's SIGTERM handler exits 0) — so
 * `launchctl bootout` / a deliberate stop doesn't fight the supervisor.
 */
export function buildLaunchdPlist(label: string, spec: ServiceUnitSpec): string {
  const programArgs = [spec.nodeBin, spec.cliEntry, ...spec.args];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${xmlEscape(label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...programArgs.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`),
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t<string>${xmlEscape(spec.workingDirectory)}</string>`,
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<dict>',
    '\t\t<key>SuccessfulExit</key>',
    '\t\t<false/>',
    '\t</dict>',
    '\t<key>StandardOutPath</key>',
    `\t<string>${xmlEscape(spec.stdoutLog)}</string>`,
    '\t<key>StandardErrorPath</key>',
    `\t<string>${xmlEscape(spec.stderrLog)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Quote one argv token for a systemd `ExecStart=` line (unit-file C-style quoting). */
function systemdQuote(token: string): string {
  if (/^[A-Za-z0-9._\-/=:]+$/.test(token)) return token;
  return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A systemd user unit. `Restart=on-failure` + `RestartSec` is the
 * crash-restart story; `WantedBy=default.target` is what `enable` hooks so
 * it comes back after a user-session/reboot, matching `install`'s
 * `enable --now`.
 */
export function buildSystemdUnit(
  spec: ServiceUnitSpec,
  restartSec: number = DEFAULT_SYSTEMD_RESTART_SEC,
): string {
  const execStart = [spec.nodeBin, spec.cliEntry, ...spec.args].map(systemdQuote).join(' ');
  return [
    '[Unit]',
    'Description=Centraid gateway daemon',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${spec.workingDirectory}`,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    `StandardOutput=append:${spec.stdoutLog}`,
    `StandardError=append:${spec.stderrLog}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
