import { describe, expect, it } from 'vitest';
import { parsePairingInput, parsePairQr } from './phone-link-parse';

function encodeGwPair(payload: {
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
}): string {
  const json = JSON.stringify({ v: 1, kind: 'centraid-gw-pair', ...payload });
  // Node Buffer is available under vitest; mirrors gateway encodePairingTicket.
  return Buffer.from(json, 'utf8').toString('base64url');
}

describe('parsePairingInput', () => {
  it('parses desktop centraid-pair JSON', () => {
    const raw = JSON.stringify({
      v: 1,
      kind: 'centraid-pair',
      ticket: 'ep-ticket',
      code: 'ABCD',
    });
    expect(parsePairingInput(raw)).toEqual({
      kind: 'centraid-pair',
      ticket: 'ep-ticket',
      code: 'ABCD',
    });
    expect(parsePairQr(raw)).toEqual({ ticket: 'ep-ticket', code: 'ABCD' });
  });

  it('parses headless centraid-gw-pair one-line tickets', () => {
    const exp = Date.now() + 60_000;
    const token = encodeGwPair({
      gw: 'gw-endpoint-ticket',
      t: 'ticket-id',
      s: 'one-time-secret',
      vaultName: 'Family',
      exp,
    });
    expect(parsePairingInput(token)).toEqual({
      kind: 'centraid-gw-pair',
      gw: 'gw-endpoint-ticket',
      t: 'ticket-id',
      s: 'one-time-secret',
      vaultName: 'Family',
      exp,
    });
    expect(parsePairQr(token)).toBeUndefined();
  });

  it('rejects garbage and wrong kinds', () => {
    expect(parsePairingInput('')).toBeUndefined();
    expect(parsePairingInput('not-a-ticket')).toBeUndefined();
    expect(parsePairingInput(JSON.stringify({ v: 1, kind: 'other' }))).toBeUndefined();
    const bad = Buffer.from(JSON.stringify({ v: 1, kind: 'centraid-gw-pair' }), 'utf8').toString(
      'base64url',
    );
    expect(parsePairingInput(bad)).toBeUndefined();
  });

  it('tolerates surrounding whitespace', () => {
    const raw = `  ${JSON.stringify({
      v: 1,
      kind: 'centraid-pair',
      ticket: 't',
      code: 'c',
    })}  \n`;
    expect(parsePairingInput(raw)?.kind).toBe('centraid-pair');
  });
});
