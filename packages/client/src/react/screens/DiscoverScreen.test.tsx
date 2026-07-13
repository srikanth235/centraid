import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiscoverBridgeProps, DiscoverTemplate } from '../screen-contracts.js';
import DiscoverScreen from './DiscoverScreen.js';

const appTemplates: DiscoverTemplate[] = [
  {
    id: 'todos',
    name: 'Todos',
    desc: 'Capture small things.',
    colorKey: 'violet',
    iconKey: 'Todo',
    version: '1',
    kind: 'app',
  },
  {
    id: 'journal',
    name: 'Journal',
    desc: 'Write each day.',
    colorKey: 'amber',
    iconKey: 'Journal',
    version: '1',
    kind: 'app',
  },
];
const automationTemplates: DiscoverTemplate[] = [
  {
    id: 'digest',
    name: 'Daily Digest',
    desc: 'Summarize inbox.',
    colorKey: 'indigo',
    iconKey: 'Bolt',
    version: '1',
    kind: 'automation',
    category: 'Inbox',
    triggerKind: 'cron',
    integrations: ['Gmail', 'Slack'],
  },
  {
    id: 'photo-captioner',
    name: 'Photo captions',
    desc: 'Captions new photos.',
    colorKey: 'ochre',
    iconKey: 'Sparkle',
    version: '1',
    kind: 'automation',
    category: 'Enrichment',
    triggerKind: 'data',
    integrations: [],
  },
  {
    id: 'renewal-reminders',
    name: 'Renewal reminders',
    desc: 'Watches deadlines.',
    colorKey: 'indigo',
    iconKey: 'Sparkle',
    version: '1',
    kind: 'automation',
    category: 'Enrichment',
    triggerKind: 'condition',
    integrations: [],
  },
];

const noop = (): void => {};
const baseProps = (over: Partial<DiscoverBridgeProps> = {}): DiscoverBridgeProps => ({
  appTemplates,
  automationTemplates,
  onOpenAutomationTemplate: noop,
  onOpenTemplate: noop,
  onTemplateContext: noop,
  tileVariant: 'gradient',
  ...over,
});

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('DiscoverScreen', () => {
  it('renders the Discover chrome and the kind segmented filter', () => {
    const html = renderToStaticMarkup(<DiscoverScreen {...baseProps()} />);
    expect(html).toContain('wrap');
    expect(html).toContain('<h1>Templates</h1>');
    expect(count(html, 'discSegB')).toBe(3);
    expect(html).toContain('libLayout');
  });

  it('lists every template as a card in the default All view, apps first', () => {
    const html = renderToStaticMarkup(<DiscoverScreen {...baseProps()} />);
    expect(count(html, 'class="card"')).toBe(5);
    expect(html.indexOf('Todos')).toBeLessThan(html.indexOf('Daily Digest'));
    expect(html).toContain('Todos');
    expect(html).toContain('Journal');
    expect(html).toContain('Daily Digest');
  });

  it('groups by category (apps under "Apps", automations under their own)', () => {
    const html = renderToStaticMarkup(<DiscoverScreen {...baseProps()} />);
    expect(html).toContain('>Apps<');
    expect(html).toContain('>Inbox<');
    expect(html).toContain('>Enrichment<');
    // count badge is zero-padded
    expect(html).toContain('>02<');
    expect(html).toContain('>01<');
  });

  it('draws trigger badge + integration dots only for automation cards', () => {
    const html = renderToStaticMarkup(<DiscoverScreen {...baseProps()} />);
    expect(html).toContain('trig');
    expect(html).toContain('>Cron<');
    expect(count(html, 'auOvDot"')).toBe(2);
    expect(html).toContain('class="badge"');
  });

  it('labels data and condition triggers honestly instead of falling back to Cron', () => {
    const html = renderToStaticMarkup(<DiscoverScreen {...baseProps()} />);
    expect(html).toContain('>Data<');
    expect(html).toContain('>Condition<');
  });

  it('shows the empty state when no templates match', () => {
    const html = renderToStaticMarkup(
      <DiscoverScreen {...baseProps({ appTemplates: [], automationTemplates: [] })} />,
    );
    expect(html).toContain('pageEmpty');
    expect(html).toContain('No templates available yet.');
    expect(count(html, 'card"')).toBe(0);
  });
});
