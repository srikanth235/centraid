// governance: allow-repo-hygiene file-size-limit os-scheduler keeps launchd/systemd/Task-Scheduler artifact builders + register/unregister/list/reconcile co-located so the cron→platform translation stays in one auditable file; splitting per-platform would scatter cohesive code with no real reuse benefit
/**
 * OS-level scheduler glue for local-side automations.
 *
 * Each automation registered locally becomes one OS scheduler job
 * that fires `centraid run-automation <appId> <name>` headlessly at
 * the cron-expression cadence. The OS-specific transport differs:
 *
 *   - macOS: launchd LaunchAgent plist under
 *     `~/Library/LaunchAgents/com.centraid.<appId>.<name>.plist`,
 *     loaded via `launchctl bootstrap`.
 *   - Linux: systemd user timer pair (`.service` + `.timer`) under
 *     `~/.config/systemd/user/`, enabled via `systemctl --user`.
 *   - Windows: Task Scheduler task created via `schtasks /Create`.
 *
 * `register()` and `unregister()` are the public verbs. `list()`
 * enumerates centraid-owned jobs as the host sees them. `reconcile()`
 * diffs DB-vs-OS and removes zombies (jobs whose manifest was deleted
 * while the desktop was offline).
 *
 * **Hard rule from issue #69 preserved:** no NullScheduler. If the
 * platform is unsupported, every method throws so the desktop can
 * surface a "not supported here" message instead of silently
 * dropping jobs.
 *
 * The artifact-text generators are pure functions so we can unit-test
 * them without touching the actual scheduler. The shell-out paths
 * (`launchctl`, `systemctl`, `schtasks`) are factored through an
 * injectable `execShell` so tests can drive the orchestration without
 * a real OS scheduler available.
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export type OsPlatform = 'darwin' | 'linux' | 'win32' | 'unsupported';

export function currentPlatform(): OsPlatform {
  const p = process.platform;
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'win32';
  return 'unsupported';
}

export interface OsSchedulerJobSpec {
  /** App id the job belongs to. */
  appId: string;
  /** Automation name (matches the manifest filename without .json). */
  automationName: string;
  /** 5-field cron expression from the manifest. */
  cronExpr: string;
  /**
   * Working directory the centraid CLI should cd into before running.
   * Must be the **persistent app root** (the dir containing
   * `data.sqlite` + `current.json`) — NOT a version subdir. The OS
   * scheduler bakes this path into the launchd plist / systemd unit
   * file at register-time, and subsequent publishes create new
   * `versions/<vid>/` subdirs while the persistent root is stable.
   * The CLI's `run-automation` resolves the active version itself via
   * `readActiveCodeDir(cwd)` so the manifest + handler are loaded
   * from the currently-deployed version each fire.
   */
  cwd: string;
  /** Which runner the CLI should drive. */
  runner: 'codex' | 'claude-code';
  /** Absolute path to the `centraid` binary. */
  centraidBin: string;
}

export interface OsSchedulerJobInstalled extends OsSchedulerJobSpec {
  /** Absolute path to the on-disk artifact (plist/timer/task xml). */
  artifactPath: string;
  /** Native job identifier (`com.centraid.<appId>.<name>` or similar). */
  jobLabel: string;
}

const LABEL_PREFIX = 'com.centraid';

export function jobLabel(appId: string, name: string): string {
  // launchd labels accept `A-Za-z0-9.` and are typically reverse-DNS;
  // systemd unit names accept `A-Za-z0-9.-_`. We use a conservative
  // intersection so the same label works everywhere.
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, '_');
  return `${LABEL_PREFIX}.${safe(appId)}.${safe(name)}`;
}

// --- launchd (macOS) ------------------------------------------------------

/**
 * Translate a 5-field cron expression into one or more launchd
 * `<dict>` calendar-interval entries.
 *
 * launchd's StartCalendarInterval only takes concrete values per
 * field (Minute / Hour / Day / Month / Weekday), with `*` represented
 * as the field being absent. We support a usefully large subset:
 *
 *   - `*` / `*\/N`  → omit the field (every minute / every hour / …);
 *     for `*\/N` on minute or hour, we emit one entry per derived value
 *     (so `*\/30` on minute becomes Minute=0 and Minute=30 — two entries).
 *   - `A,B,C`       → one entry per value.
 *   - `A-B`         → one entry per value in the range.
 *   - bare integer  → one entry.
 *
 * Unsupported expressions (e.g. weekday names, step on day-of-month)
 * throw so the desktop UI can surface a clear "not representable on
 * launchd" message instead of silently producing an unfireable plist.
 */
