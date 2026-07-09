import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderChatBridgeProps, BuilderChatSnapshot } from '../screen-contracts.js';
import BuilderChatPane from './BuilderChatPane.js';

function snap(over: Partial<BuilderChatSnapshot> = {}): BuilderChatSnapshot {
  return {
    view: 'chat',
    messages: [],
    generating: false,
    progress: null,
    suggestions: ['Improve the layout', 'Prepare to publish'],
    composerDisabled: false,
    historyNonce: 0,
    ...over,
  };
}

function makeProps(over: Partial<BuilderChatBridgeProps> = {}): BuilderChatBridgeProps {
  return {
    onReady: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onToggleGroup: vi.fn(),
    onSetView: vi.fn(),
    onMountHistory: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let update: ((s: BuilderChatSnapshot) => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  update = null;
  vi.clearAllMocks();
});
function mount(props: BuilderChatBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const onReady = (u: (s: BuilderChatSnapshot) => void): void => {
    update = u;
  };
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<BuilderChatPane {...props} onReady={onReady} />);
  });
  return container;
}
function push(s: BuilderChatSnapshot): void {
  act(() => update?.(s));
}
function setValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  act(() => el.dispatchEvent(new Event('input', { bubbles: true })));
}

describe('BuilderChatPane', () => {
  it('renders user, ai, thinking, status, and divider messages', () => {
    const el = mount(makeProps());
    push(
      snap({
        messages: [
          { kind: 'divider', text: 'Today' },
          { kind: 'status', text: 'Published v2', spinning: false },
          { kind: 'user', text: 'Add a header' },
          { kind: 'thinking', text: 'planning', streaming: true, header: 'Thinking…' },
          { kind: 'ai', paras: ['Done.', 'Anything else?'] },
        ],
      }),
    );
    expect(el.querySelector('.chatDivider')?.textContent).toBe('Today');
    expect(el.querySelector('.msg-status')?.textContent).toContain('Published v2');
    expect(el.querySelector('.msg-user-bubble')?.textContent).toBe('Add a header');
    expect((el.querySelector('.chatThinking') as HTMLElement).dataset.streaming).toBe('true');
    expect(el.querySelectorAll('.msg-ai-text p').length).toBe(2);
  });

  it('renders a collapsed tool group with a change card, toggles on click', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      snap({
        messages: [
          {
            kind: 'toolGroup',
            id: 'g1',
            label: 'Editing ×2, Reading',
            open: false,
            running: false,
            error: false,
            rows: [],
            change: { count: 2, subtitle: 'index.html · app.js', version: 'v3' },
          },
        ],
      }),
    );
    expect((el.querySelector('.tool-group') as HTMLElement).dataset.open).toBe('false');
    expect(el.querySelector('.tg-label')?.textContent).toBe('Editing ×2, Reading');
    expect(el.querySelector('.tgCardTitle')?.textContent).toContain('2 files updated');
    expect(el.querySelector('.tgCardVersion')?.textContent).toContain('v3');
    expect(el.querySelector('.tg-list')).toBeNull();
    act(() =>
      (el.querySelector('.tool-group-pill') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onToggleGroup).toHaveBeenCalledWith('g1');
  });

  it('renders expanded tool-group rows', () => {
    const el = mount(makeProps());
    push(
      snap({
        messages: [
          {
            kind: 'toolGroup',
            id: 'g1',
            label: 'Reading',
            open: true,
            running: false,
            error: false,
            rows: [{ state: 'ok', verb: 'Reading', target: 'index.html' }],
            change: null,
          },
        ],
      }),
    );
    expect(el.querySelectorAll('.tg-row').length).toBe(1);
    expect(el.querySelector('.tg-row-target')?.textContent).toBe('index.html');
  });

  it('shows the agent-progress strip only while generating; cancel fires', () => {
    const props = makeProps();
    const el = mount(props);
    push(snap({ messages: [{ kind: 'user', text: 'go' }] }));
    expect(el.querySelector('.abProgress')).toBeNull();
    push(
      snap({
        messages: [{ kind: 'user', text: 'go' }],
        generating: true,
        composerDisabled: true,
        progress: { verb: 'Writing', file: 'app.js', sub: 'Composing', filled: 3 },
      }),
    );
    expect(el.querySelector('.abProgressVerb')?.textContent).toBe('Writing');
    expect(el.querySelector('.abProgressFile')?.textContent).toBe('app.js');
    expect(el.querySelectorAll('.abProgressDots i[data-on]').length).toBe(3);
    act(() =>
      (el.querySelector('.abProgressCancel') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('sends a composed prompt on Enter and clears the draft', () => {
    const props = makeProps();
    const el = mount(props);
    push(snap());
    const ta = el.querySelector('.chatInput textarea') as HTMLTextAreaElement;
    setValue(ta, 'Add a footer');
    act(() => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(props.onSend).toHaveBeenCalledWith('Add a footer');
    expect(ta.value).toBe('');
  });

  it('does not send while the composer is disabled', () => {
    const props = makeProps();
    const el = mount(props);
    push(snap({ composerDisabled: true }));
    const ta = el.querySelector('.chatInput textarea') as HTMLTextAreaElement;
    setValue(ta, 'hi');
    act(() =>
      (el.querySelector('.sendBtn') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('loads a suggestion into the composer draft', () => {
    const el = mount(makeProps());
    push(snap());
    const chip = [...el.querySelectorAll<HTMLButtonElement>('.promptStarter')].find(
      (b) => b.textContent === 'Prepare to publish',
    )!;
    act(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect((el.querySelector('.chatInput textarea') as HTMLTextAreaElement).value).toBe(
      'Prepare to publish',
    );
  });

  it('switches to the history view and mounts the vanilla renderer', () => {
    const props = makeProps();
    const el = mount(props);
    push(snap({ view: 'history' }));
    expect(el.querySelector('.chatpaneHeadTitle')?.textContent).toBe('Version history');
    expect(props.onMountHistory).toHaveBeenCalledTimes(1);
    expect(props.onMountHistory).toHaveBeenCalledWith(expect.any(HTMLElement));
    act(() =>
      (el.querySelector('.chatpaneHead .btn-icon') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onSetView).toHaveBeenCalledWith('chat');
  });

  it('re-fetches history when the nonce bumps', () => {
    const props = makeProps();
    mount(props);
    push(snap({ view: 'history', historyNonce: 0 }));
    expect(props.onMountHistory).toHaveBeenCalledTimes(1);
    push(snap({ view: 'history', historyNonce: 1 }));
    expect(props.onMountHistory).toHaveBeenCalledTimes(2);
  });
});
