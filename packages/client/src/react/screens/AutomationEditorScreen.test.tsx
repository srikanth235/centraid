import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationEditorBridgeProps, AutomationEditorData } from '../screen-contracts.js';
import AutomationEditorScreen from './AutomationEditorScreen.js';

function makeData(over: Partial<AutomationEditorData> = {}): AutomationEditorData {
  return {
    automationId: null,
    consent: { grants: [], outbox: [], parked: [] },
    enabled: false,
    instructions: '',
    mode: 'create',
    name: '',
    triggers: [],
    webhook: null,
    ...over,
  };
}

function makeProps(over: Partial<AutomationEditorBridgeProps> = {}): AutomationEditorBridgeProps {
  return {
    loadData: vi.fn().mockResolvedValue(makeData()),
    onCancel: vi.fn(),
    onCompile: vi.fn().mockResolvedValue(true),
    onCopyWebhook: vi.fn(),
    onDecideConsent: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(false),
    onOpenBuilder: vi.fn(),
    onOpenRun: vi.fn(),
    onReadSource: vi.fn().mockResolvedValue({ handler: null, manifest: null }),
    onRotateWebhook: vi.fn().mockResolvedValue(true),
    onRunNow: vi.fn().mockResolvedValue(true),
    onSearchEntities: vi.fn().mockResolvedValue([]),
    onSave: vi.fn().mockResolvedValue(true),
    onToggleEnabled: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function mount(props: AutomationEditorBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationEditorScreen {...props} />);
  });
  return container;
}

