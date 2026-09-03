import path from "node:path";

export const DEFAULT_LAUNCHD_LABEL = "dev.centraid.gateway";
export const DEFAULT_SYSTEMD_UNIT_NAME = "centraid-gateway";
export const DEFAULT_SYSTEMD_RESTART_SEC = 5;

export interface ServiceUnitSpec {
  nodeBin: string;
  cliEntry: string;
  args: string[];
  stdoutLog: string;
  stderrLog: string;
  workingDirectory: string;
  env?: Record<string, string>;
  encryptedCredential?: { id: string; path: string };
}

export function launchAgentPlistPath(
  homeDir: string,
  label: string = DEFAULT_LAUNCHD_LABEL
): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

export function systemdUnitPath(
  homeDir: string,
  unitName: string = DEFAULT_SYSTEMD_UNIT_NAME
): string {
  return path.join(
    homeDir,
    ".config",
    "systemd",
    "user",
    `${unitName}.service`
  );
}

export function systemdCredentialPath(
  homeDir: string,
  unitName: string = DEFAULT_SYSTEMD_UNIT_NAME
): string {
  return path.join(
    homeDir,
    ".config",
    "centraid",
    "credentials",
    `${unitName}.keystore.cred`
  );
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function buildLaunchdPlist(
  label: string,
  spec: ServiceUnitSpec
): string {
  const programArgs = [spec.nodeBin, spec.cliEntry, ...spec.args];
  const envEntries = Object.entries(spec.env ?? {});
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${xmlEscape(label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...programArgs.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`),
    "\t</array>",
    ...(envEntries.length > 0
      ? [
          "\t<key>EnvironmentVariables</key>",
          "\t<dict>",
          ...envEntries.flatMap(([key, value]) => [
            `\t\t<key>${xmlEscape(key)}</key>`,
            `\t\t<string>${xmlEscape(value)}</string>`,
          ]),
          "\t</dict>",
        ]
      : []),
    "\t<key>WorkingDirectory</key>",
    `\t<string>${xmlEscape(spec.workingDirectory)}</string>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xmlEscape(spec.stdoutLog)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xmlEscape(spec.stderrLog)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function systemdQuote(token: string): string {
  if (/^[A-Za-z0-9._\-/=:]+$/u.test(token)) return token;
  return `"${token.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export function buildSystemdUnit(
  spec: ServiceUnitSpec,
  restartSec: number = DEFAULT_SYSTEMD_RESTART_SEC
): string {
  const execStart = [spec.nodeBin, spec.cliEntry, ...spec.args]
    .map(systemdQuote)
    .join(" ");
  const envLines = Object.entries(spec.env ?? {}).map(
    ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`
  );
  return [
    "[Unit]",
    "Description=Centraid gateway daemon",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    ...envLines,
    ...(spec.encryptedCredential
      ? [
          `LoadCredentialEncrypted=${spec.encryptedCredential.id}:${systemdQuote(
            spec.encryptedCredential.path
          )}`,
        ]
      : []),
    `ExecStart=${execStart}`,
    `WorkingDirectory=${spec.workingDirectory}`,
    "Restart=on-failure",
    `RestartSec=${restartSec}`,
    `StandardOutput=append:${spec.stdoutLog}`,
    `StandardError=append:${spec.stderrLog}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
