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
    connectors: [{ kind: 'pull.gmail', scope: 'gmail.readonly', templateId: 'google-gmail-pull' }],
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
    configureConnection: vi.fn().mockResolvedValue(undefined),
    detachConnection: vi.fn().mockResolvedValue(undefined),
    loadConnections: vi.fn().mockResolvedValue([makeRow()]),
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
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('SettingsConnectionsScreen', () => {
  it('renders a connection row with its health + an Authorize action for a needs-auth oauth2 row', async () => {
    const el = await mount(makeProps());
    expect(el.querySelectorAll('.row').length).toBe(1);
    expect(el.textContent).toContain('Google · Gmail');
    expect(el.textContent).toContain('Needs authorization');
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Authorize');
    expect(buttons).toContain('Pause');
    expect(buttons).toContain('Remove');
  });

  it('shows the empty state when there are no connections', async () => {
    const el = await mount(makeProps({ loadConnections: vi.fn().mockResolvedValue([]) }));
    expect(el.querySelector('.empty')).toBeTruthy();
    expect(el.textContent).toContain('No connections configured yet.');
  });

  it('opens the authorize URL and refreshes the list', async () => {
    const props = makeProps();
    const el = await mount(props);
    const authorizeBtn = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Authorize',
    );
    await act(async () => authorizeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
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

  it('opens the add-connection wizard and submits a new oauth2 connection', async () => {
    const props = makeProps();
    const el = await mount(props);
    const addBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Add connection'),
    );
    await act(async () => addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });

    expect(el.querySelector('.wizard')).toBeTruthy();
    // Both the Label and Client ID fields are `type="text"` — find each
    // input by its own `.wizardField` label text rather than by type/order.
    const fieldInput = (labelText: string): HTMLInputElement | null => {
      const field = [...el.querySelectorAll('.wizardField')].find((f) =>
        f.querySelector('.wizardLabel')?.textContent?.includes(labelText),
      );
      return field?.querySelector('input') ?? null;
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

    const saveBtn = [...el.querySelectorAll('.wizard button')].find((b) =>
      b.textContent?.includes('Save connection'),
    );
    expect(saveBtn?.hasAttribute('disabled')).toBe(false);
    await act(async () => saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(props.configureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'my-client-id',
        clientSecret: 'my-client-secret',
        connectorKind: 'pull.gmail',
        credKind: 'oauth2',
        providerId: 'google',
      }),
    );
  });
});
