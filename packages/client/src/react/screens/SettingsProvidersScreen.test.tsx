import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentsStatusDTO, SettingsProvidersBridgeProps } from '../screen-contracts.js';
import SettingsProvidersScreen from './SettingsProvidersScreen.js';

function makeStatus(over: Partial<AgentsStatusDTO> = {}): AgentsStatusDTO {
  return {
    selectedKind: 'codex',
    anyLoading: false,
    savedModelByKind: { codex: 'gpt-5' },
    subsystemModelByKind: { codex: { assistant: 'gpt-5-mini' } },
    subsystemRunnerByKey: {},
    cards: [
      {
        kind: 'codex',
        title: 'Codex',
        accent: '#10b981',
        subtitle: 'codex 1.2.3',
        connected: true,
        modelsLoading: false,
        models: [
          { id: 'gpt-5', name: 'GPT-5', tier: 'smart', default: true },
          { id: 'gpt-5-mini', name: 'GPT-5 mini', tier: 'fast' },
        ],
      },
      {
        kind: 'claude-code',
        title: 'Claude Code',
        accent: '#a855f7',
        subtitle: 'claude CLI not found on PATH',
        connected: false,
        modelsLoading: false,
        models: [],
      },
    ],
    ...over,
  };
}

/** makeStatus, but with Claude Code present so it can be routed to. */
function makeStatusBothConnected(over: Partial<AgentsStatusDTO> = {}): AgentsStatusDTO {
  const base = makeStatus();
  return {
    ...base,
    cards: base.cards.map((c) =>
      c.kind === 'claude-code'
        ? {
            ...c,
            connected: true,
            subtitle: 'claude 1.0',
            models: [{ id: 'opus-4-8', name: 'Opus 4.8', tier: 'smart', default: true }],
          }
        : c,
    ),
    ...over,
  };
}

