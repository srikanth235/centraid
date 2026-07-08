import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentsStatusDTO, SettingsProvidersBridgeProps } from '../bridge.js';
import SettingsProvidersScreen from './SettingsProvidersScreen.js';

function makeStatus(over: Partial<AgentsStatusDTO> = {}): AgentsStatusDTO {
  return {
    selectedKind: 'codex',
    anyLoading: false,
    savedModelByKind: { codex: 'gpt-5' },
    cards: [
      {
        kind: 'codex',
        title: 'Codex',
        accent: '#10b981',
        subtitle: 'codex 1.2.3',
        connected: true,
        modelsLoading: false,
        toolsLoading: false,
        models: [
          { id: 'gpt-5', name: 'GPT-5', tier: 'smart', default: true },
          { id: 'gpt-5-mini', name: 'GPT-5 mini', tier: 'fast' },
        ],
        tools: [
          { name: 'shell', source: 'native', hasArgs: true, description: 'run a command' },
          { name: 'search', source: 'mcp', server: 'web', hasArgs: false },
        ],
      },
      {
        kind: 'claude-code',
        title: 'Claude Code',
        accent: '#a855f7',
        subtitle: 'claude CLI not found on PATH',
        connected: false,
        modelsLoading: false,
        toolsLoading: false,
        models: [],
        tools: [],
      },
    ],
    ...over,
  };
}

function makeProps(over: Partial<SettingsProvidersBridgeProps> = {}): SettingsProvidersBridgeProps {
  return {
    loadStatus: vi.fn().mockResolvedValue(makeStatus()),
    refreshModels: vi.fn().mockResolvedValue(makeStatus()),
    refreshTools: vi.fn().mockResolvedValue(makeStatus()),
    activateRunner: vi.fn().mockResolvedValue(true),
    setAgentModel: vi.fn(),
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
async function mount(props: SettingsProvidersBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsProvidersScreen {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('SettingsProvidersScreen', () => {
  it('renders the agent switch, agent entries, model selects, and the saved model', async () => {
    const el = await mount(makeProps());
    expect(el.querySelectorAll('.agent-switch-seg').length).toBe(2);
    expect(el.querySelectorAll('.agent-entry').length).toBe(2);
    // codex is active + connected; claude-code is unavailable (disabled switch)
    const codexSeg = el.querySelectorAll('.agent-switch-seg')[0] as HTMLButtonElement;
    expect(codexSeg.dataset.active).toBe('true');
    const claudeSeg = el.querySelectorAll('.agent-switch-seg')[1] as HTMLButtonElement;
    expect(claudeSeg.disabled).toBe(true);
    // saved model reflected
    const select = el.querySelector('.agent-model-select') as HTMLSelectElement;
    expect(select.value).toBe('gpt-5');
    // tiered optgroups present
    expect(el.querySelectorAll('optgroup').length).toBeGreaterThan(0);
  });

  it('switches the active agent', async () => {
    const props = makeProps({
      loadStatus: vi.fn().mockResolvedValue(
        makeStatus({
          cards: makeStatus().cards.map((c) =>
            c.kind === 'claude-code' ? { ...c, connected: true, subtitle: 'claude 1.0' } : c,
          ),
        }),
      ),
    });
    const el = await mount(props);
    const claudeSeg = el.querySelectorAll('.agent-switch-seg')[1] as HTMLButtonElement;
    expect(claudeSeg.disabled).toBe(false);
    await act(async () => claudeSeg.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.activateRunner).toHaveBeenCalledWith('claude-code');
  });

  it('expands an agent tool list and saves a model change', async () => {
    const props = makeProps();
    const el = await mount(props);
    const toggle = el.querySelector('.agent-tools-toggle') as HTMLButtonElement;
    await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('.tools-groups')).toBeTruthy();
    expect(el.textContent).toContain('shell');

    const select = el.querySelector('.agent-model-select') as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      globalThis.HTMLSelectElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setter?.call(select, 'gpt-5-mini');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(props.setAgentModel).toHaveBeenCalledWith('codex', 'gpt-5-mini');
  });

  it('fires the two refreshes', async () => {
    const props = makeProps();
    const el = await mount(props);
    const [models, tools] = [...el.querySelectorAll('.sheet-actions .btn')] as HTMLButtonElement[];
    await act(async () => models?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => tools?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.refreshModels).toHaveBeenCalledTimes(1);
    expect(props.refreshTools).toHaveBeenCalledTimes(1);
  });
});