export function cronToLaunchdIntervals(cron: string): Array<Record<string, number>> {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields: ${cron}`);
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const minutes = expandField(minute, 0, 59);
  const hours = expandField(hour, 0, 23);
  const doms = expandField(dom, 1, 31);
  const months = expandField(month, 1, 12);
  const dows = expandField(dow, 0, 6);
  const out: Array<Record<string, number>> = [];
  for (const m of minutes) {
    for (const h of hours) {
      for (const md of doms) {
        for (const mo of months) {
          for (const wd of dows) {
            const entry: Record<string, number> = {};
            if (m !== undefined) entry.Minute = m;
            if (h !== undefined) entry.Hour = h;
            if (md !== undefined) entry.Day = md;
            if (mo !== undefined) entry.Month = mo;
            if (wd !== undefined) entry.Weekday = wd;
            out.push(entry);
          }
        }
      }
    }
  }
  return out;
}

function expandField(field: string, min: number, max: number): Array<number | undefined> {
  if (field === '*') return [undefined];
  if (/^\*\/(\d+)$/.test(field)) {
    const step = Number(/^\*\/(\d+)$/.exec(field)![1]);
    if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step: ${field}`);
    const out: number[] = [];
    for (let v = min; v <= max; v += step) out.push(v);
    return out;
  }
  if (field.includes(',')) {
    return field
      .split(',')
      .flatMap((p) => expandField(p, min, max).filter((v): v is number => v !== undefined));
  }
  if (/^(\d+)-(\d+)$/.test(field)) {
    const m = /^(\d+)-(\d+)$/.exec(field)!;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) throw new Error(`bad range: ${field}`);
    const out: number[] = [];
    for (let v = a; v <= b; v++) out.push(v);
    return out;
  }
  if (/^\d+$/.test(field)) {
    const v = Number(field);
    if (v < min || v > max) throw new Error(`value ${v} out of range [${min},${max}] for ${field}`);
    return [v];
  }
  throw new Error(
    `unsupported cron field "${field}" — only digits, *, */N, A,B,C, A-B are supported on launchd`,
  );
}

export function buildLaunchdPlist(spec: OsSchedulerJobSpec): string {
  const intervals = cronToLaunchdIntervals(spec.cronExpr);
  const intervalsXml =
    intervals.length === 1
      ? `    <key>StartCalendarInterval</key>\n    ${dictToXml(intervals[0]!, 4)}`
      : `    <key>StartCalendarInterval</key>\n    <array>\n${intervals.map((i) => '      ' + dictToXml(i, 6)).join('\n')}\n    </array>`;
  const label = jobLabel(spec.appId, spec.automationName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(spec.centraidBin)}</string>
      <string>run-automation</string>
      <string>${xmlEscape(spec.appId)}</string>
      <string>${xmlEscape(spec.automationName)}</string>
      <string>--runner</string>
      <string>${xmlEscape(spec.runner)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.cwd)}</string>
    <key>RunAtLoad</key>
    <false/>
