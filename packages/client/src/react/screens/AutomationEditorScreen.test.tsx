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

describe('AutomationEditorScreen — create mode', () => {
  it('renders Name/Instructions, keeps Create disabled until named, and saves the assembled trigger shape', async () => {
    const props = makeProps();
    const el = await mount(props);

    const nameInput = el.querySelector(
      'input[placeholder="Untitled automation"]',
    ) as HTMLInputElement;
    const instructionsField = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(nameInput).toBeTruthy();
    expect(instructionsField).toBeTruthy();

    const createBtn = button(el, 'Create automation');
    expect(createBtn.disabled).toBe(true);

    setValue(nameInput, 'Weekly digest');
    expect(createBtn.disabled).toBe(false);

    setValue(instructionsField, 'Summarize the week every Monday.');

    // Add a schedule without collapsing any existing triggers.
    await act(async () =>
      button(el, '+ Schedule').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const cronCard = el.querySelector('[data-trigger-kind="cron"]');
    expect(cronCard).toBeTruthy();
    const cronInput = el.querySelector('input[placeholder="0 7 * * *"]') as HTMLInputElement;
    setValue(cronInput, '0 8 * * MON');

    // Tabs switch: Behavior in create mode is explainer-only, no toggle.
    await act(async () =>
      tab(el, 'Behavior').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(el.textContent).toContain('Writes park for your review');
    expect(el.querySelector('[role="switch"]')).toBeNull();
    await act(async () =>
      tab(el, 'Connectors').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(el.textContent).toContain(
      'Connectors and vault scopes are declared when the plan is compiled.',
    );

    await act(async () =>
      button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(props.onSave).toHaveBeenCalledWith({
      instructions: 'Summarize the week every Monday.',
      name: 'Weekly digest',
      triggers: [{ expr: '0 8 * * MON', kind: 'cron' }],
    });
    expect(props.onOpenBuilder).not.toHaveBeenCalled();
    expect(props.onCompile).toHaveBeenCalledWith(true);
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
        tools: [],
        vaultPurpose: null,
        vaultScopes: [],
      },
      enabled: true,
      instructions: 'Summarize yesterday’s new issues.',
      mode: 'edit',
      model: null,
      name: 'Daily Digest',
      onFailure: null,
      rowId: 'x',
      triggers: [{ expr: '0 8 * * *', kind: 'cron' }],
      webhook: null,
      ...over,
    });
  }

  it('prefills from the DTO, shows the header + enabled toggle + standing grants', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        editData({
          consent: {
            grants: [
              {
                createdAt: '2026-07-01T00:00:00Z',
                grantId: 'g1',
                revokedAt: null,
                target: 'gmail.send',
                verb: 'send',
              },
            ],
            outbox: [],
            parked: [],
          },
        }),
      ),
    });
    const el = await mount(props);

    expect(
      (el.querySelector('input[placeholder="Untitled automation"]') as HTMLInputElement).value,
    ).toBe('Daily Digest');
    expect(
      el.querySelector('textarea')?.textContent ??
        (el.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toContain('Summarize');
    expect(el.textContent).toContain('Daily Digest');
    expect(el.textContent).toContain('Active');
    expect(el.querySelector('[data-trigger-kind="cron"]')).toBeTruthy();

    await act(async () =>
      tab(el, 'Behavior').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const toggle = el.querySelector('[role="switch"]') as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    expect(el.textContent).toContain('gmail.send');

    await act(async () =>
      button(el, 'Revoke').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onDecideConsent).toHaveBeenCalledWith('grant', 'g1', 'revoke');
  });

  it('saves changed fields and starts a hidden compile when Instructions changed', async () => {
    const props = makeProps({ loadData: vi.fn().mockResolvedValue(editData()) });
    const el = await mount(props);

    expect(el.textContent).not.toContain('Recompile plan');

    const instructionsField = el.querySelector('textarea') as HTMLTextAreaElement;
    setValue(instructionsField, 'Summarize yesterday’s new issues, then post to Slack.');

    await act(async () =>
      button(el, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(props.onSave).toHaveBeenCalledWith({
      instructions: 'Summarize yesterday’s new issues, then post to Slack.',
      name: 'Daily Digest',
      triggers: [{ expr: '0 8 * * *', kind: 'cron' }],
    });
    // The builder callback remains in the contract but is hidden in v0.
    expect(props.onOpenBuilder).not.toHaveBeenCalled();
    expect(props.onCompile).toHaveBeenCalledWith(false);
    expect(el.textContent).not.toContain('Recompile plan');
  });

  it('does not show Recompile plan after a save with unchanged Instructions', async () => {
    const props = makeProps({ loadData: vi.fn().mockResolvedValue(editData()) });
    const el = await mount(props);

    const nameInput = el.querySelector(
      'input[placeholder="Untitled automation"]',
    ) as HTMLInputElement;
    setValue(nameInput, 'Daily Digest v2');

    await act(async () =>
      button(el, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: 'Summarize yesterday’s new issues.',
        name: 'Daily Digest v2',
      }),
    );
    expect(el.textContent).not.toContain('Recompile plan');
  });

  it('preserves and edits every loaded trigger, including condition where', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        editData({
          triggers: [
            { expr: '0 8 * * *', kind: 'cron' },
            {
              entity: 'core.event',
              every: '*/5 * * * *',
              kind: 'condition',
              where: [{ column: 'status', op: 'eq', value: 'open' }],
            },
            { entities: ['core.party'], kind: 'data' },
          ],
        }),
      ),
    });
    const el = await mount(props);
    expect(el.querySelectorAll('[data-trigger-kind]').length).toBe(3);
    expect(button(el, '+ Webhook').disabled).toBe(false);

    const where = el.querySelector('input[placeholder^="[{"]') as HTMLInputElement;
    setValue(where, '[{"column":"status","op":"eq","value":"closed"}]');
    await act(async () =>
      button(el, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(props.onSave).toHaveBeenCalledWith({
      instructions: 'Summarize yesterday’s new issues.',
      name: 'Daily Digest',
      triggers: [
        { expr: '0 8 * * *', kind: 'cron' },
        {
          entity: 'core.event',
          every: '*/5 * * * *',
          kind: 'condition',
          where: [{ column: 'status', op: 'eq', value: 'closed' }],
        },
        { entities: ['core.party'], kind: 'data' },
      ],
    });
  });

  it('renders Connectors chips and the Notifications onFailure line from the DTO', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        editData({
          connectors: {
            connector: 'Gmail',
            mcps: ['weather'],
            secrets: ['locker:@slack-token:value'],
            tools: ['fetch'],
            vaultPurpose: 'Draft the digest',
            vaultScopes: ['core.event read'],
          },
          model: 'anthropic/claude-3-5-sonnet',
          onFailure: 'automation-a/notify-owner',
        }),
      ),
    });
    const el = await mount(props);

    await act(async () =>
      tab(el, 'Connectors').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(el.textContent).toContain('weather');
    expect(el.textContent).toContain('Gmail');
    expect(el.textContent).toContain('core.event read');
    expect(el.textContent).toContain('Draft the digest');

    await act(async () =>
      tab(el, 'Notifications').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(el.textContent).toContain('On failure, runs');
    expect(el.textContent).toContain('automation-a/notify-owner');
    expect(el.textContent).toContain('Plan runs on');
    expect(el.textContent).toContain('anthropic/claude-3-5-sonnet');
  });

  it('shows the empty state when Connectors has nothing declared', async () => {
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        editData({
          connectors: {
            connector: null,
            mcps: [],
            secrets: [],
            tools: [],
            vaultPurpose: null,
            vaultScopes: [],
          },
        }),
      ),
    });
    const el = await mount(props);

    await act(async () =>
      tab(el, 'Connectors').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(el.textContent).toContain('Nothing declared yet');
  });

  it('cancels back out via onCancel', async () => {
    const props = makeProps({ loadData: vi.fn().mockResolvedValue(editData()) });
    const el = await mount(props);
    await act(async () =>
      button(el, 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onCancel).toHaveBeenCalled();
  });
});
