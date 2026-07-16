import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunViewBridgeProps, RunViewSnapshot } from '../screen-contracts.js';
import RunViewScreen from './RunViewScreen.js';

function makeSnapshot(over: Partial<RunViewSnapshot> = {}): RunViewSnapshot {
  return {
    crumbName: 'Daily Digest',
    glyphIcon: 'Bolt',
    hue: 'indigo',
    headerName: 'Daily Digest',
    startedLabel: 'Today, 6:00:02 PM',
    model: 'claude-opus-4-8',
    statusKind: 'success',
    statusLabel: 'Completed',
    inFlight: false,
    deleted: false,
    triggerLabel: 'Every day at 8am',
    triggersSummary: 'Every day at 8am',
    triggerHeroIcon: 'Clock',
    promptInstr: 'Summarize the inbox.',
    nodes: [
      {
        ordinal: 1,
        status: 'ok',
        typeIcon: 'Plug',
        name: 'gmail.search',
        kind: 'tool',
        meta: '1s · 0.2k tok',
        input: '{ "q": "is:unread" }',
        output: '{ "count": 12 }',
        streaming: false,
      },
      {
        ordinal: 2,
        status: 'ok',
        typeIcon: 'Sparkle',
        name: 'agent',
        kind: 'agent',
        meta: '3s',
        response: 'Summarized 12 emails.',
        streaming: false,
      },
    ],
    final: { kind: 'ok', model: 'claude-opus-4-8', summary: 'Done — 12 emails.' },
    side: {
      outcomeKind: 'success',
      outcomeLabel: 'Completed',
      trigger: 'cron',
      duration: '4s',
      started: '5/19/2026, 6:00 PM',
      runId: 'r1',
      tokens: '1.2k',
      cost: '$0.40',
      steps: '2',
      model: 'claude-opus-4-8',
    },
    logKpi: {
      triggerIcon: 'Clock',
      triggerLabel: 'Cron',
      tokens: '1.2k',
      cost: '$0.400',
      duration: '4s',
    },
    logRows: [
      { time: '00:00.0', tone: 'trigger', label: 'Run started by cron', sub: 'Every day at 8am' },
      {
        time: '00:01.2',
        tone: 'ok',
        label: 'gmail.search',
        sub: 'tool',
        input: '{ "q": "is:unread" }',
      },
      { time: '00:04.0', tone: 'ok', label: 'Run completed', sub: 'Done — 12 emails.' },
    ],
    ...over,
  };
}

function makeProps(over: Partial<RunViewBridgeProps> = {}): RunViewBridgeProps {
  return {
    initialMode: 'timeline',
    onReady: vi.fn(),
    onBack: vi.fn(),
    onOpenAutomation: vi.fn(),
    onRunAgain: vi.fn(),
    onSetMode: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let update: ((s: RunViewSnapshot | null) => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  update = null;
  vi.clearAllMocks();
});
function mount(props: RunViewBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  // capture the update fn the screen hands back via onReady
  const onReady = (u: (s: RunViewSnapshot | null) => void): void => {
    update = u;
  };
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<RunViewScreen {...props} onReady={onReady} />);
  });
  return container;
}
function push(snap: RunViewSnapshot | null): void {
  act(() => update?.(snap));
}

