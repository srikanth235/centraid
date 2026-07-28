import { describe, expect, test } from 'vitest';
import { parseAddress, threadKey } from './mbox.js';

describe('parseAddress (characterization vs the old regex)', () => {
  test('parses "Name <email>" and lowercases the address', () => {
    expect(parseAddress('"Meera Pillai" <Meera@Example.COM>')).toEqual({
      name: 'Meera Pillai',
      email: 'meera@example.com',
    });
  });

  test('an empty angle address is not an address (old [^>]+ required ≥1 char)', () => {
    expect(parseAddress('a<>b')).toEqual({ name: 'a<>b', email: null });
  });

  test('a bare address without angles is detected by @', () => {
    expect(parseAddress('plain@example.com')).toEqual({
      name: null,
      email: 'plain@example.com',
    });
    expect(parseAddress('not an address')).toEqual({ name: 'not an address', email: null });
  });

  test('the display-name part cannot cross a newline (old `.` did not match \\n)', () => {
    const out = parseAddress('Name\n<email@example.com>');
    expect(out.name).toBeNull();
    expect(out.email).toBe('name\n<email@example.com>');
  });
});

describe('threadKey (characterization vs the old regex)', () => {
  test('strips Re:/Fwd:/Fw:/Aw: chains and lowercases', () => {
    expect(threadKey('Re: Fwd: Aw: Trip planning')).toBe('trip planning');
    expect(threadKey('fw: hello')).toBe('hello');
    expect(threadKey('RE:RE: nested')).toBe('nested');
  });

  test('leaves non-prefixed subjects alone apart from case/trim', () => {
    expect(threadKey('  Hello World  ')).toBe('hello world');
    expect(threadKey(null)).toBe('(no subject)');
  });
});
