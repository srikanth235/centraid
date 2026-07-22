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
