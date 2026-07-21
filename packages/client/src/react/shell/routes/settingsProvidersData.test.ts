/*
 * The providers console maps the gateway's LIST-shaped agents snapshot into
 * cards. The behaviour that matters: it renders whatever the gateway lists —
 * including runner kinds this build predates — rather than intersecting it
 * with a local table of kinds it knows (docs/protocol.md C1a, parse-always).
 */

import { beforeEach, expect, it, vi } from 'vitest';
import { loadProviders } from './settingsProvidersData.js';

const getAgentsStatus = vi.fn();
const getUserPrefs = vi.fn();
const saveUserPrefs = vi.fn((_patch?: unknown) => Promise.resolve());

// `vi.mock` is hoisted above the imports, so the gateway stub lands before
// settingsProvidersData.js pulls gateway-client-core's load-time side-effect.
vi.mock('../../../gateway-client.js', () => ({
  getAgentsStatus: (a: unknown) => getAgentsStatus(a),
  getUserPrefs: () => getUserPrefs(),
  saveUserPrefs: (a: unknown) => saveUserPrefs(a),
}));

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'codex',
    label: 'Codex',
    available: true,
    version: 'codex 1.2.3',
    minVersion: '0.128.0',
    models: [{ id: 'gpt-5', name: 'GPT-5', default: true }],
    modelsStatus: 'ready',
    defaultModel: 'gpt-5',
    ...over,
  };
}

beforeEach(() => {
  getAgentsStatus.mockReset();
  getUserPrefs.mockReset();
  getUserPrefs.mockResolvedValue({});
});

it('renders one card per agent the gateway lists, in the gateway’s order', async () => {
  getAgentsStatus.mockResolvedValue({
    agents: [
      entry(),
      entry({ kind: 'gemini', label: 'Gemini CLI', version: 'gemini 0.60.0' }),
      entry({ kind: 'qwen', label: 'Qwen Code', version: 'qwen 0.21.0' }),
    ],
  });
  const dto = await loadProviders();
  expect(dto.cards.map((c) => c.kind)).toEqual(['codex', 'gemini', 'qwen']);
  expect(dto.cards.map((c) => c.title)).toEqual(['Codex', 'Gemini CLI', 'Qwen Code']);
});

it('renders a runner kind this build has never heard of', async () => {
  getAgentsStatus.mockResolvedValue({
    agents: [entry({ kind: 'some-future-agent', label: 'Some Future Agent' })],
  });
  const dto = await loadProviders();
  // The card is complete — the gateway supplied every string it needs — and
  // only the accent falls back to the neutral default.
  const [card] = dto.cards;
  expect(card?.kind).toBe('some-future-agent');
  expect(card?.title).toBe('Some Future Agent');
  expect(card?.connected).toBe(true);
  expect(card?.subtitle).toBe('codex 1.2.3');
  expect(card?.accent).toBeTruthy();
});

it('reads saved models for every listed kind, including unknown ones', async () => {
  getAgentsStatus.mockResolvedValue({
    agents: [entry(), entry({ kind: 'some-future-agent', label: 'Some Future Agent' })],
  });
  getUserPrefs.mockResolvedValue({
    'model.codex.default': 'gpt-5',
    'model.some-future-agent.default': 'future-1',
    'model.some-future-agent.builder': 'future-2',
  });
  const dto = await loadProviders();
  // A local kinds table would have stranded the new runner's saved picks.
  expect(dto.savedModelByKind['some-future-agent']).toBe('future-1');
  expect(dto.subsystemModelByKind['some-future-agent']?.builder).toBe('future-2');
});

it('keeps a subsystem pin naming a kind this build does not know', async () => {
  getAgentsStatus.mockResolvedValue({ agents: [entry()] });
  getUserPrefs.mockResolvedValue({ 'runner.builder': 'some-future-agent' });
  const dto = await loadProviders();
  expect(dto.subsystemRunnerByKey.builder).toBe('some-future-agent');
});

it('shows the gateway’s install hint as the subtitle of an unavailable agent', async () => {
  getAgentsStatus.mockResolvedValue({
    agents: [
      entry({
        kind: 'acp',
        label: 'Custom ACP agent',
        available: false,
        version: undefined,
        hint: 'Set the ACP CLI’s binary path.',
        models: [],
        modelsStatus: 'empty',
        defaultModel: undefined,
      }),
    ],
  });
  const dto = await loadProviders();
  expect(dto.cards[0]?.connected).toBe(false);
  expect(dto.cards[0]?.subtitle).toBe('Set the ACP CLI’s binary path.');
});

it('flags loading only while a surface is genuinely still filling', async () => {
  getAgentsStatus.mockResolvedValue({
    agents: [entry({ models: [], modelsStatus: 'loading', defaultModel: undefined })],
  });
  const loading = await loadProviders();
  expect(loading.anyLoading).toBe(true);
  expect(loading.cards[0]?.modelsLoading).toBe(true);

  // A refresh over an existing list keeps showing it rather than blanking.
  getAgentsStatus.mockResolvedValue({ agents: [entry({ modelsStatus: 'loading' })] });
  const refreshing = await loadProviders();
  expect(refreshing.cards[0]?.modelsLoading).toBe(false);
});

it('falls back to an empty console when the gateway is unreachable', async () => {
  getAgentsStatus.mockRejectedValue(new Error('offline'));
  const dto = await loadProviders();
  expect(dto.cards).toEqual([]);
  expect(dto.anyLoading).toBe(false);
  expect(dto.selectedKind).toBe('codex');
});