function makeProps(over: Partial<SettingsProvidersBridgeProps> = {}): SettingsProvidersBridgeProps {
  return {
    loadStatus: vi.fn().mockResolvedValue(makeStatus()),
    refreshModels: vi.fn().mockResolvedValue(makeStatus()),
    activateRunner: vi.fn().mockResolvedValue(true),
    setAgentModel: vi.fn(),
    setSubsystemModel: vi.fn(),
    setSubsystemRunner: vi.fn(),
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

function sel(el: HTMLElement, label: string): HTMLSelectElement {
  const found = el.querySelector(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`no select labelled "${label}"`);
  return found as HTMLSelectElement;
}

/** Drive a native <select> the way React's onChange listener expects. */
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLSelectElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SettingsProvidersScreen', () => {
  it('renders a routing lane per subsystem plus the default lane, and the agent inventory', async () => {
    const el = await mount(makeProps());
    // 1 default lane + 4 subsystem lanes.
    expect(el.querySelectorAll('.routeRow').length).toBe(5);
    expect(el.querySelector('.routeRow[data-default="true"]')).toBeTruthy();
    expect(el.textContent).toContain('Routing');
    for (const label of ['Assistant', 'In-app Ask', 'Builder', 'Automations']) {
      expect(el.textContent).toContain(label);
    }
    // Inventory still lists every detected agent with its default model.
    expect(el.querySelectorAll('.entry').length).toBe(2);
    expect(sel(el, 'Default model for Codex').value).toBe('gpt-5');
    expect(el.querySelectorAll('optgroup').length).toBeGreaterThan(0);
  });

  it('has no exclusive active-agent switch — routing is per lane now', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('.switchSeg')).toBeNull();
    expect(el.textContent).not.toContain('Active agent');
  });

  it('changes the default agent through the default lane', async () => {
    const props = makeProps({
      loadStatus: vi.fn().mockResolvedValue(makeStatusBothConnected()),
    });
    const el = await mount(props);
    await pick(sel(el, 'Default agent'), 'claude-code');
    expect(props.activateRunner).toHaveBeenCalledWith('claude-code');
  });

  it('routes a single subsystem to a different agent than the default', async () => {
    const props = makeProps({
      loadStatus: vi.fn().mockResolvedValue(makeStatusBothConnected()),
    });
    const el = await mount(props);
    await pick(sel(el, 'Agent for Builder'), 'claude-code');
    expect(props.setSubsystemRunner).toHaveBeenCalledWith('builder', 'claude-code');
    // The default lane is untouched — this is the whole point of the change.
    expect(props.activateRunner).not.toHaveBeenCalled();
  });

  it('clears a lane back to inheriting the default', async () => {
    const props = makeProps({
      loadStatus: vi
        .fn()
        .mockResolvedValue(
          makeStatusBothConnected({ subsystemRunnerByKey: { builder: 'claude-code' } }),
        ),
    });
    const el = await mount(props);
    expect(sel(el, 'Agent for Builder').value).toBe('claude-code');
    await pick(sel(el, 'Agent for Builder'), '');
    expect(props.setSubsystemRunner).toHaveBeenCalledWith('builder', '');
  });

  it('names what an inheriting lane resolves to rather than saying "use default"', async () => {
    const el = await mount(makeProps());
    // Agent inherit option names the default agent…
    const agent = sel(el, 'Agent for Assistant');
    expect(agent.value).toBe('');
    expect(agent.querySelector('option[value=""]')?.textContent).toBe('Use default · Codex');
    // …and the model inherit option names the resolved agent's default model.
    expect(sel(el, 'Model for Builder').querySelector('option[value=""]')?.textContent).toBe(
      'Use default · GPT-5',
    );
  });

  it("offers the resolved agent's models once a lane overrides the agent", async () => {
    const props = makeProps({
      loadStatus: vi
        .fn()
        .mockResolvedValue(
          makeStatusBothConnected({ subsystemRunnerByKey: { builder: 'claude-code' } }),
        ),
    });
    const el = await mount(props);
    const model = sel(el, 'Model for Builder');
    // Claude Code's model, not Codex's — the lane resolved to a new agent.
    expect([...model.querySelectorAll('option')].map((o) => o.value)).toContain('opus-4-8');
    expect([...model.querySelectorAll('option')].map((o) => o.value)).not.toContain('gpt-5-mini');
  });

  it("saves a subsystem model against the lane's resolved agent, not the default", async () => {
    const props = makeProps({
      loadStatus: vi
        .fn()
        .mockResolvedValue(
          makeStatusBothConnected({ subsystemRunnerByKey: { builder: 'claude-code' } }),
        ),
    });
    const el = await mount(props);
    await pick(sel(el, 'Model for Builder'), 'opus-4-8');
    // Keyed by 'claude-code' (the lane's resolved agent) — not 'codex' (the
    // default). Writing it against the default would strand the override.
    expect(props.setSubsystemModel).toHaveBeenCalledWith('claude-code', 'builder', 'opus-4-8');
  });

  it('reports which lanes land on each agent instead of a single Active pill', async () => {
    const props = makeProps({
      loadStatus: vi
        .fn()
        .mockResolvedValue(
          makeStatusBothConnected({ subsystemRunnerByKey: { builder: 'claude-code' } }),
        ),
    });
    const el = await mount(props);
    const [codex, claude] = [...el.querySelectorAll('.entry')] as HTMLElement[];
    // Codex is the default and keeps the three lanes that inherit.
    const codexChips = [...(codex?.querySelectorAll('.usedByChip') ?? [])].map(
      (c) => c.textContent,
    );
    expect(codexChips).toContain('Default');
    expect(codexChips).toContain('Assistant');
    expect(codexChips).not.toContain('Builder');
    // Claude Code holds only the lane pointed at it.
    const claudeChips = [...(claude?.querySelectorAll('.usedByChip') ?? [])].map(
      (c) => c.textContent,
    );
    expect(claudeChips).toEqual(['Builder']);
  });

  it('marks an agent nothing routes to as unused', async () => {
    const el = await mount(
      makeProps({ loadStatus: vi.fn().mockResolvedValue(makeStatusBothConnected()) }),
    );
    const claude = [...el.querySelectorAll('.entry')][1] as HTMLElement;
    expect(claude.querySelector('.usedByNone')?.textContent).toBe('Unused');
  });

  it('saves an agent default model from the inventory', async () => {
    const props = makeProps();
    const el = await mount(props);
    await pick(sel(el, 'Default model for Codex'), 'gpt-5-mini');
    expect(props.setAgentModel).toHaveBeenCalledWith('codex', 'gpt-5-mini');
  });

  it('no longer exposes a per-agent tool listing — Connections owns that', async () => {
    const el = await mount(makeProps());
    expect(el.querySelector('.toolsToggle')).toBeNull();
    expect(el.querySelector('.groups')).toBeNull();
    expect(el.textContent).not.toContain('Refresh tools');
  });

  it('fires the model refresh', async () => {
    const props = makeProps();
    const el = await mount(props);
    const buttons = [...el.querySelectorAll('.actionsRow .btn')] as HTMLButtonElement[];
    expect(buttons.length).toBe(1);
    await act(async () => buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.refreshModels).toHaveBeenCalledTimes(1);
  });

  it('renders each agent card with its identity glyph tile', async () => {
    const el = await mount(makeProps());
    const tiles = el.querySelectorAll('.glyphTile');
    // One tile per inventory entry, each holding a vendored glyph svg.
    expect(tiles.length).toBe(2);
    for (const tile of tiles) {
      expect(tile.querySelector('svg')).toBeTruthy();
    }
    // The unavailable agent's tile is muted rather than dropped.
    const [, claude] = [...el.querySelectorAll('.entry')] as HTMLElement[];
    expect(claude?.querySelector('.glyphTile[data-unavail="true"]')).toBeTruthy();
  });

  it('falls back to a generic glyph for a kind this build has no artwork for', async () => {
    const base = makeStatus();
    // A kind with no entry in AGENT_GLYPHS must still render an svg, not throw.
    const el = await mount(
      makeProps({
        loadStatus: vi.fn().mockResolvedValue({
          ...base,
          cards: [
            {
              kind: 'some-future-agent',
              title: 'Some Future Agent',
              accent: '#64748b',
              subtitle: 'detected',
              connected: true,
              modelsLoading: false,
              models: [],
            },
          ],
        }),
      }),
    );
    const tile = el.querySelector('.entry .glyphTile');
    expect(tile).toBeTruthy();
    expect(tile?.querySelector('svg')).toBeTruthy();
  });

  it('lists a runner kind this build predates, disabled until it is available', async () => {
    const base = makeStatus();
    const el = await mount(
      makeProps({
        loadStatus: vi.fn().mockResolvedValue({
          ...base,
          cards: [
            ...base.cards,
            {
              kind: 'some-future-agent',
              title: 'Some Future Agent',
              accent: '#64748b',
              subtitle: 'Install it and run it once.',
              connected: false,
              modelsLoading: false,
              models: [],
            },
          ],
        }),
      }),
    );
    // It reaches the pickers rather than being filtered out as unrecognised…
    const opts = [...sel(el, 'Agent for Builder').querySelectorAll('option')];
    const future = opts.find((o) => o.value === 'some-future-agent');
    expect(future).toBeTruthy();
    // …and an unavailable agent is offered disabled, not silently missing.
    expect(future?.disabled).toBe(true);
    expect(future?.textContent).toContain('unavailable');
  });
});
