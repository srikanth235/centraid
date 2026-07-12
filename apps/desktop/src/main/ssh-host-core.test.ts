import { describe, expect, it } from 'vitest';
import {
  buildRemoteArgv,
  buildSshArgv,
  mapSshFailure,
  parseSshJsonOutput,
  parseSshVersionOutput,
  shellQuoteArg,
  shellQuoteArgv,
  validateSshDestination,
  SSH_CONNECT_TIMEOUT_SECONDS,
  type SshRunResult,
} from './ssh-host-core.js';

describe('validateSshDestination', () => {
  it('accepts user@host, bare host, and ssh config aliases', () => {
    expect(validateSshDestination('pi@raspberrypi.local')).toEqual({ ok: true });
    expect(validateSshDestination('192.168.1.42')).toEqual({ ok: true });
    expect(validateSshDestination('my-homelab-box')).toEqual({ ok: true });
  });

  it('rejects empty and whitespace-padded destinations', () => {
    expect(validateSshDestination('').ok).toBe(false);
    expect(validateSshDestination('  host  ').ok).toBe(false);
  });

  it('rejects shell metacharacters — injection guard', () => {
    for (const bad of [
      'host; rm -rf /',
      'host && whoami',
      'host | cat /etc/passwd',
      'host`whoami`',
      '$(whoami)@host',
      'host\nwhoami',
      "host' -o ProxyCommand=whoami",
      'user@host with spaces',
    ]) {
      const result = validateSshDestination(bad);
      expect(result.ok, `expected "${bad}" to be rejected`).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe('shellQuoteArg / shellQuoteArgv', () => {
  it('leaves shell-safe tokens bare', () => {
    expect(shellQuoteArg('centraid-gateway')).toBe('centraid-gateway');
    expect(shellQuoteArg('/var/lib/centraid')).toBe('/var/lib/centraid');
    expect(shellQuoteArg('--data-dir')).toBe('--data-dir');
  });

  it('single-quotes anything with spaces or metacharacters, escaping embedded quotes', () => {
    expect(shellQuoteArg('Family Vault')).toBe("'Family Vault'");
    expect(shellQuoteArg("it's mine")).toBe("'it'\\''s mine'");
    expect(shellQuoteArg('$(whoami)')).toBe("'$(whoami)'");
    expect(shellQuoteArg('')).toBe("''");
  });

  it('joins a whole argv into one shell-safe string', () => {
    expect(
      shellQuoteArgv(['centraid-gateway', 'vault', 'create', '--name', 'My Family', '--json']),
    ).toBe("centraid-gateway vault create --name 'My Family' --json");
  });
});

describe('buildRemoteArgv', () => {
  it('--version takes no flags at all', () => {
    expect(buildRemoteArgv('centraid-gateway', '/data', { kind: 'version' })).toEqual([
      'centraid-gateway',
      '--version',
    ]);
  });

  it('status/vault-list/vault-create/pair always append --data-dir (when set) and --json', () => {
    expect(buildRemoteArgv('centraid-gateway', '/data', { kind: 'status' })).toEqual([
      'centraid-gateway',
      'status',
      '--data-dir',
      '/data',
      '--json',
    ]);
    expect(buildRemoteArgv('centraid-gateway', '/data', { kind: 'vault-list' })).toEqual([
      'centraid-gateway',
      'vault',
      'list',
      '--data-dir',
      '/data',
      '--json',
    ]);
    expect(
      buildRemoteArgv('centraid-gateway', '/data', { kind: 'vault-create', name: 'Family' }),
    ).toEqual([
      'centraid-gateway',
      'vault',
      'create',
      '--name',
      'Family',
      '--data-dir',
      '/data',
      '--json',
    ]);
    expect(
      buildRemoteArgv('centraid-gateway', '/data', { kind: 'pair', vaultId: 'v1', ttlMinutes: 15 }),
    ).toEqual([
      'centraid-gateway',
      'pair',
      '--vault',
      'v1',
      '--ttl-minutes',
      '15',
      '--data-dir',
      '/data',
      '--json',
    ]);
  });

  it('omits --data-dir entirely when the profile has none', () => {
    expect(buildRemoteArgv('centraid-gateway', undefined, { kind: 'vault-list' })).toEqual([
      'centraid-gateway',
      'vault',
      'list',
      '--json',
    ]);
  });

  it('honors a custom remote CLI path', () => {
    expect(
      buildRemoteArgv('/opt/homebrew/bin/centraid-gateway', undefined, { kind: 'status' }),
    ).toEqual(['/opt/homebrew/bin/centraid-gateway', 'status', '--json']);
  });
});

describe('buildSshArgv', () => {
  it('matches the frozen ssh invocation shape', () => {
    const argv = buildSshArgv({
      destination: 'pi@raspberrypi.local',
      remoteArgv: ['centraid-gateway', 'vault', 'list', '--json'],
    });
    expect(argv).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
      '-o',
      'StrictHostKeyChecking=accept-new',
      'pi@raspberrypi.local',
      '--',
      'centraid-gateway vault list --json',
    ]);
  });

  it('quotes a remote argv containing a spaced vault name into one safe string', () => {
    const argv = buildSshArgv({
      destination: 'pi@raspberrypi.local',
      remoteArgv: ['centraid-gateway', 'vault', 'create', '--name', 'My Family', '--json'],
    });
    expect(argv[argv.length - 1]).toBe("centraid-gateway vault create --name 'My Family' --json");
  });
});

describe('parseSshJsonOutput', () => {
  it('parses a clean single JSON line', () => {
    expect(parseSshJsonOutput('{"ok":true,"vaultId":"v1"}\n')).toEqual({
      ok: true,
      value: { ok: true, vaultId: 'v1' },
    });
  });

  it('skips leading MOTD/login-banner noise and finds the last valid JSON line', () => {
    const stdout = [
      'Welcome to Ubuntu 24.04 LTS',
      'Last login: Wed Jul 1 12:00:00 2026 from 10.0.0.5',
      '',
      '{"ok":true,"vaults":[{"vaultId":"v1","name":"Family"}]}',
      '',
    ].join('\n');
    const result = parseSshJsonOutput(stdout);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      value: { ok: true, vaults: [{ vaultId: 'v1', name: 'Family' }] },
    });
  });

  it('is not fooled by a JSON-shaped fragment inside MOTD text preceding the real line', () => {
    const stdout = [
      'some text {not real json}',
      '{"ok":false,"error":"usage","message":"bad flag"}',
    ].join('\n');
    expect(parseSshJsonOutput(stdout)).toEqual({
      ok: true,
      value: { ok: false, error: 'usage', message: 'bad flag' },
    });
  });

  it('reports ok:false when nothing on stdout parses as JSON', () => {
    expect(parseSshJsonOutput('just some banner text\nno json here\n')).toEqual({ ok: false });
    expect(parseSshJsonOutput('')).toEqual({ ok: false });
  });
});

describe('parseSshVersionOutput', () => {
  it('returns the last non-empty line', () => {
    expect(parseSshVersionOutput('MOTD line\n\n0.1.0\n')).toBe('0.1.0');
    expect(parseSshVersionOutput('')).toBeUndefined();
    expect(parseSshVersionOutput('\n\n')).toBeUndefined();
  });
});

describe('mapSshFailure', () => {
  const base: SshRunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

  it('maps a local spawn failure (ssh binary missing) to ssh_unreachable', () => {
    expect(mapSshFailure({ ...base, spawnError: 'spawn ssh ENOENT' })).toEqual({
      code: 'ssh_unreachable',
      detail: 'spawn ssh ENOENT',
    });
  });

  it('maps our own timeout to ssh_unreachable', () => {
    expect(mapSshFailure({ ...base, timedOut: true, code: null })).toMatchObject({
      code: 'ssh_unreachable',
    });
  });

  it('maps exit 255 to ssh_auth when the text says permission denied', () => {
    const result = mapSshFailure({
      ...base,
      code: 255,
      stderr: 'pi@raspberrypi.local: Permission denied (publickey).',
    });
    expect(result.code).toBe('ssh_auth');
  });

  it('maps exit 255 without permission-denied text to ssh_unreachable', () => {
    const result = mapSshFailure({
      ...base,
      code: 255,
      stderr: 'ssh: connect to host raspberrypi.local port 22: Connection refused',
    });
    expect(result.code).toBe('ssh_unreachable');
  });

  it('maps a remote "command not found" to cli_not_found', () => {
    const result = mapSshFailure({
      ...base,
      code: 127,
      stderr: 'bash: centraid-gateway: command not found',
    });
    expect(result.code).toBe('cli_not_found');
  });

  it('maps a clean exit with unparseable output to bad_output', () => {
    const result = mapSshFailure({ ...base, code: 0, stdout: 'not json' });
    expect(result.code).toBe('bad_output');
  });

  it('falls back to daemon_error for any other non-zero exit', () => {
    const result = mapSshFailure({ ...base, code: 1, stderr: 'some unexpected remote failure' });
    expect(result.code).toBe('daemon_error');
    expect(result.detail).toContain('some unexpected remote failure');
  });
});
