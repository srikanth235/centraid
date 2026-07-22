import { describe, expect, it } from 'vitest';
import {
  clearFillMaterial,
  clearSavedPassword,
  isTrustedCredentialGesture,
  passwordForSave,
} from './credential-gesture.js';

describe('credential gesture boundary', () => {
  it('rejects the synthetic click a hostile page script can dispatch', () => {
    const synthetic = new MouseEvent('click');
    expect(synthetic.isTrusted).toBe(false);
    expect(isTrustedCredentialGesture(synthetic)).toBe(false);
  });

  it('accepts a browser-trusted user gesture', () => {
    expect(isTrustedCredentialGesture({ isTrusted: true })).toBe(true);
  });

  it('drops every secret-bearing message property after use', () => {
    const material = {
      username: 'user@example.test',
      password: 'correct horse battery staple',
      totp: '123456',
      receipt_id: 'receipt-1',
    };
    clearFillMaterial(material);
    expect(material).toEqual({});

    const save = { type: 'locker:save', password: 'new secret', title: 'Login' };
    clearSavedPassword(save);
    expect(save).toEqual({ type: 'locker:save', title: 'Login' });
  });

  it('offers the generated signup password to the save journey', () => {
    expect(
      passwordForSave({
        password: { value: '' },
        newPassword: { value: 'generated signup secret' },
      }),
    ).toBe('generated signup secret');
  });
});