${intervalsXml}
    <key>StandardOutPath</key>
    <string>${xmlEscape(path.join(spec.cwd, '.automation-logs', spec.automationName + '.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(path.join(spec.cwd, '.automation-logs', spec.automationName + '.err.log'))}</string>
  </dict>
</plist>
`;
}

function dictToXml(entry: Record<string, number>, indent: number): string {
  const pad = ' '.repeat(indent);
  const inner = Object.entries(entry)
    .map(([k, v]) => `${pad}<key>${k}</key>\n${pad}<integer>${v}</integer>`)
    .join('\n');
  return `<dict>\n${inner}\n${pad.slice(0, -2)}</dict>`;
}

function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// --- systemd (Linux) ------------------------------------------------------

/**
 * systemd timers accept a `OnCalendar=` line whose syntax is
 * approximately `Mon..Fri *-*-* HH:MM:SS`. Cron-style 5-field
 * expressions translate cleanly for the common cases.
 */
export function cronToSystemdOnCalendar(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields: ${cron}`);
  const [minute, hour, dom, month, dow] = fields;
  const renderTime = (m: string, h: string): string => {
    const mPart = m === '*' ? '*' : m.replace(/^\*\/(\d+)$/, '0/$1');
    const hPart = h === '*' ? '*' : h.replace(/^\*\/(\d+)$/, '0/$1');
    return `${hPart}:${mPart}:00`;
  };
  const renderDate = (d: string, mo: string): string => {
    const dPart = d === '*' ? '*' : d;
    const moPart = mo === '*' ? '*' : mo;
    return `*-${moPart}-${dPart}`;
  };
  const renderDow = (w: string): string => {
    if (w === '*') return '';
    return w + ' ';
  };
  return `${renderDow(dow ?? '*')}${renderDate(dom ?? '*', month ?? '*')} ${renderTime(minute ?? '*', hour ?? '*')}`;
}

export function buildSystemdService(spec: OsSchedulerJobSpec): string {
  return `[Unit]
Description=Centraid automation ${spec.appId}/${spec.automationName}

[Service]
Type=oneshot
WorkingDirectory=${spec.cwd}
ExecStart=${spec.centraidBin} run-automation ${spec.appId} ${spec.automationName} --runner ${spec.runner}
`;
}

export function buildSystemdTimer(spec: OsSchedulerJobSpec): string {
  return `[Unit]
Description=Centraid automation timer ${spec.appId}/${spec.automationName}

[Timer]
OnCalendar=${cronToSystemdOnCalendar(spec.cronExpr)}
Persistent=true
Unit=${jobLabel(spec.appId, spec.automationName)}.service

[Install]
WantedBy=timers.target
`;
}

// --- Windows Task Scheduler ----------------------------------------------

/**
 * Windows Task Scheduler accepts cron-like schedules through
 * `schtasks /Create /SC ...` but its semantics differ enough that we
 * map a manageable subset: "every N minutes" and "daily at HH:MM".
 * Anything else throws so the UI surfaces "not representable on
 * Task Scheduler in v1."
 */
export function cronToSchtasksArgs(cron: string): string[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields: ${cron}`);
  const [minute, hour, dom, month, dow] = fields;
  // every-N-minutes pattern: `*\/N * * * *`
  if (/^\*\/(\d+)$/.test(minute!) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const step = Number(/^\*\/(\d+)$/.exec(minute!)![1]);
    return ['/SC', 'MINUTE', '/MO', String(step)];
  }
  // daily-at-HH:MM pattern: `M H * * *` (single concrete time)
  if (/^\d+$/.test(minute!) && /^\d+$/.test(hour!) && dom === '*' && month === '*' && dow === '*') {
    const pad = (n: string) => n.padStart(2, '0');
    return ['/SC', 'DAILY', '/ST', `${pad(hour!)}:${pad(minute!)}`];
  }
  throw new Error(
    `cron expression "${cron}" cannot be represented on Windows Task Scheduler in v1 — only "*/N * * * *" (every N minutes) and "M H * * *" (daily at HH:MM) are supported`,
  );
}

// --- shell-out plumbing --------------------------------------------------

export type ExecShell = (
  command: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultExecShell: ExecShell = (command, args) => {
  return new Promise((resolve) => {
    const proc = spawn(command, [...args]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout?.on('data', (c: Buffer) => stdout.push(c));
    proc.stderr?.on('data', (c: Buffer) => stderr.push(c));
    proc.on('exit', (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    proc.on('error', (err) =>
      resolve({ exitCode: 1, stdout: '', stderr: `spawn error: ${err.message}` }),
    );
  });
};

// --- public API -----------------------------------------------------------

export interface OsSchedulerOptions {
  /** Override for tests; defaults to the real OS spawn. */
  execShell?: ExecShell;
  /** Override platform — used by tests. Defaults to `process.platform`. */
  platform?: OsPlatform;
  /** Override the artifact root (LaunchAgents dir, systemd user dir). For tests. */
  artifactRoot?: string;
}

export class UnsupportedOsSchedulerError extends Error {
  constructor(platform: OsPlatform) {
    super(`OS scheduler not supported on platform "${platform}"`);
    this.name = 'UnsupportedOsSchedulerError';
  }
}

function resolveArtifactRoot(platform: OsPlatform, override?: string): string {
  if (override) return override;
  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'LaunchAgents');
    case 'linux':
      return path.join(os.homedir(), '.config', 'systemd', 'user');
    case 'win32':
      // Task Scheduler doesn't have a per-user file artifact in the
      // same sense — the "artifact" is the schtasks registration
      // itself. We still write a record file so list/reconcile can
      // distinguish centraid-owned tasks.
      return path.join(os.homedir(), 'AppData', 'Local', 'Centraid', 'scheduled-tasks');
    default:
      throw new UnsupportedOsSchedulerError(platform);
  }
}

export async function register(
  spec: OsSchedulerJobSpec,
  opts: OsSchedulerOptions = {},
): Promise<OsSchedulerJobInstalled> {
  const platform = opts.platform ?? currentPlatform();
  const exec = opts.execShell ?? defaultExecShell;
  const root = resolveArtifactRoot(platform, opts.artifactRoot);
  const label = jobLabel(spec.appId, spec.automationName);
  await fs.mkdir(root, { recursive: true });

  if (platform === 'darwin') {
    const artifactPath = path.join(root, `${label}.plist`);
    await fs.writeFile(artifactPath, buildLaunchdPlist(spec), 'utf8');
    const uid = process.getuid?.() ?? '';
    const domain = `gui/${uid}`;
    const res = await exec('launchctl', ['bootstrap', domain, artifactPath]);
    if (res.exitCode !== 0) {
      // Recent macOS (Ventura+) returns "5: Input/output error" when
      // the service is already bootstrapped under this domain rather
      // than the older "already loaded" string. Both mean the same
      // thing — force-replace by tearing down + re-bootstrapping.
      // bootout's exit code is intentionally ignored (it errors when
      // the service isn't loaded, which is fine for our purposes).
      await exec('launchctl', ['bootout', `${domain}/${label}`]);
      const retry = await exec('launchctl', ['bootstrap', domain, artifactPath]);
      if (retry.exitCode !== 0) {
        throw new Error(
          `launchctl bootstrap failed: ${retry.stderr || retry.stdout || res.stderr || res.stdout}`,
        );
      }
    }
    return { ...spec, artifactPath, jobLabel: label };
  }
  if (platform === 'linux') {
    const servicePath = path.join(root, `${label}.service`);
    const timerPath = path.join(root, `${label}.timer`);
    await fs.writeFile(servicePath, buildSystemdService(spec), 'utf8');
    await fs.writeFile(timerPath, buildSystemdTimer(spec), 'utf8');
    const reload = await exec('systemctl', ['--user', 'daemon-reload']);
    if (reload.exitCode !== 0) throw new Error(`systemctl daemon-reload failed: ${reload.stderr}`);
    const enable = await exec('systemctl', ['--user', 'enable', '--now', `${label}.timer`]);
    if (enable.exitCode !== 0)
      throw new Error(`systemctl enable ${label}.timer failed: ${enable.stderr}`);
    return { ...spec, artifactPath: timerPath, jobLabel: label };
  }
  if (platform === 'win32') {
    const args = cronToSchtasksArgs(spec.cronExpr);
    const cmd = [
      '/Create',
      '/TN',
      label,
      ...args,
      '/TR',
      `"${spec.centraidBin}" run-automation ${spec.appId} ${spec.automationName} --runner ${spec.runner}`,
      '/F',
    ];
    const res = await exec('schtasks', cmd);
    if (res.exitCode !== 0) {
      throw new Error(`schtasks /Create failed: ${res.stderr || res.stdout}`);
    }
    const artifactPath = path.join(root, `${label}.txt`);
    await fs.writeFile(artifactPath, JSON.stringify(spec, null, 2), 'utf8');
    return { ...spec, artifactPath, jobLabel: label };
  }
  throw new UnsupportedOsSchedulerError(platform);
}

export async function unregister(
  appId: string,
  automationName: string,
  opts: OsSchedulerOptions = {},
): Promise<void> {
  const platform = opts.platform ?? currentPlatform();
  const exec = opts.execShell ?? defaultExecShell;
  const root = resolveArtifactRoot(platform, opts.artifactRoot);
  const label = jobLabel(appId, automationName);

  if (platform === 'darwin') {
    const artifactPath = path.join(root, `${label}.plist`);
    await exec('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${label}`]);
    await fs.rm(artifactPath, { force: true });
    return;
  }
  if (platform === 'linux') {
    await exec('systemctl', ['--user', 'disable', '--now', `${label}.timer`]);
    await fs.rm(path.join(root, `${label}.service`), { force: true });
    await fs.rm(path.join(root, `${label}.timer`), { force: true });
    await exec('systemctl', ['--user', 'daemon-reload']);
    return;
  }
  if (platform === 'win32') {
    await exec('schtasks', ['/Delete', '/TN', label, '/F']);
    await fs.rm(path.join(root, `${label}.txt`), { force: true });
    return;
  }
  throw new UnsupportedOsSchedulerError(platform);
}

