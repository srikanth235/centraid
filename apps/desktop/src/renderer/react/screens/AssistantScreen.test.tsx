import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantBridgeProps, AssistantSnapshot } from '../bridge.js';
import AssistantScreen from './AssistantScreen.js';

function emptySnap(over: Partial<AssistantSnapshot> = {}): AssistantSnapshot {
  return { threads: [], empty: true, busy: false, messages: [], ...over };
}

function makeProps(over: Partial<AssistantBridgeProps> = {}): AssistantBridgeProps {
  return {
    suggestions: ['What did I spend the most on last month?', 'What tasks are due this week?'],
    onReady: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onSelectThread: vi.fn(),
    onDeleteThread: vi.fn(),
    hydrateRefs: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let update: ((s: AssistantSnapshot) => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  update = null;
  vi.clearAllMocks();
});
function mount(props: AssistantBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const onReady = (u: (s: AssistantSnapshot) => void): void => {
    update = u;
  };
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AssistantScreen {...props} onReady={onReady} />);
  });
  return container;
}
function push(snap: AssistantSnapshot): void {
  act(() => update?.(snap));
}
function setValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  act(() => el.dispatchEvent(new Event('input', { bubbles: true })));
}

describe('AssistantScreen', () => {
  it('shows the empty state with clickable suggestions', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    expect(el.querySelector('.empty')).toBeTruthy();
    const chips = [...el.querySelectorAll<HTMLButtonElement>('.suggestChip')];
    expect(chips.length).toBe(2);
    act(() => chips[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // suggestion loads into the composer draft
    expect((el.querySelector('.input') as HTMLTextAreaElement).value).toContain('spend');
  });

  it('lists threads and marks the active one; right-click deletes', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      emptySnap({
        threads: [
          { id: 't1', title: 'Spending', timeLabel: '2h ago', active: true },
          { id: 't2', title: 'Travel notes', timeLabel: 'yesterday', active: false },
        ],
      }),
    );
    const rows = [...el.querySelectorAll<HTMLButtonElement>('.thread')];
    expect(rows.length).toBe(2);
    expect(rows[0]!.dataset.active).toBe('true');
    expect(Object.hasOwn(rows[1]!.dataset, 'active')).toBe(false);
    act(() =>
      rows[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(props.onDeleteThread).toHaveBeenCalledWith('t2');
    act(() => rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSelectThread).toHaveBeenCalledWith('t1');
  });

  it('renders user, tools, and streaming/final AI messages', () => {
    const el = mount(makeProps());
    push(
      emptySnap({
        empty: false,
        messages: [
          { kind: 'user', text: 'How much did I spend?' },
          {
            kind: 'tools',
            label: '1 query · 12ms',
            calls: [{ tool: 'vault_sql', sql: 'SELECT 1', state: 'ok', meta: '3 rows · 12ms' }],
          },
          { kind: 'ai', streaming: false, html: '<p class="cd-asst-p">You spent <strong>$412</strong>.</p>', error: false },
        ],
      }),
    );
    expect(el.querySelector('.msgUser')?.textContent).toContain('How much');
    expect(el.querySelector('.tools summary')?.textContent).toContain('1 query');
    expect(el.querySelector('.cd-asst-pre')?.textContent).toBe('SELECT 1');
    // final answer HTML is injected verbatim
    expect(el.querySelector('.msgAi strong')?.textContent).toBe('$412');
  });

  it('re-hydrates refs inside an injected final answer', () => {
    const props = makeProps();
    mount(props);
    push(
      emptySnap({
        empty: false,
        messages: [{ kind: 'ai', streaming: false, html: '<p>See <button class="cd-asst-ref">x</button></p>', error: false }],
      }),
    );
    expect(props.hydrateRefs).toHaveBeenCalled();
    const node = (props.hydrateRefs as ReturnType<typeof vi.fn>).mock.calls[0]![0] as HTMLElement;
    expect(node.querySelector('.cd-asst-ref')).toBeTruthy();
  });

  it('shows a live streaming bubble with a cursor', () => {
    const el = mount(makeProps());
    push(
      emptySnap({
        empty: false,
        busy: true,
        messages: [{ kind: 'ai', streaming: true, text: 'Working on it' }],
      }),
    );
    expect(el.querySelector('.live')?.textContent).toBe('Working on it');
    expect(el.querySelector('.cursor')).toBeTruthy();
  });

  it('sends the composed draft on Enter and clears it', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    const input = el.querySelector('.input') as HTMLTextAreaElement;
    setValue(input, 'When is my next event?');
    act(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(props.onSend).toHaveBeenCalledWith('When is my next event?');
    expect(input.value).toBe('');
  });

  it('the send button acts as Stop while busy', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap({ busy: true }));
    const send = el.querySelector('.send') as HTMLButtonElement;
    expect(send.getAttribute('aria-label')).toBe('Stop');
    act(() => send.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onStop).toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('does not send while busy or when the draft is blank', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    const input = el.querySelector('.input') as HTMLTextAreaElement;
    setValue(input, '   ');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('starts a new conversation from the sidebar', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    act(() =>
      (el.querySelector('.new') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onSelectThread).toHaveBeenCalledWith(null);
  });
});
