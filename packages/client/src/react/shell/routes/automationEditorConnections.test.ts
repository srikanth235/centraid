import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRowDTO } from '../../screens/SettingsConnectionsScreen.js';
import { matchEditorConnection } from './AutomationEditorRoute.js';

vi.mock('../../../gateway-client.js', () => ({}));
vi.mock('../../../assist-oauth-handoff.js', () => ({}));

function row(over: Partial<ConnectionRowDTO>): ConnectionRowDTO {
  return {
    authNote: null,
    connectionId: 'connection-1',
    credKind: 'api_key',
    health: 'ok',
    kind: 'pull.github',
    label: 'GitHub · personal',
    lastRunAt: null,
    principal: 'octocat',
    provider: 'github',
    ...over,
  };
}

describe('matchEditorConnection', () => {
  it('requires an exact provider as well as connector kind', () => {
    const result = matchEditorConnection(
      [row({ provider: 'attacker-provider' })],
      'github',
      'pull.github',
    );
    expect(result).toEqual({ match: null, ambiguous: false });
  });

  it('refuses to guess between multiple accounts', () => {
    const result = matchEditorConnection(
      [
        row({ connectionId: 'personal', label: 'GitHub · personal' }),
        row({ connectionId: 'work', label: 'GitHub · work' }),
      ],
      'github',
      'pull.github',
    );
    expect(result).toEqual({ match: null, ambiguous: true });
  });
});
