import { describe, expect, it } from 'vitest';
import {
  AVATAR_PALETTE,
  defaultAvatarColor,
  isValidAvatarColor,
  isValidGatewayId,
  normalizeProfile,
  sortGatewayProfiles,
  validateAddGatewayFields,
} from './gateway-store-core.js';

describe('defaultAvatarColor', () => {
  it('is deterministic and lands in the palette', () => {
    const a = defaultAvatarColor('local');
    const b = defaultAvatarColor('local');
    expect(a).toBe(b);
    expect(AVATAR_PALETTE).toContain(a);
    // Different ids almost always differ; at minimum both are palette members.
    expect(AVATAR_PALETTE).toContain(defaultAvatarColor('remote-uuid-1'));
  });
});

describe('isValidAvatarColor', () => {
  it('accepts only #RRGGBB', () => {
    expect(isValidAvatarColor('#5B8DEF')).toBe(true);
    expect(isValidAvatarColor('#abcdef')).toBe(true);
    expect(isValidAvatarColor('#ABC')).toBe(false);
    expect(isValidAvatarColor('5B8DEF')).toBe(false);
    expect(isValidAvatarColor('#GGGGGG')).toBe(false);
    expect(isValidAvatarColor(null)).toBe(false);
  });
});

describe('isValidGatewayId', () => {
  it('accepts local or a real EndpointId and rejects parallel slug identities', () => {
    expect(isValidGatewayId('local')).toBe(true);
    expect(isValidGatewayId('a'.repeat(64))).toBe(true);
    expect(isValidGatewayId('A'.repeat(64))).toBe(false);
    expect(isValidGatewayId('a1b2c3d4-e5f6')).toBe(false);
    expect(isValidGatewayId('../etc')).toBe(false);
    expect(isValidGatewayId('')).toBe(false);
    expect(isValidGatewayId('has space')).toBe(false);
  });
});

describe('normalizeProfile', () => {
  const endpointId = 'a'.repeat(64);
  const base = {
    id: endpointId,
    kind: 'remote' as const,
    label: 'Home',
    endpointId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('fills displayName from label and avatarColor from palette when absent', () => {
    const p = normalizeProfile(endpointId, base);
    expect(p).toMatchObject({
      id: endpointId,
      kind: 'remote',
      label: 'Home',
      displayName: 'Home',
      rememberDevice: false,
    });
    expect(p?.avatarColor).toBe(defaultAvatarColor(endpointId));
  });

  it('preserves valid optional fields and falls back on an invalid avatar color', () => {
    const p = normalizeProfile(endpointId, {
      ...base,
      displayName: 'Family',
      avatarColor: '#E5734A',
      relayHint: 'https://relay.example',
      rememberDevice: true,
    });
    expect(p).toMatchObject({
      displayName: 'Family',
      avatarColor: '#E5734A',
      endpointId,
      relayHint: 'https://relay.example',
      rememberDevice: true,
    });

    const bad = normalizeProfile(endpointId, { ...base, avatarColor: 'nope' });
    expect(bad?.avatarColor).toBe(defaultAvatarColor(endpointId));
  });

  it('rejects id mismatch, bad kind, empty label, missing createdAt', () => {
    expect(normalizeProfile('other', base)).toBeUndefined();
    expect(normalizeProfile(endpointId, { ...base, kind: 'cloud' as never })).toBeUndefined();
    expect(normalizeProfile(endpointId, { ...base, label: '' })).toBeUndefined();
    expect(normalizeProfile(endpointId, { ...base, createdAt: undefined })).toBeUndefined();
    expect(normalizeProfile(endpointId, null)).toBeUndefined();
  });
});

describe('sortGatewayProfiles', () => {
  it('puts local first then remotes by createdAt ascending', () => {
    const out = sortGatewayProfiles(
      [
        { id: 'b', createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'local', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'a', createdAt: '2026-01-15T00:00:00.000Z' },
      ],
      'local',
    );
    expect(out.map((p) => p.id)).toEqual(['local', 'a', 'b']);
  });
});

describe('validateAddGatewayFields', () => {
  it('requires a label and valid EndpointId', () => {
    expect(validateAddGatewayFields({ label: '  ', endpointId: 'gw-1' })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(validateAddGatewayFields({ label: 'G', endpointId: '' })).toMatchObject({
      ok: false,
      message: expect.stringContaining('EndpointId'),
    });
  });

  it('trims the stable identity, relay cache, and display name', () => {
    const endpointId = 'a'.repeat(64);
    expect(
      validateAddGatewayFields({
        label: '  Home  ',
        endpointId: `  ${endpointId}  `,
        relayHint: '  https://relay.example  ',
        displayName: '  Family  ',
      }),
    ).toEqual({
      ok: true,
      label: 'Home',
      endpointId,
      relayHint: 'https://relay.example',
      displayName: 'Family',
    });
  });
});
