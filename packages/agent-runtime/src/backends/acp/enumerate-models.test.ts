// The generic ACP model probe (issue #484). Driven against the scripted
// `fake-acp-agent.mjs`, the same fixture the turn backend uses — so happy
// path, no-model-option, AUTH_REQUIRED, and missing-binary are all exercised
// against a real launch → initialize → session/new exchange, not a mock.

import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateAcpModels, mapOfferedModels } from './enumerate-models.js';
import type { AcpTurnConfig } from './types.js';

const FAKE_AGENT = fileURLToPath(new URL('fake-acp-agent.mjs', import.meta.url));

/** An `AcpTurnConfig` that launches the fake agent (native path, no adapter). */
function fakeConfig(extraArgs: string[], over: Partial<AcpTurnConfig> = {}): AcpTurnConfig {
  return { kind: 'acp', acpArgs: [], binPath: FAKE_AGENT, extraArgs, ...over };
}

// ---- happy path -----------------------------------------------------------

test('maps the agent’s advertised model options to RunnerModel[]', async () => {
  const models = await enumerateAcpModels(fakeConfig(['--mode=normal']));
  // The fake advertises a `model` select with a default + one more, exactly
  // the shape both real adapters emit.
  expect(models).toEqual([
    { id: 'fake-model-default', name: 'Default', default: true },
    { id: 'fake-opus-9-1', name: 'Most capable' },
  ]);
});

// ---- best-effort empties --------------------------------------------------

test('an agent with no model option enumerates []', async () => {
  const models = await enumerateAcpModels(fakeConfig(['--mode=normal', '--no-model-option']));
  expect(models).toEqual([]);
});

test('AUTH_REQUIRED (-32000) from session/new enumerates [] rather than throwing', async () => {
  const models = await enumerateAcpModels(fakeConfig(['--mode=auth']));
  expect(models).toEqual([]);
});

test('a missing binary enumerates [] rather than throwing', async () => {
  const dir = await tempDir('acp-enum-missing-');
  const models = await enumerateAcpModels(
    fakeConfig(['--mode=normal'], { binPath: path.join(dir, 'does-not-exist') }),
  );
  expect(models).toEqual([]);
});

// ---- teardown -------------------------------------------------------------

test('the child process is dead once enumeration resolves', async () => {
  const dir = await tempDir('acp-enum-pid-');
  const pidMarker = path.join(dir, 'pid');
  const models = await enumerateAcpModels(
    fakeConfig(['--mode=normal', `--pid-marker=${pidMarker}`]),
  );
  expect(models.length).toBeGreaterThan(0);

  const pid = Number((await fs.readFile(pidMarker, 'utf8')).trim());
  expect(pid).toBeGreaterThan(0);
  // signal 0 probes liveness without delivering a signal: ESRCH means the
  // child has already been reaped, which is the invariant we require.
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
});

// ---- mapping unit ---------------------------------------------------------

test('mapOfferedModels dedupes by id, drops blanks, and flags the current value', () => {
  const models = mapOfferedModels(
    [
      { value: ' a ', name: 'Alpha' },
      { value: 'a', name: 'Alpha dup' }, // deduped
      { value: '', name: 'blank' }, // dropped
      { value: 'b', name: 'b' }, // name === id → name dropped
    ],
    'a',
  );
  expect(models).toEqual([{ id: 'a', name: 'Alpha', default: true }, { id: 'b' }]);
});
