import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationEditorBridgeProps, AutomationEditorData } from '../screen-contracts.js';
import AutomationEditorScreen from './AutomationEditorScreen.js';

// Data trigger authoring coverage for AutomationEditorScreen. Create form
// only adds Schedule (cron) and Data change — condition/webhook stay
// editable when already present on a loaded automation.

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

function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLSelectElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function keydown(el: HTMLElement, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

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

describe('AutomationEditorScreen — authoring data triggers', () => {
  async function mountNamed(over: Partial<AutomationEditorBridgeProps> = {}): Promise<{
    el: HTMLDivElement;
    props: AutomationEditorBridgeProps;
  }> {
    const props = makeProps(over);
    const el = await mount(props);
    setValue(el.querySelector('input[placeholder="My Automation"]') as HTMLInputElement, 'A');
    return { el, props };
  }

  it('serializes a data trigger — entities split/trimmed, blank every omitted', async () => {
    const { el, props } = await mountNamed();
    await addTrigger(el, 'Data change');
    setValue(
      el.querySelector(
        'input[placeholder="core.transaction, billing.invoice"]',
      ) as HTMLInputElement,
      '  core.transaction , billing.invoice ,',
    );
    await act(async () =>
      button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith({
      connections: [],
      instructions: '',
      name: 'A',
      triggers: [{ entities: ['core.transaction', 'billing.invoice'], kind: 'data' }],
    });
  });

  it('skips an empty-entities data trigger', async () => {
    const { el, props } = await mountNamed();
    await addTrigger(el, 'Data change');
    await act(async () =>
      button(el, 'Create automation').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith({
      connections: [],
      instructions: '',
      name: 'A',
      triggers: [],
    });
  });

  it('serializes a loaded condition trigger with per-op coerced where values + every', async () => {
    // Condition is no longer addable from the form; authoring still works for
    // automations that already carry a condition trigger.
    const props = makeProps({
      loadData: vi.fn().mockResolvedValue(
        makeData({
          automationId: 'a/x',
          mode: 'edit',
          name: 'A',
          rowId: 'r1',
          triggers: [{ entity: 'business.invoice', kind: 'condition', where: [] }],
        }),
      ),
    });
    const el = await mount(props);

    const addFilter = (): Promise<void> =>
      act(async () => {
        button(el, '+ Add filter').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    const cols = (): HTMLInputElement[] =>
      [...el.querySelectorAll('input[aria-label="Filter column"]')] as HTMLInputElement[];
    const ops = (): HTMLSelectElement[] =>
      [...el.querySelectorAll('select[aria-label="Filter operator"]')] as HTMLSelectElement[];
    const vals = (): HTMLInputElement[] =>
      [...el.querySelectorAll('input[aria-label="Filter value"]')] as HTMLInputElement[];

    await addFilter();
    setValue(cols()[0]!, 'status');
    setValue(vals()[0]!, 'open');

    await addFilter();
    setValue(cols()[1]!, 'priority');
    setSelect(ops()[1]!, 'in');
    setValue(vals()[1]!, '1, 2, 3');

    await addFilter();
    setValue(cols()[2]!, 'due');
    setSelect(ops()[2]!, 'within-next-days');
    setValue(vals()[2]!, '7');

    await addFilter();
    setValue(cols()[3]!, 'closed_at');
    setSelect(ops()[3]!, 'not-null');
    expect(vals().length).toBe(3);

    setValue(
      el.querySelector('input[placeholder="*/5 * * * *"]') as HTMLInputElement,
      '*/10 * * * *',
    );

    await act(async () =>
      button(el, 'Save changes').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(props.onSave).toHaveBeenCalledWith({
      connections: [],
      instructions: '',
      name: 'A',
      triggers: [
        {
          entity: 'business.invoice',
          every: '*/10 * * * *',
          kind: 'condition',
          where: [
            { column: 'status', op: 'eq', value: 'open' },
            { column: 'priority', op: 'in', value: [1, 2, 3] },
            { column: 'due', op: 'within-next-days', value: 7 },
            { column: 'closed_at', op: 'not-null' },
          ],
        },
      ],
    });
  });

  const KINDS = ['core.transaction', 'core.event', 'billing.invoice'];

  async function mountWithDataTrigger(loadEntityTypes: ReturnType<typeof vi.fn>): Promise<{
    el: HTMLDivElement;
    input: HTMLInputElement;
  }> {
    const { el } = await mountNamed({ loadEntityTypes });
    await addTrigger(el, 'Data change');
    await act(async () => {
      await Promise.resolve();
    });
    const input = el.querySelector(
      'input[placeholder="core.transaction, billing.invoice"]',
    ) as HTMLInputElement;
    return { el, input };
  }

  const optionLabels = (el: HTMLElement): string[] =>
    [...el.querySelectorAll('[role="option"] span')].map((s) => s.textContent ?? '');

  it('fetches entity kinds lazily the first time a data trigger appears', async () => {
    const loadEntityTypes = vi.fn().mockResolvedValue(KINDS);
    const { el } = await mountNamed({ loadEntityTypes });
    expect(loadEntityTypes).not.toHaveBeenCalled();
    await addTrigger(el, 'Data change');
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadEntityTypes).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters kinds client-side as the user types, capped to the query', async () => {
    const loadEntityTypes = vi.fn().mockResolvedValue(KINDS);
    const { el, input } = await mountWithDataTrigger(loadEntityTypes);
    setValue(input, 'core');
    expect(optionLabels(el)).toEqual(['core.transaction', 'core.event']);
    setValue(input, 'bill');
    expect(optionLabels(el)).toEqual(['billing.invoice']);
  });

  it('keyboard-navigates and accepts a kind into the input (Enter)', async () => {
    const loadEntityTypes = vi.fn().mockResolvedValue(KINDS);
    const { el, input } = await mountWithDataTrigger(loadEntityTypes);
    setValue(input, 'core');
    keydown(input, 'ArrowDown');
    keydown(input, 'Enter');
    expect(input.value).toBe('core.event');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('Escape dismisses the picker without changing the input', async () => {
    const loadEntityTypes = vi.fn().mockResolvedValue(KINDS);
    const { el, input } = await mountWithDataTrigger(loadEntityTypes);
    setValue(input, 'core');
    expect(el.querySelector('[role="listbox"]')).not.toBeNull();
    keydown(input, 'Escape');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(input.value).toBe('core');
  });

  it('completes only the trailing comma segment for the data input', async () => {
    const loadEntityTypes = vi.fn().mockResolvedValue(KINDS);
    const { input } = await mountWithDataTrigger(loadEntityTypes);
    setValue(input, 'core.transaction, bill');
    keydown(input, 'Enter');
    expect(input.value).toBe('core.transaction, billing.invoice');
  });

  it('accepts a kind by click for a loaded condition entity input', async () => {
    const loadEntityTypes = vi.fn().mockResolvedValue(KINDS);
    const el = await mount(
      makeProps({
        loadData: vi.fn().mockResolvedValue(
          makeData({
            automationId: 'a/x',
            mode: 'edit',
            name: 'A',
            rowId: 'r1',
            triggers: [{ entity: '', kind: 'condition', where: [] }],
          }),
        ),
        loadEntityTypes,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const input = el.querySelector('input[placeholder="business.invoice"]') as HTMLInputElement;
    setValue(input, 'invoice');
    await act(async () => {
      (el.querySelector('[role="option"]') as HTMLButtonElement).click();
    });
    expect(input.value).toBe('billing.invoice');
  });
});
