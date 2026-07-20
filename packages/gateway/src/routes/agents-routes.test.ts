/*
 * The agents-status route reports one entry per REGISTERED runner kind — the
 * list is derived from the runner-backend registry, not a hardcoded
 * codex/claude pair, so a kind added to the registry shows up here without
 * touching this route. These tests cover the list shape and the resolver
 * plumbing; the CLI probe itself runs for real and is not asserted on (its
 * result varies by host).
 */

import { expect, test } from 'vitest';
import { RUNNER_KINDS } from '@centraid/app-engine';
import { readAgentsStatus } from './agents-routes.ts';

test('reports one entry per registered runner kind', async () => {
  const s = await readAgentsStatus();
  expect(s.agents.map((a) => a.kind).sort()).toEqual([...RUNNER_KINDS].sort());
  // Every entry is self-describing: the client renders off these, never off a
  // local table keyed on kinds it happens to know.
  for (const agent of s.agents) {
    expect(typeof agent.label).toBe('string');
    expect(agent.label.length).toBeGreaterThan(0);
    expect(typeof agent.available).toBe('boolean');
    expect(agent.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
  }
});

test('carries no per-agent tools surface — that retired with the drawer', async () => {
  const s = await readAgentsStatus({
    resolveModels: async () => ({ list: [], status: 'ready' }),
  });
  for (const agent of s.agents) {
    expect('tools' in agent).toBe(false);
    expect('toolsStatus' in agent).toBe(false);
  }
  expect(JSON.stringify(s)).not.toContain('Tools');
});

test('an unavailable agent carries the install hint; an available one does not', async () => {
  // `acp` has no default binary, so it is always unavailable without a
  // configured path — a stable way to assert the unavailable branch on any host.
  const s = await readAgentsStatus();
  const acp = s.agents.find((a) => a.kind === 'acp');
  expect(acp?.available).toBe(false);
  expect(acp?.hint).toBeTruthy();
  for (const agent of s.agents) {
    if (agent.available) expect(agent.hint).toBeUndefined();
  }
});

test('probes the configured binary for a kind when one is supplied', async () => {
  const seen: Array<string | undefined> = [];
  await readAgentsStatus({
    binPathFor: (kind) => {
      seen.push(kind);
      return kind === 'acp' ? '/nonexistent/custom-agent' : undefined;
    },
  });
  // Every registered kind is offered the override, not just a known pair.
  expect(seen.sort()).toEqual([...RUNNER_KINDS].sort());
});

test('defaults every agent to an empty model surface when no resolver is supplied', async () => {
  const s = await readAgentsStatus();
  for (const agent of s.agents) {
    expect(agent.models).toEqual([]);
    expect(agent.modelsStatus).toBe('empty');
    expect(agent.defaultModel).toBeUndefined();
  }
});

test('attaches each agent’s models + status from the resolver', async () => {
  const calls: Array<[string, boolean]> = [];
  const s = await readAgentsStatus({
    resolveModels: async (kind, refresh) => {
      calls.push([kind, refresh]);
      return { list: [{ id: `${kind}-x`, name: 'X', default: true }], status: 'ready' };
    },
  });
  // Asked once per registered kind, and each answer landed on its own entry.
  expect(calls.map(([k]) => k).sort()).toEqual([...RUNNER_KINDS].sort());
  const codex = s.agents.find((a) => a.kind === 'codex');
  expect(codex?.models).toEqual([{ id: 'codex-x', name: 'X', default: true }]);
  expect(codex?.modelsStatus).toBe('ready');
  // The catalog's own default is surfaced so a picker can name what it inherits.
  expect(codex?.defaultModel).toBe('codex-x');
});

test('surfaces a loading surface so the client knows to poll', async () => {
  const s = await readAgentsStatus({
    resolveModels: async () => ({ list: [], status: 'loading' }),
  });
  expect(s.agents.every((a) => a.modelsStatus === 'loading')).toBe(true);
});

test('threads the refresh flag to the resolver for every agent', async () => {
  const seen: boolean[] = [];
  await readAgentsStatus({
    resolveModels: async (_kind, refresh) => {
      seen.push(refresh);
      return { list: [], status: 'loading' };
    },
    refresh: true,
  });
  expect(seen).toEqual(RUNNER_KINDS.map(() => true));
});

test('a throwing resolver degrades that agent to an empty list', async () => {
  const s = await readAgentsStatus({
    resolveModels: async (kind) => {
      if (kind === 'codex') throw new Error('boom');
      return { list: [{ id: 'ok' }], status: 'ready' };
    },
  });
  const codex = s.agents.find((a) => a.kind === 'codex');
  expect(codex?.models).toEqual([]);
  expect(codex?.modelsStatus).toBe('empty');
  // One agent's failure never takes the rest of the list down with it.
  expect(s.agents.find((a) => a.kind === 'gemini')?.modelsStatus).toBe('ready');
});
