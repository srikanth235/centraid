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
    onCopyWebhook: vi.fn(),
    onDecideConsent: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(false),
    onOpenBuilder: vi.fn(),
    onOpenRun: vi.fn(),
    onRotateWebhook: vi.fn().mockResolvedValue(true),
    onRunNow: vi.fn().mockResolvedValue(true),
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

function radio(el: HTMLElement, name: string): HTMLButtonElement {
  return [...el.querySelectorAll('[role="radio"]')].find(
    (b) => b.getAttribute('aria-label') === name,
  ) as HTMLButtonElement;
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

    // Select the Schedule trigger card — a role=radio card named "Schedule".
    await act(async () =>
      radio(el, 'Schedule').dispatchEvent(new MouseEvent('click', { bubbles: true })),
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
    // Create mode always hands off to the builder to compile the plan — the
    // seed is a framed compile work order carrying the instructions verbatim.
    expect(props.onOpenBuilder).toHaveBeenCalledTimes(1);
    const seed = (props.onOpenBuilder as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(seed.startsWith('Compile this automation now')).toBe(true);
    expect(seed).toContain('Summarize the week every Monday.');
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

  it('saves changed fields and reveals Recompile plan only when Instructions changed', async () => {
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
    // A successful save in create mode hands off to the builder immediately;
    // in edit mode with changed instructions it instead surfaces the
    // opt-in "Recompile plan" affirmative action.
    expect(props.onOpenBuilder).not.toHaveBeenCalled();
    expect(button(el, 'Recompile plan')).toBeTruthy();

    await act(async () =>
      button(el, 'Recompile plan').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onOpenBuilder).toHaveBeenCalledWith(
      'My instructions changed. Recompile the handler to match:\n\n' +
        'Summarize yesterday’s new issues, then post to Slack.',
    );
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
