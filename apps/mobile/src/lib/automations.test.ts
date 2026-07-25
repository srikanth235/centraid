import { beforeEach, expect, test, vi } from 'vitest';
import { runAutomation } from './automations';

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock('./gateway', () => ({
  authHeader: () => ({ authorization: 'Bearer paired' }),
  fetchJson,
  requireGatewayBase: async () => 'https://gateway.example',
}));

beforeEach(() => {
  fetchJson.mockReset();
});

test('runAutomation consumes the native turnId response contract', async () => {
  fetchJson.mockResolvedValue({ turnId: 'brief/main:manual:1' });
  await expect(runAutomation('brief/main')).resolves.toBe('brief/main:manual:1');
  expect(fetchJson).toHaveBeenCalledWith(
    'https://gateway.example/centraid/_automations/turn-now?ref=brief%2Fmain',
    {
      headers: { authorization: 'Bearer paired' },
      method: 'POST',
    },
  );
});
