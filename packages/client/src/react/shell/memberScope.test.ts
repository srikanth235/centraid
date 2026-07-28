import { describe, expect, it } from 'vitest';
import { canWrite, roleBadge, roleSentence } from './memberScope.js';

// The words a member reads for their access (issue #599, Decision 14). The wire
// role is `admin`/`write`/`read`; none of those words may reach a screen.

describe('ownership words', () => {
  it('spells each role the way a member reads it', () => {
    expect(roleBadge('admin')).toBe('Owner');
    expect(roleBadge('write')).toBe('Member');
    expect(roleBadge('read')).toBe('Viewer');
  });

  it('treats an unknown role as the least privilege it could be', () => {
    expect(roleBadge('something-new')).toBe('Viewer');
    expect(canWrite('something-new')).toBe(false);
  });

  it('says what the role lets you do, without wire words or "vault"', () => {
    for (const role of ['admin', 'write', 'read']) {
      const sentence = roleSentence(role);
      expect(sentence).not.toMatch(/\bvault\b/i);
      expect(sentence).not.toMatch(/\badmin\b/);
      expect(sentence.startsWith('You ')).toBe(true);
    }
    expect(roleSentence('read')).toContain('not change');
  });

  it('makes admin a superset of write', () => {
    expect(canWrite('admin')).toBe(true);
    expect(canWrite('write')).toBe(true);
    expect(canWrite('read')).toBe(false);
  });
});
