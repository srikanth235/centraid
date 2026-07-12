import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantBridgeProps,
  AssistantSnapshot,
  AsstModelPickerDTO,
} from '../screen-contracts.js';
import AssistantScreen from './AssistantScreen.js';

function emptySnap(over: Partial<AssistantSnapshot> = {}): AssistantSnapshot {
  return { empty: true, busy: false, messages: [], pendingAttachments: [], ...over };
}

function modelPickerDTO(over: Partial<AsstModelPickerDTO> = {}): AsstModelPickerDTO {
  return {
    connected: true,
    models: [
      { id: 'sonnet-5', name: 'Sonnet 5', default: true },
      { id: 'opus-5', name: 'Opus 5' },
    ],
    defaultModelName: 'Sonnet 5',
    selectedModelId: '',
    ...over,
  };
}

function makeProps(over: Partial<AssistantBridgeProps> = {}): AssistantBridgeProps {
  return {
    suggestions: ['What did I spend the most on last month?', 'What tasks are due this week?'],
    onReady: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onAttachFiles: vi.fn(),
    onRemovePendingAttachment: vi.fn(),
    hydrateRefs: vi.fn(),
    loadModelPicker: vi.fn().mockResolvedValue(modelPickerDTO()),
    onSetModel: vi.fn(),
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
  void act(() => el.dispatchEvent(new Event('input', { bubbles: true })));
}
/** Flush the `loadModelPicker()` microtask the picker fetches on mount. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('AssistantScreen', () => {
  it('shows the empty state with clickable suggestions', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    expect(el.querySelector('.empty')).toBeTruthy();
    const chips = [...el.querySelectorAll<HTMLButtonElement>('.suggestChip')];
    expect(chips.length).toBe(2);
    void act(() => chips[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // suggestion loads into the composer draft
    expect((el.querySelector('.input') as HTMLTextAreaElement).value).toContain('spend');
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
          {
            kind: 'ai',
            streaming: false,
            html: '<p class="cd-asst-p">You spent <strong>$412</strong>.</p>',
            error: false,
          },
        ],
      }),
    );
    expect(el.querySelector('.msgUser')?.textContent).toContain('How much');
    expect(el.querySelector('.tools summary')?.textContent).toContain('1 query');
    expect(el.querySelector('.asstPre')?.textContent).toBe('SELECT 1');
    // final answer HTML is injected verbatim
    expect(el.querySelector('.msgAi strong')?.textContent).toBe('$412');
  });

  it('renders attachment chips on a user message', () => {
    const el = mount(makeProps());
    push(
      emptySnap({
        empty: false,
        messages: [
          {
            kind: 'user',
            text: 'See attached',
            attachments: [
              { hash: 'h1', filename: 'notes.pdf', mime: 'application/pdf', sizeBytes: 2048 },
            ],
          },
        ],
      }),
    );
    const chip = el.querySelector('.msgAttachChip');
    expect(chip?.textContent).toContain('notes.pdf');
  });

  it('re-hydrates refs inside an injected final answer', () => {
    const props = makeProps();
    mount(props);
    push(
      emptySnap({
        empty: false,
        messages: [
          {
            kind: 'ai',
            streaming: false,
            html: '<p>See <button class="cd-asst-ref">x</button></p>',
            error: false,
          },
        ],
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
    void act(() =>
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
    void act(() => send.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onStop).toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('does not send while busy or when the draft is blank and nothing is attached', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    const input = el.querySelector('.input') as HTMLTextAreaElement;
    setValue(input, '   ');
    void act(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('sends a blank draft when a ready attachment is staged', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      emptySnap({
        pendingAttachments: [{ id: 'a1', filename: 'photo.png', sizeBytes: 1024, state: 'ready' }],
      }),
    );
    const send = el.querySelector('.send') as HTMLButtonElement;
    void act(() => send.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onSend).toHaveBeenCalledWith('');
  });

  it('renders staged attachment chips and removes one', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      emptySnap({
        pendingAttachments: [
          { id: 'a1', filename: 'photo.png', sizeBytes: 1024, state: 'ready' },
          { id: 'a2', filename: 'huge.zip', sizeBytes: 0, state: 'uploading' },
        ],
      }),
    );
    const chips = [...el.querySelectorAll<HTMLDivElement>('.attachChip')];
    expect(chips.length).toBe(2);
    const removeBtn = chips[0]!.querySelector('.attachRemove') as HTMLButtonElement;
    void act(() => removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onRemovePendingAttachment).toHaveBeenCalledWith('a1');
  });

  it('forwards dropped files to onAttachFiles', () => {
    const props = makeProps();
    const el = mount(props);
    push(emptySnap());
    const row = el.querySelector('.composerRow') as HTMLDivElement;
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const dataTransfer = { files: [file] } as unknown as DataTransfer;
    void act(() =>
      row.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      ),
    );
    expect(props.onAttachFiles).toHaveBeenCalledWith([file]);
  });

  describe('model picker', () => {
    it('shows "Default · <model>" when the subsystem has no override, with an accessible name', async () => {
      const props = makeProps();
      const el = mount(props);
      push(emptySnap());
      await flush();
      const btn = el.querySelector('.modelBtn') as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Assistant model');
      expect(btn.textContent).toContain('Default · Sonnet 5');
      expect(props.loadModelPicker).toHaveBeenCalled();
    });

    it('shows the overridden model name when the subsystem pref is set', async () => {
      const props = makeProps({
        loadModelPicker: vi.fn().mockResolvedValue(modelPickerDTO({ selectedModelId: 'opus-5' })),
      });
      const el = mount(props);
      push(emptySnap());
      await flush();
      const btn = el.querySelector('.modelBtn') as HTMLButtonElement;
      expect(btn.textContent).toContain('Opus 5');
      expect(btn.textContent).not.toContain('Default');
    });

    it('opens a menu on click with menu/menuitemradio semantics, closes on Escape', async () => {
      const props = makeProps();
      const el = mount(props);
      push(emptySnap());
      await flush();
      const btn = el.querySelector('.modelBtn') as HTMLButtonElement;
      void act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(btn.getAttribute('aria-expanded')).toBe('true');
      const menu = el.querySelector('.modelMenu') as HTMLDivElement;
      expect(menu.getAttribute('role')).toBe('menu');
      const items = [...el.querySelectorAll('[role="menuitemradio"]')];
      // "Use default" + the two catalog models
      expect(items.length).toBe(3);
      expect(items[0]?.getAttribute('aria-checked')).toBe('true'); // no override yet
      void act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(el.querySelector('.modelMenu')).toBeFalsy();
      expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on an outside click', async () => {
      const props = makeProps();
      const el = mount(props);
      push(emptySnap());
      await flush();
      const btn = el.querySelector('.modelBtn') as HTMLButtonElement;
      void act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(el.querySelector('.modelMenu')).toBeTruthy();
      void act(() =>
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      );
      expect(el.querySelector('.modelMenu')).toBeFalsy();
    });

    it('picking a catalog model persists the pref and updates the label immediately', async () => {
      const props = makeProps();
      const el = mount(props);
      push(emptySnap());
      await flush();
      const btn = el.querySelector('.modelBtn') as HTMLButtonElement;
      void act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const opusItem = [...el.querySelectorAll('[role="menuitemradio"]')].find((n) =>
        n.textContent?.includes('Opus 5'),
      ) as HTMLButtonElement;
      void act(() => opusItem.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(props.onSetModel).toHaveBeenCalledWith('opus-5');
      expect(el.querySelector('.modelMenu')).toBeFalsy();
      expect((el.querySelector('.modelBtn') as HTMLButtonElement).textContent).toContain(
        'Opus 5',
      );
    });

    it('"Use default" clears the override back to the runner default', async () => {
      const props = makeProps({
        loadModelPicker: vi.fn().mockResolvedValue(modelPickerDTO({ selectedModelId: 'opus-5' })),
      });
      const el = mount(props);
      push(emptySnap());
      await flush();
      const btn = el.querySelector('.modelBtn') as HTMLButtonElement;
      void act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const useDefault = [...el.querySelectorAll('[role="menuitemradio"]')][0] as HTMLButtonElement;
      void act(() => useDefault.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(props.onSetModel).toHaveBeenCalledWith('');
      expect((el.querySelector('.modelBtn') as HTMLButtonElement).textContent).toContain(
        'Default · Sonnet 5',
      );
    });
  });
});
