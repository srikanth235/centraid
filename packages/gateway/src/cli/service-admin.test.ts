import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { commandService } from './service-admin.ts';

let dataDir: string;
let fakeHome: string;
let originalHome: string | undefined;
let originalPlatform: PropertyDescriptor | undefined;
let writes: string[];
let stdoutSpy: { mockRestore: () => void };

function fail(message: string, code = 1): never {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  throw err;
}

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `centraid-svc-data-${crypto.randomUUID()}-`));
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), `centraid-svc-home-${crypto.randomUUID()}-`));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  writes = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
});

test('service install --dry-run on darwin prints the plist and the bootstrap command, writes nothing', async () => {
  stubPlatform('darwin');
  await commandService(['install', '--data-dir', dataDir, '--dry-run'], fail);
  const out = writes.join('');
  expect(out).toContain('would write');
  expect(out).toContain(path.join(fakeHome, 'Library', 'LaunchAgents', 'dev.centraid.gateway.plist'));
  expect(out).toContain('<?xml');
  expect(out).toContain('launchctl bootstrap gui/');
  await expect(
    fs.access(path.join(fakeHome, 'Library', 'LaunchAgents', 'dev.centraid.gateway.plist')),
  ).rejects.toThrow();
});

test('service install --dry-run embeds the resolved --data-dir into the serve argv', async () => {
  stubPlatform('darwin');
  await commandService(['install', '--data-dir', dataDir, '--dry-run'], fail);
  const out = writes.join('');
  expect(out).toContain('<string>serve</string>');
  expect(out).toContain('<string>--data-dir</string>');
  expect(out).toContain(`<string>${path.resolve(dataDir)}</string>`);
});

test('service install --dry-run on linux prints the systemd unit and the enable command, writes nothing', async () => {
  stubPlatform('linux');
  await commandService(['install', '--data-dir', dataDir, '--dry-run'], fail);
  const out = writes.join('');
  expect(out).toContain('would write');
  expect(out).toContain(path.join(fakeHome, '.config', 'systemd', 'user', 'centraid-gateway.service'));
  expect(out).toContain('[Unit]');
  expect(out).toContain('Restart=on-failure');
  expect(out).toContain('systemctl --user daemon-reload');
  expect(out).toContain('systemctl --user enable --now centraid-gateway.service');
  await expect(
    fs.access(path.join(fakeHome, '.config', 'systemd', 'user', 'centraid-gateway.service')),
  ).rejects.toThrow();
});

test('service uninstall --dry-run prints the platform-appropriate teardown commands', async () => {
  stubPlatform('darwin');
  await commandService(['uninstall', '--dry-run'], fail);
  let out = writes.join('');
  expect(out).toContain('launchctl bootout gui/');
  expect(out).toContain('rm ');
  expect(out).toContain('dev.centraid.gateway.plist');

  writes = [];
  stubPlatform('linux');
  await commandService(['uninstall', '--dry-run'], fail);
  out = writes.join('');
  expect(out).toContain('systemctl --user disable --now centraid-gateway.service');
  expect(out).toContain('centraid-gateway.service');
});

test('service status --dry-run prints the read command without running it', async () => {
  stubPlatform('darwin');
  await commandService(['status', '--dry-run'], fail);
  expect(writes.join('')).toContain('launchctl print gui/');

  writes = [];
  stubPlatform('linux');
  await commandService(['status', '--dry-run'], fail);
  expect(writes.join('')).toContain('systemctl --user status centraid-gateway.service');
});

test('service install rejects an unsupported platform', async () => {
  stubPlatform('win32');
  await expect(
    commandService(['install', '--data-dir', dataDir, '--dry-run'], fail),
  ).rejects.toThrow(/not supported on "win32"/);
});

test('service install requires --data-dir or --config', async () => {
  stubPlatform('darwin');
  await expect(commandService(['install', '--dry-run'], fail)).rejects.toThrow(
    /requires --data-dir or --config/,
  );
});

test('service install rejects an unknown subcommand', async () => {
  await expect(commandService(['bogus'], fail)).rejects.toThrow(
    /must be one of: install, uninstall, status/,
  );
});

test('--label overrides the default launchd label and systemd unit name', async () => {
  stubPlatform('darwin');
  await commandService(['install', '--data-dir', dataDir, '--dry-run', '--label', 'dev.centraid.gateway.e2e-test'], fail);
  expect(writes.join('')).toContain('dev.centraid.gateway.e2e-test.plist');
});
