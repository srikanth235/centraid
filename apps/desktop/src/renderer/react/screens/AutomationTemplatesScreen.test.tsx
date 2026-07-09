import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationTemplatesBridgeProps, DiscoverTemplate } from '../screen-contracts.js';
import AutomationTemplatesScreen from './AutomationTemplatesScreen.js';

const templates: DiscoverTemplate[] = [
  {
    id: 'digest',
    name: 'Daily Digest',
    desc: 'Summarize the inbox each morning.',
    colorKey: 'indigo',
    iconKey: 'Bolt',
    version: '1',
    kind: 'automation',
    emoji: '📥',
    category: 'Inbox',
    triggerKind: 'cron',
    triggerLabel: 'Daily at 8am',
    integrations: ['Gmail'],
  },
  {
    id: 'alert',
    name: 'Deploy Alert',
    desc: 'Ping on failed deploys.',
    colorKey: 'rose',
    iconKey: 'Bolt',
    version: '1',
    kind: 'automation',
    emoji: '🚨',
    category: 'Ops',
    triggerKind: 'webhook',
    triggerLabel: 'On webhook',
    integrations: ['Slack', 'GitHub'],
  },
];

function makeProps(
  over: Partial<AutomationTemplatesBridgeProps> = {},
): AutomationTemplatesBridgeProps {
  return {
    templates,
    onPreview: vi.fn(),
    onStartFromScratch: vi.fn(),
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
});
function mount(props: AutomationTemplatesBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationTemplatesScreen {...props} />);
  });
  return container;
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('AutomationTemplatesScreen', () => {
  it('renders a card per template grouped by category, with the trigger filter', () => {
    const html = renderToStaticMarkup(<AutomationTemplatesScreen {...makeProps()} />);
    expect(count(html, 'card')).toBe(2);
    expect(html).toContain('>Inbox<');
    expect(html).toContain('>Ops<');
    expect(count(html, 'segB')).toBe(3);
    // integration filter chips derived from the catalog
    expect(html).toContain('Gmail');
    expect(html).toContain('GitHub');
  });

  it('opens the preview drawer callback when a card is clicked', () => {
    const props = makeProps();
    const el = mount(props);
    const card = el.querySelector('.card') as HTMLButtonElement;
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onPreview).toHaveBeenCalledTimes(1);
    const firstArg = (props.onPreview as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | DiscoverTemplate
      | undefined;
    expect(firstArg?.id).toBe('digest');
  });

  it('filters by trigger kind', () => {
    const el = mount(makeProps());
    const webhookTab = [...el.querySelectorAll('.segB')].find(
      (b) => (b as HTMLElement).dataset.k === 'webhook',
    ) as HTMLButtonElement;
    act(() => webhookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelectorAll('.card').length).toBe(1);
    expect(el.textContent).toContain('Deploy Alert');
    expect(el.textContent).not.toContain('Daily Digest');
  });

  it('shows the empty state + Start-from-scratch when a search matches nothing', () => {
    const props = makeProps();
    const el = mount(props);
    const input = el.querySelector('.searchIn') as HTMLInputElement;
    // React tracks the controlled value via a property descriptor, so a plain
    // `input.value = …` is reverted; set it through the native setter so the
    // synthetic onChange sees the new value.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      nativeSetter?.call(input, 'zzzznope');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(el.textContent).toContain('No templates match');
    const scratch = el.querySelector('.cd-au-btn-primary') as HTMLButtonElement;
    act(() => scratch.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onStartFromScratch).toHaveBeenCalledTimes(1);
  });
});
