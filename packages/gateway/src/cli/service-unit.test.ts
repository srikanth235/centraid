import { expect, test } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  launchAgentPlistPath,
  systemdUnitPath,
  type ServiceUnitSpec,
} from './service-unit.ts';

const spec: ServiceUnitSpec = {
  nodeBin: '/opt/homebrew/bin/node',
  cliEntry: '/Users/land/centraid/packages/gateway/dist/cli/cli.js',
  args: ['serve', '--data-dir', '/Users/land/centraid-data'],
  stdoutLog: '/Users/land/centraid-data/gateway-logs/service-stdout.log',
  stderrLog: '/Users/land/centraid-data/gateway-logs/service-stderr.log',
  workingDirectory: '/Users/land/centraid-data',
};

/** Minimal stack-based tag-balance check — enough to catch a malformed plist. */
function assertWellFormedXml(xml: string): void {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml))) {
    const [full, closing, name, selfClose] = match;
    if (!name || full.startsWith('<!') || full.startsWith('<?')) continue;
    if (closing === '/') {
      const open = stack.pop();
      expect(open).toBe(name);
      continue;
    }
    if (selfClose === '/') continue;
    stack.push(name);
  }
  expect(stack).toEqual([]);
}

test('launchAgentPlistPath mounts under ~/Library/LaunchAgents with the label as filename', () => {
  const p = launchAgentPlistPath('/Users/land', DEFAULT_LAUNCHD_LABEL);
  expect(p).toBe(path.join('/Users/land', 'Library', 'LaunchAgents', 'dev.centraid.gateway.plist'));
});

test('systemdUnitPath mounts under ~/.config/systemd/user', () => {
  const p = systemdUnitPath('/home/land', DEFAULT_SYSTEMD_UNIT_NAME);
  expect(p).toBe(path.join('/home/land', '.config', 'systemd', 'user', 'centraid-gateway.service'));
});

test('buildLaunchdPlist emits well-formed XML', () => {
  const xml = buildLaunchdPlist(DEFAULT_LAUNCHD_LABEL, spec);
  expect(xml.startsWith('<?xml')).toBe(true);
  assertWellFormedXml(xml);
});

test('buildLaunchdPlist carries the label, absolute node bin + args, and log paths', () => {
  const xml = buildLaunchdPlist(DEFAULT_LAUNCHD_LABEL, spec);
  expect(xml).toContain('<string>dev.centraid.gateway</string>');
  expect(xml).toContain(`<string>${spec.nodeBin}</string>`);
  expect(xml).toContain(`<string>${spec.cliEntry}</string>`);
  expect(xml).toContain('<string>serve</string>');
  expect(xml).toContain('<string>--data-dir</string>');
  expect(xml).toContain(`<string>${spec.stdoutLog}</string>`);
  expect(xml).toContain(`<string>${spec.stderrLog}</string>`);
  expect(path.isAbsolute(spec.nodeBin)).toBe(true);
  expect(path.isAbsolute(spec.cliEntry)).toBe(true);
});

test('buildLaunchdPlist sets RunAtLoad and crash-only KeepAlive', () => {
  const xml = buildLaunchdPlist(DEFAULT_LAUNCHD_LABEL, spec);
  expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
});

test('buildLaunchdPlist escapes XML-significant characters in paths', () => {
  const dirty: ServiceUnitSpec = {
    ...spec,
    workingDirectory: '/Users/a & b/<data>',
  };
  const xml = buildLaunchdPlist(DEFAULT_LAUNCHD_LABEL, dirty);
  expect(xml).toContain('/Users/a &amp; b/&lt;data&gt;');
  assertWellFormedXml(xml);
});

test('buildSystemdUnit carries Restart=on-failure, RestartSec, and WantedBy=default.target', () => {
  const unit = buildSystemdUnit(spec);
  expect(unit).toMatch(/^\[Unit\]/m);
  expect(unit).toContain('[Service]');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toMatch(/RestartSec=\d+/);
  expect(unit).toContain('[Install]');
  expect(unit).toContain('WantedBy=default.target');
});

test('buildSystemdUnit ExecStart uses absolute node bin + cli entry + args, and log paths', () => {
  const unit = buildSystemdUnit(spec);
  const execLine = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  expect(execLine).toBeDefined();
  expect(execLine).toContain(spec.nodeBin);
  expect(execLine).toContain(spec.cliEntry);
  expect(execLine).toContain('serve');
  expect(unit).toContain(`StandardOutput=append:${spec.stdoutLog}`);
  expect(unit).toContain(`StandardError=append:${spec.stderrLog}`);
});

test('buildSystemdUnit honors a custom RestartSec', () => {
  const unit = buildSystemdUnit(spec, 15);
  expect(unit).toContain('RestartSec=15');
});

test('buildSystemdUnit quotes argv tokens containing spaces', () => {
  const spaced: ServiceUnitSpec = { ...spec, args: ['serve', '--data-dir', '/a path/with spaces'] };
  const unit = buildSystemdUnit(spaced);
  expect(unit).toContain('"/a path/with spaces"');
});
