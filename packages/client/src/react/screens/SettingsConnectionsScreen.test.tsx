import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsConnectionsScreen, {
  type ConnectionRowDTO,
  type ProviderOptionDTO,
  type SettingsConnectionsBridgeProps,
} from './SettingsConnectionsScreen.js';

function makeRow(over: Partial<ConnectionRowDTO> = {}): ConnectionRowDTO {
  return {
    authNote: null,
    connectionId: 'c1',
    credKind: 'oauth2',
    health: 'needs-auth',
    kind: 'pull.gmail',
    label: 'Google · Gmail',
    lastRunAt: null,
    principal: null,
    provider: 'google',
    ...over,
  };
}

function makeProvider(over: Partial<ProviderOptionDTO> = {}): ProviderOptionDTO {
  return {
    allowedHosts: ['gmail.googleapis.com'],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    capabilities: {
      actions: [
        {
          id: 'action:list:pull.gmail',
          kind: 'pull.gmail',
          title: 'List Gmail',
          toolName: 'connector.pull_gmail.list',
        },
      ],
      syncs: [
        {
          defaultCron: '0 * * * *',
          id: 'sync:google-gmail-pull',
          kind: 'pull.gmail',
          templateId: 'google-gmail-pull',
          title: 'Gmail sync',
        },
      ],
    },
    connectors: [
      { kind: 'pull.gmail', scope: 'gmail.readonly', templateId: 'google-gmail-pull' },
      { kind: 'pull.gcal', scope: 'calendar.readonly', templateId: 'google-calendar-pull' },
    ],
    credKind: 'oauth2',
    id: 'google',
    name: 'Google (Gmail, Calendar, Contacts, Drive)',
    scopes: 'gmail.readonly calendar.readonly',
    setup: ['Open https://console.cloud.google.com and create a project.'],
    tokenUrl: 'https://oauth2.googleapis.com/token',
    ...over,
  };
}

