import { describe, expect, test } from 'vitest';

import { mergeAllowedHosts, parseAllowedHostsEnv } from './allowed-hosts.js';

describe(parseAllowedHostsEnv, () => {
  test('empty / missing env → []', () => {
    expect(parseAllowedHostsEnv({})).toStrictEqual([]);
    expect(parseAllowedHostsEnv({ CENTRAID_ALLOWED_HOSTS: '' })).toStrictEqual([]);
    expect(parseAllowedHostsEnv({ CENTRAID_ALLOWED_HOSTS: '  ' })).toStrictEqual([]);
  });

  test('comma-separated hostnames, trimmed and lowercased', () => {
    expect(
      parseAllowedHostsEnv({
        CENTRAID_ALLOWED_HOSTS: ' Gateway.example ,API.local',
      }),
    ).toStrictEqual(['gateway.example', 'api.local']);
  });
});

describe(mergeAllowedHosts, () => {
  test('CLI wins order; env appended; duplicates dropped', () => {
    expect(
      mergeAllowedHosts(['GW.Local', 'other'], {
        CENTRAID_ALLOWED_HOSTS: 'other, third.example',
      }),
    ).toStrictEqual(['gw.local', 'other', 'third.example']);
  });

  test('env-only when CLI omitted', () => {
    expect(mergeAllowedHosts(undefined, { CENTRAID_ALLOWED_HOSTS: 'a.example' })).toStrictEqual([
      'a.example',
    ]);
  });
});
