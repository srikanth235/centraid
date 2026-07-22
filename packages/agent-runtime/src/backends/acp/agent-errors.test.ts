import { expect, test } from 'vitest';
import { AUTH_REQUIRED_CODE, AcpRpcError } from './json-rpc.js';
import { authRequiredMessage, classifyAgentFailure } from './agent-errors.js';
import type { AcpTurnConfig } from './types.js';

const config: AcpTurnConfig = {
  kind: 'goose',
  acpArgs: ['acp'],
  label: 'goose',
  installHint: 'brew install block-goose-cli and run goose configure.',
};

test('AUTH_REQUIRED uses install hint', () => {
  const msg = classifyAgentFailure(
    new AcpRpcError(AUTH_REQUIRED_CODE, 'Authentication required'),
    '',
    config,
  );
  expect(msg).toBe(authRequiredMessage(config));
  expect(msg).toContain('goose configure');
});

test('internal error with auth-ish text becomes actionable', () => {
  const msg = classifyAgentFailure(
    new AcpRpcError(-32603, 'Internal error'),
    'provider not configured',
    config,
  );
  expect(msg).toMatch(/sign-in|provider|configure/i);
  expect(msg).toContain('goose configure');
});

test('unrelated errors keep message + stderr tail', () => {
  const msg = classifyAgentFailure(new Error('boom'), 'stack line', {
    kind: 'acp',
    acpArgs: [],
  });
  expect(msg).toContain('boom');
  expect(msg).toContain('stack line');
});

test('auth-ish RPC wording without AUTH_REQUIRED still gets an unauth message', () => {
  const msg = classifyAgentFailure(new AcpRpcError(-32001, 'please sign in first'), '', config);
  expect(msg).toMatch(/unauthenticated|unconfigured/i);
  expect(msg).toContain('goose configure');
});

test('auth-ish text with acp rpc string (non-AcpRpcError) is classified', () => {
  const msg = classifyAgentFailure(new Error('acp rpc failed: login required'), 'not logged in', {
    kind: 'acp',
    acpArgs: [],
    label: 'Custom',
  });
  expect(msg).toMatch(/unauthenticated|unconfigured/i);
  expect(msg).toContain('not logged in');
});

test('authRequiredMessage omits hint when installHint is absent', () => {
  const msg = authRequiredMessage({ kind: 'gemini', acpArgs: ['--acp'], label: 'Gemini' });
  expect(msg).toContain('Gemini');
  expect(msg).toMatch(/isn’t signed in/);
  expect(msg).not.toMatch(/\.\s{2}/); // no dangling double space from empty hint
});

test('internal error without auth-ish text falls through to raw message', () => {
  const msg = classifyAgentFailure(new AcpRpcError(-32603, 'disk full'), 'ENOSPC', config);
  expect(msg).toContain('disk full');
  expect(msg).toContain('ENOSPC');
  expect(msg).not.toMatch(/sign-in|provider setup/i);
});