describe('RunViewScreen', () => {
  it('shows a loading state until the first snapshot arrives, with a back affordance', () => {
    const props = makeProps();
    const el = mount(props);
    expect(el.textContent).toContain('Loading run…');
    // The loading state must never strand the user without a way back.
    const crumbBtn = el.querySelector('.auCrumb button') as HTMLButtonElement;
    expect(crumbBtn).toBeTruthy();
    void act(() => crumbBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onBack).toHaveBeenCalled();
    push(makeSnapshot());
    expect(el.querySelector('.rv')).toBeTruthy();
    expect(el.textContent).not.toContain('Loading run…');
  });

  it('renders a deleted-automation notice with breadcrumb/back affordance, and hides actions requiring the automation', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      makeSnapshot({
        deleted: true,
        crumbName: 'digest/main',
        headerName: 'digest/main',
        promptInstr: 'This automation was deleted. Its instructions are no longer available.',
      }),
    );
    expect(el.textContent).toContain('This automation was deleted');
    expect(el.textContent).toContain('digest/main');
    // The crumb segment for the automation is no longer a clickable link.
    const crumbButtons = [...el.querySelectorAll('.auCrumb button')];
    expect(crumbButtons.some((b) => b.textContent === 'digest/main')).toBe(false);
    // "Run again" requires a live automation row — hidden when deleted.
    const runAgain = [...el.querySelectorAll('.auBtn')].find((b) =>
      b.textContent?.includes('Run again'),
    );
    expect(runAgain).toBeUndefined();
    // Back navigation still works.
    void act(() =>
      (el.querySelector('.auCrumb button') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onBack).toHaveBeenCalled();
  });

  it('renders the timeline: breadcrumb, header, node cards, final outcome, KPI rail', () => {
    const el = mount(makeProps());
    push(makeSnapshot());
    expect(el.querySelector('.rvHeadName')?.textContent).toContain('Daily Digest');
    // trigger node + 2 run nodes + final node
    expect(el.querySelectorAll('.tlItem').length).toBe(4);
    expect(el.textContent).toContain('gmail.search');
    expect(el.textContent).toContain('Done — 12 emails.');
    expect(el.querySelector('.rside')).toBeTruthy();
    expect(el.textContent).toContain('claude-opus-4-8');
  });

  it('expands a node payload on click', () => {
    const el = mount(makeProps());
    push(makeSnapshot());
    const head = el.querySelector('.tlHead') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    void act(() => head.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.tlBody')?.hasAttribute('hidden')).toBe(false);
  });

  it('switches to log mode (persisted) and renders transcript rows', () => {
    const props = makeProps();
    const el = mount(props);
    push(makeSnapshot());
    const logTab = [...el.querySelectorAll('.rvSegB')].find((b) =>
      b.textContent?.includes('Log'),
    ) as HTMLButtonElement;
    void act(() => logTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSetMode).toHaveBeenCalledWith('log');
    expect(el.querySelector('.log')).toBeTruthy();
    expect(el.querySelectorAll('.logRow').length).toBe(3);
    expect(el.querySelector('.tl')).toBeNull();
  });

  it('dedupes the final attribution label when provider and model are the same string', () => {
    const el = mount(makeProps());
    push(makeSnapshot({ final: { kind: 'ok', model: 'Centraid', summary: 'Done.' } }));
    const name = el.querySelector('[data-testid="timeline-final"] .tlName');
    expect(name?.textContent).toBe('Centraid');
    expect(name?.textContent).not.toContain('Centraid · Centraid');
  });

  it('keeps the provider · model attribution when they differ', () => {
    const el = mount(makeProps());
    push(makeSnapshot());
    const name = el.querySelector('[data-testid="timeline-final"] .tlName');
    expect(name?.textContent).toBe('Centraid · claude-opus-4-8');
  });

  it('shows a pending final node while in flight', () => {
    const el = mount(makeProps());
    push(
      makeSnapshot({
        inFlight: true,
        statusKind: 'running',
        statusLabel: 'Running',
        final: { kind: 'pending', model: 'claude-opus-4-8' },
      }),
    );
    expect(el.querySelector('.pending')).toBeTruthy();
    expect(el.textContent).toContain('updates live');
  });

  it('fires back / run-again callbacks', () => {
    const props = makeProps();
    const el = mount(props);
    push(makeSnapshot());
    void act(() =>
      (el.querySelector('.auCrumb button') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onBack).toHaveBeenCalled();
    const runAgain = [...el.querySelectorAll('.auBtn')].find((b) =>
      b.textContent?.includes('Run again'),
    ) as HTMLButtonElement;
    void act(() => runAgain.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onRunAgain).toHaveBeenCalled();
  });
});
