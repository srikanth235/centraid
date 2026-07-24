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
      entityTags: [],
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
    onRetryCompile: vi.fn().mockResolvedValue(true),
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
  it('renders the header — name, status, primary Run now, collapsed overflow menu', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('h1')?.textContent).toBe('Daily Digest');
    // The header stays quiet in the happy path — no "Active"/"Plan ready"
    // status badge. Compile state shows as a turn in the thread instead.
    expect(el.querySelector('[data-au-status]')).toBeNull();
    expect(el.querySelector('[data-hue="indigo"]')).toBeTruthy();
    expect(byText(el, 'button', 'Run now')).toBeTruthy();
    // The enable switch, Edit, and Delete moved into a single overflow menu —
    // nothing but the trigger is in the DOM until it's opened.
    const trigger = el.querySelector<HTMLButtonElement>(
      '[data-testid="automation-menu-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(el.querySelector('input[role="switch"]')).toBeNull();
  });

  it('shows a Paused badge only when the automation is paused', async () => {
    const data = makeData();
    data.header.statusKind = 'paused';
    data.header.statusLabel = 'Paused';
    data.header.enabled = false;
    const el = await mount(makeProps({}, data));
    const pill = el.querySelector<HTMLElement>('[data-au-status]');
    expect(pill?.dataset.auStatus).toBe('paused');
    expect(el.textContent).toContain('Paused');
  });

  it('opens the overflow menu and edits setup from it', async () => {
    const props = makeProps();
    const el = await mount(props);
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-trigger"]')!;
    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const menu = el.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // Pause (enabled), Edit setup, and Delete all live in the menu.
    expect(menu.textContent).toContain('Edit setup');
    expect(menu.textContent).toContain('Pause');
    expect(menu.textContent).toContain('Delete');
    const edit = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-edit"]')!;
    await act(async () => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onEdit).toHaveBeenCalled();
    // Choosing an item closes the menu.
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it('toggles enablement from the overflow menu (Pause when enabled)', async () => {
    const props = makeProps();
    const el = await mount(props);
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-trigger"]')!;
    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-toggle"]')!;
    expect(toggle.textContent).toContain('Pause');
    await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onToggleEnabled).toHaveBeenCalledWith(false);
  });

  it('offers Resume in the menu when the automation is disabled', async () => {
    const el = await mount(
      makeProps({}, makeData({ header: { ...makeData().header, enabled: false } })),
    );
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-trigger"]')!;
    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(
      el.querySelector<HTMLElement>('[data-testid="automation-menu-toggle"]')?.textContent,
    ).toContain('Resume');
  });

  it('deletes from the overflow menu', async () => {
    const props = makeProps();
    const el = await mount(props);
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-trigger"]')!;
    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const del = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-delete"]')!;
    await act(async () => del.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onDelete).toHaveBeenCalled();
  });

  it('closes the overflow menu on Escape', async () => {
    const el = await mount(makeProps());
    const trigger = el.querySelector<HTMLButtonElement>('[data-testid="automation-menu-trigger"]')!;
    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('[role="menu"]')).toBeTruthy();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(el.querySelector('[role="menu"]')).toBeNull();
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

  it('renders each run as a chat turn, oldest to newest, with the run summary as the body', async () => {
    const el = await mount(makeProps());
    const seps = [...el.querySelectorAll('.dateSep')].map((n) => n.textContent);
    expect(seps).toEqual(['Yesterday', 'Today']);
    const turns = [...el.querySelectorAll<HTMLElement>('.turn')];
    expect(turns).toHaveLength(3);
    expect(turns.map((e) => e.dataset.runStatus)).toEqual(['ok', 'fail', 'running']);
    // ok run speaks its summary as a message; failed run speaks its error.
    expect(turns[0]!.textContent).toContain('ok run');
    expect(turns[1]!.textContent).toContain('failed run');
    // telemetry footer carries the derived duration / token count.
    expect(turns[0]!.textContent).toContain('3.2s');
    expect(turns[0]!.textContent).toContain('1.2k tok');
  });

  it('opens the full run detail from a turn', async () => {
    const props = makeProps();
    const el = await mount(props);
    // Details affordances appear in DOM order (r1 ok, then r2 fail's "View details").
    const details = [...el.querySelectorAll('[data-testid="run-details"]')];
    await act(async () => details[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onOpenRun).toHaveBeenCalledWith('r2');
  });

  it('steers the automation from the composer, framing one-off vs standing intent', async () => {
    const props = makeProps();
    const el = await mount(props);
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Message this automation"]');
    const send = el.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    expect(input).toBeTruthy();
    expect(send).toBeTruthy();
    // Drive the controlled input through React's value tracker (native setter).
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as (
      v: string,
    ) => void;
    await act(async () => {
      nativeSet.call(input, 'only flag movers over 5%');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // "Apply to future runs" defaults on — the message is a standing instruction.
    const form = input!.closest('form') as HTMLFormElement;
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(props.onSendMessage).toHaveBeenCalledWith('only flag movers over 5%');
  });

  it('reframes a reply as one-off when "Apply to future runs" is toggled off', async () => {
    const props = makeProps();
    const el = await mount(props);
    // Toggle the standing-instruction switch off.
    const toggle = el.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(toggle).toBeTruthy();
    await act(async () => toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Message this automation"]');
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as (
      v: string,
    ) => void;
    await act(async () => {
      nativeSet.call(input, 'what changed since yesterday?');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = input!.closest('form') as HTMLFormElement;
    await act(async () =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(props.onSendMessage).toHaveBeenCalledWith(
      "For this thread only (don't change the schedule): what changed since yesterday?",
    );
  });

  it('marks each turn with a trigger-origin node across origins', async () => {
    // One ok run per origin exercises the origin-aware spine node.
    const base = { costUsd: null, dateGroup: 'Today', durationMs: 500, status: 'ok' as const };
    const el = await mount(
      makeProps(
        {},
        makeData({
          runs: [
            {
              ...base,
              endedAt: NOW,
              originLabel: 'Manual',
              runId: 'm',
              startedAt: NOW - 4,
              summary: 'manual',
            },
            {
              ...base,
              endedAt: NOW,
              originLabel: 'Webhook',
              runId: 'w',
              startedAt: NOW - 3,
              summary: 'hook',
            },
            {
              ...base,
              endedAt: NOW,
              originLabel: 'Data change',
              runId: 'd',
              startedAt: NOW - 2,
              summary: 'data',
            },
            {
              ...base,
              endedAt: NOW,
              originLabel: 'Replay',
              runId: 'p',
              startedAt: NOW - 1,
              summary: 'replay',
            },
          ],
        }),
      ),
    );
    const turns = [...el.querySelectorAll<HTMLElement>('.turn')];
    expect(turns).toHaveLength(4);
    expect(turns.every((t) => t.querySelector('.node'))).toBe(true);
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
