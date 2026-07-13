import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationThreadBridgeProps } from '../screen-contracts.js';
import AutomationThreadScreen, { type AutomationThreadDataEx } from './AutomationThreadScreen.js';

const NOW = new Date('2026-07-12T18:00:00Z').getTime();
const YESTERDAY = NOW - 24 * 60 * 60 * 1000;

function makeData(over: Partial<AutomationThreadDataEx> = {}): AutomationThreadDataEx {
  return {
    consent: {
      grants: [
        {
          createdAt: new Date(YESTERDAY).toISOString(),
          grantId: 'g1',
          revokedAt: null,
          target: 'gmail:*',
          verb: 'send',
        },
      ],
      outbox: [
        {
          artifact: { to: 'x@y.com' },
          canEdit: true,
          connectionKind: 'gmail',
          connectionLabel: 'Gmail',
          itemId: 'o1',
          note: null,
          stagedAt: new Date(NOW).toISOString(),
          status: 'pending',
          target: 'x@y.com',
          verb: 'send',
        },
      ],
      parked: [
        {
          command: 'locker.set_secret',
          input: {},
          invocationId: 'p1',
          parkedAt: new Date(NOW).toISOString(),
        },
      ],
    },
    header: {
      description: 'Summarize the inbox',
      enabled: true,
      glyphIcon: 'Bolt',
      heroIcon: 'Clock',
      hue: 'indigo',
      id: 'a',
      kindEyebrow: 'Cron schedule',
      name: 'Daily Digest',
      nextRuns: ['Tomorrow, 8:00 AM'],
      ref: 'a@1',
      statusKind: 'active',
      statusLabel: 'Active',
      triggerSummary: 'Every day at 8am',
      webhook: null,
    },
    runs: [
      {
        costUsd: 0.012,
        dateGroup: 'Yesterday',
        durationMs: 3200,
        endedAt: YESTERDAY + 3200,
        originLabel: 'Cron',
        runId: 'r1',
        startedAt: YESTERDAY,
        status: 'ok',
        summary: 'ok run',
      },
      {
        costUsd: null,
        dateGroup: 'Today',
        durationMs: 800,
        endedAt: NOW - 60_000 + 800,
        originLabel: 'Manual',
        runId: 'r2',
        startedAt: NOW - 60_000,
        status: 'fail',
        summary: 'failed run',
      },
      {
        costUsd: null,
        dateGroup: 'Today',
        durationMs: null,
        endedAt: null,
        originLabel: 'Webhook',
        runId: 'r3',
        startedAt: NOW,
        status: 'running',
        summary: 'in progress',
      },
    ],
    runTokens: { r1: 1234 },
    triggerDetail: {
      conditionDetail: null,
      cronExprs: ['0 8 * * *'],
      dataDetail: null,
    },
    ...over,
  };
}

function makeProps(
  over: Partial<AutomationThreadBridgeProps> = {},
  data: AutomationThreadDataEx | null = makeData(),
): AutomationThreadBridgeProps {
  return {
    loadData: vi.fn().mockResolvedValue(data),
    onBack: vi.fn(),
    onCopyWebhook: vi.fn(),
    onDecideConsent: vi.fn().mockResolvedValue(true),
    onDelete: vi.fn().mockResolvedValue(false),
    onEdit: vi.fn(),
    onOpenRun: vi.fn(),
    onRotateWebhook: vi.fn().mockResolvedValue(true),
    onRunNow: vi.fn().mockResolvedValue(true),
    onSendMessage: vi.fn(),
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
async function mount(props: AutomationThreadBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AutomationThreadScreen {...props} />);
  });
  return container;
}
function byText(el: HTMLElement, tag: string, text: string): HTMLElement | undefined {
  return [...el.querySelectorAll(tag)].find((n) => n.textContent?.trim() === text) as
    | HTMLElement
    | undefined;
}

describe('AutomationThreadScreen', () => {
  it('renders the header — name, status, enable switch', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('h1')?.textContent).toBe('Daily Digest');
    expect(el.querySelector<HTMLElement>('[data-au-status]')?.dataset.auStatus).toBe('active');
    expect(el.textContent).toContain('Active');
    const toggle = el.querySelector('input[type="checkbox"][role="switch"]') as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
    expect(el.querySelector('[data-hue="indigo"]')).toBeTruthy();
    expect(byText(el, 'button', 'Run now')).toBeTruthy();
    expect(byText(el, 'button', 'Delete')).toBeTruthy();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Edit')).toBe(true);
  });

  it('renders trigger chips — mono cron expr + next run, plain-word summaries', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('[data-trigger-kind="cron"]')).toBeTruthy();
    expect(el.querySelector('code')?.textContent).toBe('0 8 * * *');
    expect(el.textContent).toContain('next Tomorrow, 8:00 AM');
  });

  it('renders consent cards and approves outbox with alwaysAllow when checked', async () => {
    const props = makeProps();
    const el = await mount(props);
    const outboxCard = el.querySelector('[data-kind="outbox"]') as HTMLElement;
    expect(outboxCard).toBeTruthy();
    expect(outboxCard.textContent).toContain('Staged');
    const parkedCard = el.querySelector('[data-kind="parked"]') as HTMLElement;
    expect(parkedCard).toBeTruthy();
    expect(parkedCard.textContent).toContain('Parked');

    const checkbox = outboxCard.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
    });
    const approveBtn = byText(outboxCard, 'button', 'Approve') as HTMLButtonElement;
    await act(async () => approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onDecideConsent).toHaveBeenCalledWith('outbox', 'o1', 'approve', true);
  });

  it('renders the standing grants line and revokes a grant', async () => {
    const props = makeProps();
    const el = await mount(props);
    expect(el.textContent).toContain('1 standing grant');
    const revokeBtn = byText(el, 'button', 'Revoke') as HTMLButtonElement;
    expect(revokeBtn).toBeTruthy();
    await act(async () => revokeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onDecideConsent).toHaveBeenCalledWith('grant', 'g1', 'revoke', undefined);
  });

  it('groups runs under date separators, oldest to newest', async () => {
    const el = await mount(makeProps());
    const seps = [...el.querySelectorAll('.dateSep')].map((n) => n.textContent);
    expect(seps).toEqual(['Yesterday', 'Today']);
    const entries = [...el.querySelectorAll<HTMLElement>('.entry')];
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.dataset.runStatus)).toEqual(['ok', 'fail', 'running']);
  });

  it('opens a run on click', async () => {
    const props = makeProps();
    const el = await mount(props);
    const entries = [...el.querySelectorAll('.entry')];
    await act(async () => entries[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onOpenRun).toHaveBeenCalledWith('r2');
  });

  it('submits the composer', async () => {
    const props = makeProps();
    const el = await mount(props);
    const input = el.querySelector('input[placeholder^="Ask about"]') as HTMLInputElement;
    const send = el.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'add a Slack step');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => send.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSendMessage).toHaveBeenCalledWith('add a Slack step');
  });

  it('shows the empty-thread state when there are no runs', async () => {
    const el = await mount(makeProps({}, makeData({ runs: [] })));
    expect(el.textContent).toContain('No runs yet');
    expect(el.textContent).toContain('Run now, or wait for the trigger.');
  });

  it('renders the not-found state with a working breadcrumb back', async () => {
    const props = makeProps({}, null);
    const el = await mount(props);
    expect(el.textContent).toContain('Automation not found.');
    const back = el.querySelector('.auCrumb button') as HTMLButtonElement;
    await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBack).toHaveBeenCalled();
  });
});