/** Set a controlled input/textarea's value through the native setter (so
 *  React's onChange listener fires), then dispatch `input` — the pattern
 *  PaletteScreen.test.tsx uses for the same reason. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el.tagName === 'TEXTAREA'
      ? globalThis.HTMLTextAreaElement.prototype
      : globalThis.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function tab(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll('[role="tab"]')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

/** Create layout: dashed "+ Add Trigger" → menu item (Schedule / Data change). */
async function addTrigger(el: HTMLElement, kind: 'Schedule' | 'Data change'): Promise<void> {
  await act(async () => {
    button(el, '+ Add Trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    const item = [...el.querySelectorAll('[role="menuitem"]')].find(
      (b) => b.textContent === kind,
    ) as HTMLButtonElement;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AutomationEditorScreen — create mode', () => {
  it('uses the full editor layout, keeps Create disabled until named, and saves cron', async () => {
    const props = makeProps();
    const el = await mount(props);

    // Same column layout as edit: head, Name, Instructions, Triggers, tabs.
    expect(el.querySelector('[data-mode="create"]')).toBeTruthy();
    expect(el.textContent).toContain('New Automation');
    expect(el.textContent).toContain('Draft');
    expect(el.textContent).toContain('Triggers');
    expect(el.textContent).toContain('Without a trigger, this only runs when you press Run now');
    // Connectors live on the Instructions toolbar, not as a bottom tab.
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Connectors')),
    ).toBe(true);
    expect(el.textContent).not.toContain('Behavior');
    expect(el.textContent).not.toContain('Model · Auto');
    expect(el.textContent).toContain('Notifications');
    expect(el.textContent).toContain('Plan');
    expect(el.textContent).not.toContain('Skills');
    // Bottom tabs are Notifications + Plan only.
    const tabLabels = [...el.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
    expect(tabLabels).toEqual(['Notifications', 'Plan']);
    // Create has no Run now / delete chrome.
    expect(
      [...el.querySelectorAll('button')].find((b) => b.textContent === 'Run now'),
    ).toBeUndefined();

    const nameInput = el.querySelector('input[placeholder="My Automation"]') as HTMLInputElement;
    const instructionsField = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(nameInput).toBeTruthy();
    expect(instructionsField).toBeTruthy();
    expect(instructionsField.placeholder).toMatch(/unread emails/i);

    const createBtn = button(el, 'Create automation');
    expect(createBtn.disabled).toBe(true);

    setValue(nameInput, 'Weekly digest');
    expect(createBtn.disabled).toBe(false);
    expect(el.textContent).toContain('Weekly digest');

    setValue(instructionsField, 'Summarize the week every Monday.');

    await addTrigger(el, 'Schedule');
    const cronCard = el.querySelector('[data-trigger-kind="cron"]');
    expect(cronCard).toBeTruthy();
    const cronInput = el.querySelector('input[placeholder="0 7 * * *"]') as HTMLInputElement;
    setValue(cronInput, '0 8 * * MON');

    // Notifications live in the same tab as edit (select, not a separate card).
    await act(async () =>
      tab(el, 'Notifications').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const notifySelect = el.querySelector(
      'select[aria-label="Notification preference"]',
    ) as HTMLSelectElement;
    expect(notifySelect).toBeTruthy();
    expect([...notifySelect.options].map((o) => o.textContent)).toEqual(['In the app', 'Off']);

    await act(async () =>
      button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(props.onSave).toHaveBeenCalledWith({
      connections: [],
      instructions: 'Summarize the week every Monday.',
      name: 'Weekly digest',
      triggers: [{ expr: '0 8 * * MON', kind: 'cron' }],
    });
    expect(props.onOpenBuilder).not.toHaveBeenCalled();
    expect(props.onCompile).toHaveBeenCalledWith(true);
  });

  it('only offers Schedule and Data change as addable triggers', async () => {
    const el = await mount(makeProps());
    await act(async () => {
      button(el, '+ Add Trigger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const items = [...el.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    expect(items).toEqual(['Schedule', 'Data change']);
  });

  it('searches vault entities after @ and inserts a stable token rendered as a chip', async () => {
    const onSearchEntities = vi
      .fn()
      .mockResolvedValue([
        { id: 'party-1', subtitle: 'person', title: 'Priya', type: 'core.party' },
      ]);
    const el = await mount(makeProps({ onSearchEntities }));
    const instructions = el.querySelector('textarea') as HTMLTextAreaElement;
    setValue(instructions, 'Send a reminder to @Pri');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(onSearchEntities).toHaveBeenCalledWith('Pri');
    expect(el.querySelector('[role="listbox"]')?.textContent).toContain('Priya');

    await act(async () => {
      (el.querySelector('[role="option"]') as HTMLButtonElement).click();
    });
    expect(instructions.value).toBe('Send a reminder to @[core.party/party-1]');
    expect(el.querySelector('[aria-label="Tagged data"]')?.textContent).toContain('party-1');
  });
});

describe('AutomationEditorScreen — edit mode', () => {
  function editData(over: Partial<AutomationEditorData> = {}): AutomationEditorData {
    return makeData({
      automationId: 'automation-a/x',
      connectors: {
        connector: null,
        mcps: ['weather'],
        secrets: [],
        vaultPurpose: null,
        vaultScopes: [],
      },
      enabled: true,
      instructions: 'Summarize yesterday’s new issues.',
      mode: 'edit',
      name: 'Daily issues',
      onFailure: null,
      rowId: 'row-a',
      triggers: [{ expr: '0 8 * * *', kind: 'cron' }],
      webhook: null,
      ...over,
    });
  }

  it('shows identity chrome, Run now, and saves name/instructions/triggers', async () => {
    const props = makeProps({ loadData: vi.fn().mockResolvedValue(editData()) });
    const el = await mount(props);

    expect(el.textContent).toContain('Daily issues');
    expect(el.textContent).toContain('Active');
    expect(button(el, 'Run now')).toBeTruthy();

    const nameInput = el.querySelector('input[placeholder="My Automation"]') as HTMLInputElement;
    setValue(nameInput, 'Daily issues v2');

    await act(async () =>
      button(el, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith({
      connections: [],
      instructions: 'Summarize yesterday’s new issues.',
      name: 'Daily issues v2',
      triggers: [{ expr: '0 8 * * *', kind: 'cron' }],
    });
  });

  it('edit: enable switch in head, Notifications onFailure, Connectors picker', async () => {
    const loadConnectorCatalog = vi.fn().mockResolvedValue([
      {
        allowedHosts: ['api.github.com'],
        authUrl: undefined,
        connection: null,
        credKind: 'api_key' as const,
        key: 'github:pull.github',
        kind: 'pull.github',
        name: 'GitHub',
        providerId: 'github',
        providerName: 'GitHub',
        setup: ['Create a PAT'],
        templateId: 'github-pull',
        tone: 'github',
      },
    ]);
    const props = makeProps({
      loadConnectorCatalog,
      loadData: vi.fn().mockResolvedValue(
        editData({
          connectors: {
            connector: 'pull.github',
            mcps: ['weather'],
            secrets: ['locker:@token:password'],
            vaultPurpose: 'dpv:ServiceProvision',
            vaultScopes: ['sync read+act'],
          },
          onFailure: 'automation-a/notify-owner',
        }),
      ),
    });
    const el = await mount(props);

    // Enable toggle moved out of the removed Behavior tab into the head.
    expect(el.querySelector('[role="switch"]')).toBeTruthy();
    expect(el.textContent).not.toContain('Writes park for your review');

    await act(async () =>
      tab(el, 'Notifications').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(el.textContent).toContain('automation-a/notify-owner');
    expect(el.querySelector('select[aria-label="Notification preference"]')).toBeTruthy();

    const connectorsBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Connectors'),
    ) as HTMLButtonElement;
    await act(async () => connectorsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(loadConnectorCatalog).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="automation-connectors-picker"]')?.textContent).toContain(
      'GitHub',
    );
    expect(el.textContent).toContain('API key');
  });

  it('load → durable connection bindings round-trip into onSave', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        editData({
          connectors: {
            connector: null,
            connections: [
              {
                connectionId: 'conn-load-1',
                kind: 'pull.github',
                label: 'GitHub · personal',
              },
            ],
            mcps: [],
            secrets: [],
            vaultPurpose: null,
            vaultScopes: [],
          },
        }),
      ),
    });
    const el = await mount(props);
    await act(async () =>
      button(el, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: [
          {
            connectionId: 'conn-load-1',
            kind: 'pull.github',
            label: 'GitHub · personal',
          },
        ],
      }),
    );
  });

  it('selecting a catalog row with a live connection binds connectionId on save', async () => {
    const loadConnectorCatalog = vi.fn().mockResolvedValue([
      {
        allowedHosts: ['api.github.com'],
        connection: {
          connectionId: 'conn-sel-9',
          health: 'ok' as const,
          label: 'GitHub · work',
        },
        credKind: 'api_key' as const,
        key: 'github:pull.github',
        kind: 'pull.github',
        name: 'GitHub',
        providerId: 'github',
        providerName: 'GitHub',
        setup: [],
        templateId: 'github-pull',
        tone: 'github',
      },
    ]);
    const props = makeProps({ loadConnectorCatalog });
    const el = await mount(props);
    setValue(el.querySelector('input[aria-label="Name"]') as HTMLInputElement, 'Bound auto');

    const connectorsBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Connectors'),
    ) as HTMLButtonElement;
    await act(async () => connectorsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    const main = el.querySelector(
      '[data-testid="automation-connectors-picker"] [data-kind="pull.github"] .connPickerMain',
    ) as HTMLButtonElement;
    await act(async () => main.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () =>
      button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: [
          {
            connectionId: 'conn-sel-9',
            kind: 'pull.github',
            label: 'GitHub · work',
          },
        ],
        name: 'Bound auto',
      }),
    );
  });

  it('Connect form success binds configureConnection connectionId into onSave', async () => {
    const base = {
      allowedHosts: ['api.github.com'],
      credKind: 'api_key' as const,
      key: 'github:pull.github',
      kind: 'pull.github',
      name: 'GitHub',
      providerId: 'github',
      providerName: 'GitHub',
      setup: [] as string[],
      templateId: 'github-pull',
      tone: 'github',
    };
    const configureConnection = vi.fn().mockResolvedValue({ connectionId: 'conn-new-42' });
    const loadConnectorCatalog = vi
      .fn()
      .mockResolvedValueOnce([{ ...base, connection: null }])
      .mockResolvedValue([
        {
          ...base,
          connection: { connectionId: 'conn-new-42', health: 'ok' as const, label: 'GitHub' },
        },
      ]);
    const props = makeProps({ configureConnection, loadConnectorCatalog });
    const el = await mount(props);
    setValue(el.querySelector('input[aria-label="Name"]') as HTMLInputElement, 'After connect');
    const open = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Connectors'),
    ) as HTMLButtonElement;
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () =>
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent === 'Connect')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const apiKey = [
      ...(el
        .querySelector('[data-testid="automation-connectors-picker"]')
        ?.querySelectorAll('input') ?? []),
    ].find((i) => (i as HTMLInputElement).type === 'password') as HTMLInputElement | undefined;
    expect(apiKey).toBeTruthy();
    setValue(apiKey!, 'ghp_test_token');
    const formSubmit = [...el.querySelectorAll('button')].find(
      (b) =>
        b.textContent === 'Save connection' ||
        b.textContent === 'Authorize & save' ||
        b.textContent === 'Save',
    );
    await act(async () => formSubmit?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(configureConnection).toHaveBeenCalled();
    await act(async () =>
      button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: [
          expect.objectContaining({ connectionId: 'conn-new-42', kind: 'pull.github' }),
        ],
        name: 'After connect',
      }),
    );
  });
});
