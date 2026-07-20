import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { tempDir } from '@centraid/test-kit/temp-dir';
import {
  RUNNER_KINDS,
  type RunnerKind,
  type TurnConfig,
  type TurnInput,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import { RUNNER_BACKENDS, acpConfigFor, getRunnerBackend } from './registry.ts';
import { resolveAdapterEntry } from './backends/acp/adapter-bin.ts';
import { runTurn } from './runtime.ts';

test('every known runner kind is registered with coherent metadata', () => {
  for (const kind of RUNNER_KINDS) {
    const backend = RUNNER_BACKENDS[kind];
    expect(backend, `missing backend for ${kind}`).toBeDefined();
    expect(backend.kind).toBe(kind);
    expect(backend.label.length).toBeGreaterThan(0);
    expect(backend.installHint.length).toBeGreaterThan(0);
    expect(typeof backend.runTurn).toBe('function');
    expect(typeof backend.enumerateModels).toBe('function');
  }
});

test('every kind keeps the USER-FACING CLI as its default bin; custom acp has none', () => {
  // Adapter-backed kinds included: preflight probes and version-hints the CLI
  // the user installs, never the ACP adapter we launch it through.
  expect(RUNNER_BACKENDS.codex.defaultBin).toBe('codex');
  expect(RUNNER_BACKENDS['claude-code'].defaultBin).toBe('claude');
  expect(RUNNER_BACKENDS.gemini.defaultBin).toBe('gemini');
  expect(RUNNER_BACKENDS.qwen.defaultBin).toBe('qwen');
  expect(RUNNER_BACKENDS.opencode.defaultBin).toBe('opencode');
  expect(RUNNER_BACKENDS.grok.defaultBin).toBe('grok');
  expect(RUNNER_BACKENDS.kimi.defaultBin).toBe('kimi');
  expect(RUNNER_BACKENDS.acp.defaultBin).toBeUndefined();
});

test('natively ACP-speaking kinds enumerate no models (no hardcoded provider ids)', async () => {
  for (const kind of ['gemini', 'qwen', 'opencode', 'grok', 'kimi', 'acp'] as const) {
    expect(await RUNNER_BACKENDS[kind].enumerateModels({})).toEqual([]);
  }
});

// ---- ACP-native kinds: launch invocation is the only thing that differs ----

test('opencode/grok/kimi launch ACP natively with their own subcommand', () => {
  // The ACP entry point is the whole per-kind difference, so it is pinned
  // exactly. `opencode acp` and `kimi acp` are SUBCOMMANDS: kimi's deprecated
  // `--acp` flag is single-session and has no session/load, which would break
  // resume, so a regression to the flag form must fail here.
  expect(acpConfigFor('opencode', {}).acpArgs).toEqual(['acp']);
  expect(acpConfigFor('grok', {}).acpArgs).toEqual(['agent', 'stdio']);
  expect(acpConfigFor('kimi', {}).acpArgs).toEqual(['acp']);

  for (const kind of ['opencode', 'grok', 'kimi'] as const) {
    const config = acpConfigFor(kind, { binPath: `/opt/bin/${kind}` });
    // No adapter: these CLIs are the ACP process, so binPath is the spawn
    // target rather than an adapter env var.
    expect(config.adapter).toBeUndefined();
    expect(config.binPath).toBe(`/opt/bin/${kind}`);
    // Claude tier vocabulary must not leak onto non-Claude runners.
    expect(config.resolveModel).toBeUndefined();
  }
});

test('opencode is never launched with --mdns, which would bind 0.0.0.0', () => {
  // `--mdns` defaults opencode's hostname to 0.0.0.0, exposing an
  // unauthenticated code-execution agent on the LAN. We contribute only `acp`.
  expect(acpConfigFor('opencode', {}).acpArgs).not.toContain('--mdns');
});

test('grok pins the ACP-capable minimum, not the string-sort-adjacent 0.2.11', () => {
  // 0.2.11 predates ACP support; only a string sort makes it look newer.
  expect(RUNNER_BACKENDS.grok.minVersion).toEqual({ major: 0, minor: 2, patch: 106 });
  expect(RUNNER_BACKENDS.opencode.minVersion).toEqual({ major: 1, minor: 18, patch: 4 });
  expect(RUNNER_BACKENDS.kimi.minVersion).toEqual({ major: 1, minor: 17, patch: 0 });
});

test('kimi install hint uses the Python toolchain, not npm', () => {
  // Every other hint is an `npm i -g`; kimi-cli is installed with uv or the
  // vendor script, so a copy-pasted npm hint would be wrong for it.
  const hint = RUNNER_BACKENDS.kimi.installHint;
  expect(hint).toMatch(/uv tool install kimi-cli/);
  expect(hint).not.toMatch(/npm/);
  // Grok's paid-subscription requirement is what makes an install-but-fail
  // runner self-explanatory, so it must stay in the hint.
  expect(RUNNER_BACKENDS.grok.installHint).toMatch(/SuperGrok|X Premium/);
});

// ---- issue #479: one integration path, per-kind launch config -------------

test('codex and claude-code drive the generic ACP client, not a bespoke backend', async () => {
  // The bespoke backends are gone; the only way to observe the transport from
  // here is that a turn now fails the way an ACP launch fails. Point each kind
  // at a binPath that cannot be an agent and confirm the ACP client's own
  // error surface (not a codex/claude-specific one) is what we get.
  for (const kind of ['codex', 'claude-code'] as const) {
    const events: TurnStreamEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await RUNNER_BACKENDS[kind].runTurn(
      {
        cwd: await tempDir('registry-acp-'),
        message: 'hi',
        extraSystemPrompt: '',
        abortSignal: controller.signal,
        onEvent: (e: TurnStreamEvent) => events.push(e),
      } as unknown as TurnInput,
      { prefs: { kind } },
    );
    expect(result.adapterKind).toBe(kind);
    // The ACP client always terminates an aborted turn with `aborted`.
    expect(events.map((e) => e.type)).toContain('aborted');
  }
});

test('the ACP-native kinds route their turns through the generic ACP client', async () => {
  // Same observation as the codex/claude-code case: an already-aborted turn
  // can only terminate with the ACP client's own `aborted` event, and nothing
  // is spawned on that path.
  for (const kind of ['opencode', 'grok', 'kimi'] as const) {
    const events: TurnStreamEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const result = await RUNNER_BACKENDS[kind].runTurn(
      {
        cwd: await tempDir('registry-acp-native-'),
        message: 'hi',
        extraSystemPrompt: '',
        abortSignal: controller.signal,
        onEvent: (e: TurnStreamEvent) => events.push(e),
      } as unknown as TurnInput,
      { prefs: { kind } },
    );
    expect(result.adapterKind).toBe(kind);
    expect(events.map((e) => e.type)).toContain('aborted');
  }
});

test('codex launches headless; claude launches in bypass mode; binPath targets the CLI', () => {
  // The launch config is what makes each adapter behave like the bespoke
  // backend it replaced, so it is asserted explicitly rather than inferred.
  const codex = acpConfigFor('codex', { binPath: '/opt/bin/codex' });
  expect(codex.adapter?.packageName).toBe('@agentclientprotocol/codex-acp');
  // Parity with the retired `approvalPolicy:'never'` + full-access sandbox.
  expect(codex.adapter?.env).toEqual({ INITIAL_AGENT_MODE: 'agent-full-access' });
  // binPath now means "the agent CLI", so it rides in as CODEX_PATH.
  expect(codex.adapter?.binPathEnvVar).toBe('CODEX_PATH');
  expect(codex.binPath).toBe('/opt/bin/codex');
  expect(codex.acpArgs).toEqual([]);

  const claude = acpConfigFor('claude-code', { binPath: '/opt/bin/claude' });
  expect(claude.adapter?.packageName).toBe('@agentclientprotocol/claude-agent-acp');
  // Parity with the retired `permissionMode: 'bypassPermissions'`.
  expect(claude.adapter?.sessionModeId).toBe('bypassPermissions');
  // The adapter refuses bypass for a root process unless IS_SANDBOX is set.
  expect(claude.adapter?.bypassNeedsSandboxWhenRoot).toBe(true);
  expect(claude.adapter?.binPathEnvVar).toBe('CLAUDE_CODE_EXECUTABLE');
  // Capability tiers still resolve to the CLI's aliases before matching.
  expect(claude.resolveModel?.('smart')).toBe('opus');

  // Natively ACP-speaking kinds carry no adapter at all.
  expect(acpConfigFor('gemini', {}).adapter).toBeUndefined();
});

test('both adapter packages resolve to a real executable entry point', () => {
  // Guards the "no runtime npx -y" rule: the adapters must be installed
  // dependencies whose bin we can resolve offline.
  for (const pkg of ['@agentclientprotocol/codex-acp', '@agentclientprotocol/claude-agent-acp']) {
    const entry = resolveAdapterEntry(pkg);
    expect(existsSync(entry)).toBe(true);
  }
});

test('getRunnerBackend rejects an unknown kind', () => {
  expect(() => getRunnerBackend('nope' as RunnerKind)).toThrow(/no runner backend/);
});

test('runTurn dispatches to the backend for the configured kind', async () => {
  // Stub a backend in the table and confirm runTurn routes to it, threading
  // input/config through unchanged.
  const original = RUNNER_BACKENDS.acp;
  let seen: { input?: TurnInput; config?: TurnConfig } = {};
  RUNNER_BACKENDS.acp = {
    ...original,
    runTurn: async (input, config) => {
      seen = { input, config };
      return { adapterKind: 'acp', sessionId: 'stub-session' };
    },
  };
  try {
    const input = {
      cwd: '/tmp/x',
      message: 'hi',
      extraSystemPrompt: '',
      abortSignal: new AbortController().signal,
      onEvent: () => undefined,
    } as unknown as TurnInput;
    const config: TurnConfig = { prefs: { kind: 'acp', binPath: '/bin/whatever' } };
    const result = await runTurn(input, config);
    expect(result).toEqual({ adapterKind: 'acp', sessionId: 'stub-session' });
    expect(seen.config?.prefs.kind).toBe('acp');
    expect(seen.input?.message).toBe('hi');
  } finally {
    RUNNER_BACKENDS.acp = original;
  }
});

test('runTurn rejects an unknown configured kind', async () => {
  const input = {
    cwd: '/tmp/x',
    message: 'hi',
    extraSystemPrompt: '',
    abortSignal: new AbortController().signal,
    onEvent: () => undefined,
  } as unknown as TurnInput;
  const config = { prefs: { kind: 'bogus' } } as unknown as TurnConfig;
  await expect(runTurn(input, config)).rejects.toThrow(/unknown runner kind/);
});