function makeProps(
  over: Partial<SettingsConnectionsBridgeProps> = {},
): SettingsConnectionsBridgeProps {
  return {
    beginAuthorize: vi.fn().mockResolvedValue('https://accounts.google.com/authorize?state=s1'),
    configureConnection: vi.fn().mockResolvedValue({ connectionId: 'c-new', status: 'needs-auth' }),
    detachConnection: vi.fn().mockResolvedValue(undefined),
    loadConnections: vi.fn().mockResolvedValue([makeRow()]),
    loadOAuthCallbackUri: vi
      .fn()
      .mockResolvedValue('http://127.0.0.1:17832/centraid/_vault/oauth/callback'),
    loadProviders: vi.fn().mockResolvedValue([makeProvider()]),
    setConnectionStatus: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function mount(props: SettingsConnectionsBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsConnectionsScreen {...props} />);
  });
  // Connections + providers load in effects
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe('SettingsConnectionsScreen', () => {
  it('renders gallery chrome, connected rows, and featured tiles', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('Connectors');
    expect(el.textContent).toContain('Featured');
    expect(el.textContent).toMatch(/connections/i);
    expect(el.querySelectorAll('[data-testid="connector-row"]').length).toBe(1);
    expect(el.textContent).toContain('Google · Gmail');
    expect(el.textContent).toContain('Needs authorization');
    // Featured tiles from provider connectors
    expect(el.querySelectorAll('[data-testid="connector-tile"]').length).toBeGreaterThanOrEqual(1);
    expect(el.textContent).toContain('Gmail');
    expect(el.textContent).toContain('Google Calendar');
  });

  it('shows empty connected state when there are no connections', async () => {
    const el = await mount(makeProps({ loadConnections: vi.fn().mockResolvedValue([]) }));
    expect(el.textContent).toContain('No connectors configured yet');
  });

  it('opens the authorize URL via Reconnect and refreshes the list', async () => {
    const props = makeProps();
    const el = await mount(props);
    expect(el.textContent).toContain('needs attention');
    const reconnectBtn = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Reconnect',
    );
    await act(async () => reconnectBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    expect(props.beginAuthorize).toHaveBeenCalledWith('c1');
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/authorize?state=s1',
      '_blank',
      'noopener',
    );
  });

  it('pauses an active connection', async () => {
    const props = makeProps({
      loadConnections: vi.fn().mockResolvedValue([makeRow({ health: 'ok' })]),
    });
    const el = await mount(props);
    const pauseBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Pause');
    await act(async () => pauseBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.setConnectionStatus).toHaveBeenCalledWith('c1', 'paused');
  });

  it('removes a connection via Remove', async () => {
    const props = makeProps();
    const el = await mount(props);
    const removeBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
    await act(async () => removeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.detachConnection).toHaveBeenCalledWith('c1', 'pull.gmail', 'Google · Gmail');
  });

  it('shows Remove even for a connection with no credential (harness-ambient lane)', async () => {
    const el = await mount(
      makeProps({ loadConnections: vi.fn().mockResolvedValue([makeRow({ credKind: null })]) }),
    );
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Remove');
  });

  it('surfaces the server refusal as a toast when Remove is refused', async () => {
    const props = makeProps({
      detachConnection: vi
        .fn()
        .mockRejectedValue(new Error('has 2 outbox item(s) still awaiting a decision')),
    });
    const el = await mount(props);
    const removeBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
    await act(async () => removeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    expect(props.showToast).toHaveBeenCalledWith(expect.stringContaining('awaiting a decision'));
  });

  it('opens a featured tile into the detail sheet, then OAuth 2.0 form + authorize', async () => {
    const props = makeProps({ loadConnections: vi.fn().mockResolvedValue([]) });
    const el = await mount(props);
    const gmailTile = [...el.querySelectorAll('[data-testid="connector-tile"]')].find((b) =>
      b.textContent?.includes('Gmail'),
    );
    expect(gmailTile).toBeTruthy();
    expect(gmailTile?.textContent).toContain('OAuth 2.0');
    await act(async () => gmailTile?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const sheet = el.querySelector('[data-testid="connector-sheet"]');
    expect(sheet).toBeTruthy();
    expect(sheet?.textContent).toContain('About this Connector');
    expect(sheet?.querySelector('[data-testid="connector-auth-kind"]')?.textContent).toContain(
      'OAuth 2.0',
    );

    const connectBtn = [...(sheet?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Connect with OAuth 2.0'),
    );
    await act(async () => connectBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('[data-testid="connector-wizard"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="oauth-redirect-uri"]')).toBeTruthy();
    expect(el.textContent).toContain('Client ID');
    expect(el.textContent).toContain('Client secret');

    const fieldInput = (labelText: string): HTMLInputElement | null => {
      const labels = [...el.querySelectorAll('label')].find((l) =>
        l.textContent?.includes(labelText),
      );
      return labels?.querySelector('input') ?? null;
    };
    const idInput = fieldInput('Client ID');
    const secretInput = fieldInput('Client secret');

    const setNativeValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      if (idInput) setNativeValue(idInput, 'my-client-id');
      if (secretInput) setNativeValue(secretInput, 'my-client-secret');
    });

    const saveBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Save & authorize'),
    );
    expect(saveBtn?.hasAttribute('disabled')).toBe(false);
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(props.configureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'my-client-id',
        clientSecret: 'my-client-secret',
        connectorKind: 'pull.gmail',
        credKind: 'oauth2',
        providerId: 'google',
      }),
    );
    // OAuth2 must open the provider consent screen after save.
    expect(props.beginAuthorize).toHaveBeenCalledWith('c-new');
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/authorize?state=s1',
      '_blank',
      'noopener',
    );
  });

  it('makes Centraid Assist primary, scopes it to the selected connector, and keeps BYO advanced', async () => {
    const calendarScope = 'https://www.googleapis.com/auth/calendar.readonly';
    const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
    const props = makeProps({
      loadConnections: vi.fn().mockResolvedValue([]),
      loadProviders: vi.fn().mockResolvedValue([
        makeProvider({
          assist: {
            callbackUrl: 'https://oauth.centraid.dev/callback',
            enabled: true,
            provider: 'google',
            restrictedScopesEnabled: false,
            scopeTiers: {
              restricted: [gmailScope],
              standard: [calendarScope],
            },
          },
          connectors: [
            {
              kind: 'pull.gmail',
              scope: gmailScope,
              templateId: 'google-gmail-pull',
            },
            {
              kind: 'pull.gcal',
              scope: calendarScope,
              templateId: 'google-calendar-pull',
            },
          ],
        }),
      ]),
    });
    const el = await mount(props);
    const calendarTile = [...el.querySelectorAll('[data-testid="connector-tile"]')].find((tile) =>
      tile.textContent?.includes('Google Calendar'),
    );
    await act(async () => calendarTile?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.textContent).toContain('Connect with Centraid');
    expect(el.textContent).toContain('Use my own OAuth app (Advanced)');

    const assistButton = [...el.querySelectorAll('button')].find(
      (button) => button.textContent === 'Connect with Centraid',
    );
    await act(async () => assistButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const wizard = el.querySelector('[data-testid="connector-assist-wizard"]');
    expect(wizard?.textContent).toContain('Read Google Calendar');
    expect(wizard?.textContent).not.toContain('Read Gmail');
    expect(wizard?.textContent).toContain('does not request Google identity scopes');

    const continueButton = [...(wizard?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Continue to Google',
    );
    expect(continueButton?.hasAttribute('disabled')).toBe(false);
    await act(async () =>
      continueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(props.configureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorKind: 'pull.gcal',
        oauthMode: 'assist',
        scopes: calendarScope,
      }),
    );
    expect(props.beginAuthorize).toHaveBeenCalledWith('c-new');
  });

  it('fail-closes restricted Assist scopes until verification is enabled', async () => {
    const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
    const el = await mount(
      makeProps({
        loadConnections: vi.fn().mockResolvedValue([]),
        loadProviders: vi.fn().mockResolvedValue([
          makeProvider({
            assist: {
              callbackUrl: 'https://oauth.centraid.dev/callback',
              enabled: true,
              provider: 'google',
              restrictedScopesEnabled: false,
              scopeTiers: { restricted: [gmailScope], standard: [] },
            },
            connectors: [
              {
                kind: 'pull.gmail',
                scope: gmailScope,
                templateId: 'google-gmail-pull',
              },
            ],
          }),
        ]),
      }),
    );
    const gmailTile = [...el.querySelectorAll('[data-testid="connector-tile"]')].find((tile) =>
      tile.textContent?.includes('Gmail'),
    );
    await act(async () => gmailTile?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const assistButton = [...el.querySelectorAll('button')].find(
      (button) => button.textContent === 'Connect with Centraid',
    );
    await act(async () => assistButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const wizard = el.querySelector('[data-testid="connector-assist-wizard"]');
    const checkbox = wizard?.querySelector('input[type="checkbox"]');
    const continueButton = [...(wizard?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Continue to Google',
    );
    expect(checkbox?.hasAttribute('disabled')).toBe(true);
    expect(continueButton?.hasAttribute('disabled')).toBe(true);
    expect(wizard?.textContent).toContain('until Google restricted-scope verification is complete');
  });

  it('New Connector opens the picker sheet', async () => {
    const el = await mount(makeProps({ loadConnections: vi.fn().mockResolvedValue([]) }));
    const newBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('New Connector'),
    );
    await act(async () => newBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const sheet = el.querySelector('[data-testid="connector-sheet"]');
    expect(sheet?.textContent).toContain('New Connector');
    expect(sheet?.textContent).toContain('Choose a data source');
    expect(sheet?.textContent).toContain('Gmail');
  });
});
