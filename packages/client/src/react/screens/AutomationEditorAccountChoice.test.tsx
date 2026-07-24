import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutomationEditorBridgeProps, AutomationEditorData } from '../screen-contracts.js';
import AutomationEditorScreen from './AutomationEditorScreen.js';

function makeData(): AutomationEditorData {
  return {
    automationId: null,
    consent: { grants: [], outbox: [], parked: [] },
    enabled: false,
    instructions: '',
    mode: 'create',
    name: '',
    triggers: [],
    webhook: null,
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

function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement;
}

it('chooses among configured accounts inline and preserves the explicit binding on refresh', async () => {
  const account = (connectionId: string, label: string, principal: string) => ({
    connectionId,
    health: 'ok' as const,
    label,
    principal,
  });
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
  const personal = account('conn-personal', 'GitHub · personal', 'personal@example.com');
  const work = account('conn-work', 'GitHub · work', 'work@example.com');
  const loadConnectorCatalog = vi
    .fn()
    .mockResolvedValueOnce([{ ...base, connection: null, connections: [personal, work] }])
    .mockResolvedValue([{ ...base, connection: personal, connections: [personal] }]);
  const props = makeProps({ loadConnectorCatalog });
  const el = await mount(props);
  setValue(el.querySelector('input[aria-label="Name"]') as HTMLInputElement, 'Account picker');

  const connectorsButton = [...el.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Connectors'),
  ) as HTMLButtonElement;
  await act(async () => connectorsButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => Promise.resolve());

  const picker = el.querySelector('[data-testid="automation-connectors-picker"]');
  expect(picker?.textContent).toContain('2 configured accounts');
  expect(picker?.textContent).toContain('personal@example.com');
  expect(picker?.textContent).toContain('work@example.com');
  const workButton = picker?.querySelector('[data-connection-id="conn-work"]') as HTMLButtonElement;
  await act(async () => workButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  await act(async () => connectorsButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => connectorsButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => Promise.resolve());

  await act(async () =>
    button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      connections: [
        {
          connectionId: 'conn-work',
          kind: 'pull.github',
          label: 'GitHub · work',
        },
      ],
    }),
  );
});