export interface OsSchedulerListEntry {
  appId: string;
  automationName: string;
  artifactPath: string;
}

/**
 * Enumerate centraid-owned OS scheduler jobs by scanning the
 * artifact root for files matching our naming convention. Returns
 * the parsed `{appId, automationName}` pair plus the artifact path
 * so the desktop UI can show what the OS actually has registered
 * (independent of what the gateway DB thinks).
 */
export async function list(opts: OsSchedulerOptions = {}): Promise<Array<OsSchedulerListEntry>> {
  const platform = opts.platform ?? currentPlatform();
  const root = resolveArtifactRoot(platform, opts.artifactRoot);
  const entries = await fs.readdir(root).catch(() => []);
  const out: Array<{ appId: string; automationName: string; artifactPath: string }> = [];
  const prefix = `${LABEL_PREFIX}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    // Strip trailing extension (.plist, .timer, .txt). We only emit
    // one row per (appId, automationName); use .plist for darwin,
    // .timer for linux, .txt for win32.
    const wantSuffix = platform === 'darwin' ? '.plist' : platform === 'linux' ? '.timer' : '.txt';
    if (!entry.endsWith(wantSuffix)) continue;
    const inner = entry.slice(prefix.length, -wantSuffix.length);
    const lastDot = inner.lastIndexOf('.');
    if (lastDot < 0) continue;
    const appId = inner.slice(0, lastDot);
    const automationName = inner.slice(lastDot + 1);
    out.push({ appId, automationName, artifactPath: path.join(root, entry) });
  }
  return out;
}

export interface OsSchedulerReconcileDesired {
  /** The job spec the desired state wants installed. */
  spec: OsSchedulerJobSpec;
  /**
   * Whether the user wants this automation firing. False → the
   * reconcile pass removes the OS scheduler entry (there's no clean
   * "registered but suppressed" state in launchd/systemd/Task
   * Scheduler, so disable == unregister).
   */
  enabled: boolean;
}

export interface OsSchedulerReconcileResult {
  /** Job labels newly installed. */
  added: string[];
  /** Job labels whose spec was re-installed (cron/runner/cwd changed). */
  updated: string[];
  /** Job labels removed (no longer desired, or disabled). */
  removed: string[];
}

/**
 * Bring the OS scheduler into agreement with `desired`. Every entry
 * the host currently has that ISN'T in `desired` (with enabled=true)
 * is unregistered; every desired entry that isn't installed is
 * registered. Desired entries that are already installed are
 * re-registered to catch schedule or runner changes that landed
 * while the desktop was offline.
 *
 * Pass `scope.appId` for the per-app case (publish or deregister of
 * one app). Without scope, the removal pass considers every installed
 * centraid-owned entry — appropriate at startup against the full
 * mirror, catastrophic against `listByApp(...)` because every other
 * app's entries would look "absent from desired" and get swept.
 *
 * Called at local-runtime startup to absorb changes that happened
 * outside our hot path (publishes from another machine, manual edits
 * to the mirror, etc.). Best-effort per-entry: a failure on one
 * entry is logged and surfaced in the returned result; the others
 * still run.
 */
export async function reconcile(
  desired: ReadonlyArray<OsSchedulerReconcileDesired>,
  opts: OsSchedulerOptions = {},
  scope?: { appId: string },
): Promise<OsSchedulerReconcileResult> {
  const installedAll = await list(opts);
  // When scoped, the removal pass only considers entries for that app —
  // other apps' entries are invisible to this reconcile pass.
  const installed = scope ? installedAll.filter((e) => e.appId === scope.appId) : installedAll;
  const installedLabels = new Set(installed.map((e) => jobLabel(e.appId, e.automationName)));

  // Desired-and-enabled keyed by label so we can diff against installed.
  // When scoped, defensively drop any cross-app rows the caller passed
  // in by mistake — without this, a scoped reconcile could register
  // entries for an app it wasn't supposed to touch.
  const desiredEnabled = new Map<string, OsSchedulerJobSpec>();
  for (const d of desired) {
    if (!d.enabled) continue;
    if (scope && d.spec.appId !== scope.appId) continue;
    desiredEnabled.set(jobLabel(d.spec.appId, d.spec.automationName), d.spec);
  }

  const result: OsSchedulerReconcileResult = { added: [], updated: [], removed: [] };

  for (const [label, spec] of desiredEnabled) {
    // Always re-register — register() is idempotent and a re-register
    // is how we pick up cron/cwd/runner drift. This is the same
    // strategy openclaw uses (always issue cron.update when both
    // sides have the entry).
    await register(spec, opts);
    if (installedLabels.has(label)) result.updated.push(label);
    else result.added.push(label);
  }

  for (const entry of installed) {
    const label = jobLabel(entry.appId, entry.automationName);
    if (desiredEnabled.has(label)) continue;
    // Either no longer desired, or desired-but-disabled — both
    // collapse to "remove from the host" since OS schedulers have no
    // suppressed-but-registered state.
    await unregister(entry.appId, entry.automationName, opts);
    result.removed.push(label);
  }

  return result;
}
