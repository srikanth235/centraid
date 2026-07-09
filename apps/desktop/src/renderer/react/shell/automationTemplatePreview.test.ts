import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateEntry } from '../../app-shell-context.js';
import { openAutomationTemplatePreview } from './automationTemplatePreview.js';

const tmpl = {
  id: 'digest',
  name: 'Daily Digest',
  desc: 'Summarizes your inbox',
  colorKey: 'teal',
  iconKey: 'Bolt',
  version: '1',
  emoji: '📬',
  triggerKind: 'cron',
  triggerLabel: 'Every morning',
  integrations: ['gmail', 'slack'],
} as unknown as TemplateEntry;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('openAutomationTemplatePreview', () => {
  it('renders the drawer with name, trigger label, steps, and integration chips', () => {
    openAutomationTemplatePreview(tmpl, () => {});
    const drawer = document.querySelector('.cd-au-drawer')!;
    expect(drawer.textContent).toContain('Daily Digest');
    expect(drawer.textContent).toContain('Every morning');
    expect(drawer.textContent).toContain('Summarizes your inbox');
    const chips = drawer.querySelectorAll('.cd-au-chip');
    expect(chips).toHaveLength(2);
    expect([...chips].map((c) => c.textContent)).toEqual(['gmail', 'slack']);
  });

  it('fires onUse with the template and closes on "Use template"', () => {
    const onUse = vi.fn();
    openAutomationTemplatePreview(tmpl, onUse);
    const useBtn = [...document.querySelectorAll('.cd-au-btn-primary')].find((b) =>
      b.textContent?.includes('Use template'),
    ) as HTMLButtonElement;
    useBtn.click();
    expect(onUse).toHaveBeenCalledWith(tmpl);
    expect(document.querySelector('.cd-au-drawer')).toBeNull();
  });

  it('closes on Escape and backdrop click without firing onUse', () => {
    const onUse = vi.fn();
    openAutomationTemplatePreview(tmpl, onUse);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.cd-au-drawer')).toBeNull();

    openAutomationTemplatePreview(tmpl, onUse);
    (document.querySelector('.cd-au-drawer-backdrop') as HTMLElement).click();
    expect(document.querySelector('.cd-au-drawer')).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
  });

  it('shows the default-tools line when there are no integrations', () => {
    openAutomationTemplatePreview({ ...tmpl, integrations: [] } as TemplateEntry, () => {});
    expect(document.querySelector('.cd-au-drawer')!.textContent).toContain(
      'Runs with the workspace default tools',
    );
    expect(document.querySelectorAll('.cd-au-chip')).toHaveLength(0);
  });
});
