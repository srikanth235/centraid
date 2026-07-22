import { describe, expect, test } from 'vitest';
import { mergeAllowedHosts, parseAllowedHostsEnv } from './allowed-hosts.js';

describe('parseAllowedHostsEnv', () => {
  test('empty / missing env → []', () => {
    expect(parseAllowedHostsEnv({})).toEqual([]);
    expect(parseAllowedHostsEnv({ CENTRAID_ALLOWED_HOSTS: '' })).toEqual([]);
    expect(parseAllowedHostsEnv({ CENTRAID_ALLOWED_HOSTS: '  ' })).toEqual([]);
  });

  test('comma-separated hostnames, trimmed and lowercased', () => {
    expect(parseAllowedHostsEnv({ CENTRAID_ALLOWED_HOSTS: ' Gateway.example ,API.local' })).toEqual(
      ['gateway.example', 'api.local'],
    );
  });
});

describe('mergeAllowedHosts', () => {
  test('CLI wins order; env appended; duplicates dropped', () => {
    expect(
      mergeAllowedHosts(['GW.Local', 'other'], {
        CENTRAID_ALLOWED_HOSTS: 'other, third.example',
      }),
    ).toEqual(['gw.local', 'other', 'third.example']);
  });

  test('env-only when CLI omitted', () => {
    expect(mergeAllowedHosts(undefined, { CENTRAID_ALLOWED_HOSTS: 'a.example' })).toEqual([
      'a.example',
    ]);
  });
});
