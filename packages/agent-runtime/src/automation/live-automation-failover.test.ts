/*
 * Opt-in live automation-fire failover smoke for issue #567. The primary is
 * deliberately configured with a missing binary; the fallback is a real,
 * locally-authenticated provider. The test then audits the shared ledger to
 * prove the failed and successful attempts are distinct turns and that the
 * handoff notice names the failure class.
 *
 * This is skipped by the ordinary suite. Run it through
 * `bun run --cwd packages/agent-runtime test:live-automation-failover`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConversationStore, makeJournalDbProvider } from '@centraid/app-engine';
import { expect, test } from 'vitest';
import type { RunnerKind } from '../types.js';
import { RUNNER_BACKENDS } from '../registry.js';
import { runAutomation } from './run-automation.js';

const isRunnerKind = (value: string): value is RunnerKind => Object.hasOwn(RUNNER_BACKENDS, value);

test.skipIf(process.env.CENTRAID_LIVE_AUTOMATION !== '1')(
  'a missing primary binary advances a real automation fire to its fallback',
  async () => {
    const primaryValue = process.env.CENTRAID_LIVE_FAILOVER_PRIMARY ?? 'acp';
    const fallbackValue = process.env.CENTRAID_LIVE_FAILOVER_RUNNER ?? 'codex';
    if (!isRunnerKind(primaryValue) || !isRunnerKind(fallbackValue)) {
      throw new Error(`Unknown failover route: ${primaryValue}->${fallbackValue}`);
    }
    if (primaryValue === fallbackValue)
      throw new Error('Primary and fallback runners must differ.');
    const primary = primaryValue;
    const fallback = fallbackValue;
    const root = await mkdtemp(path.join(tmpdir(), 'centraid-live-automation-failover-'));
    const appsDir = path.join(root, 'state-apps');
    const codeAppsDir = path.join(root, 'code-apps');
    const journalDbFile = path.join(root, 'journal.db');
    const automationDir = path.join(codeAppsDir, 'smoke', 'automations', 'fallback');
    const baseRunId = 'live-automation-567';

    try {
      await mkdir(automationDir, { recursive: true });
      await writeFile(
        path.join(automationDir, 'automation.json'),
        JSON.stringify(
          {
            name: 'Live fallback smoke',
            version: '0.1.0',
            enabled: true,
            prompt: 'Verify automation fire failover.',
            triggers: [{ kind: 'cron', expr: '0 0 * * *' }],
            requires: {},
            history: { keep: { count: 10 } },
            generated: { by: 'issue-567-live-smoke', at: '2026-07-27' },
          },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(automationDir, 'handler.js'),
        `export default async ({ ctx }) => ({
          output: await ctx.agent({
            prompt: 'Reply with exactly AUTOMATION_FAILOVER_OK_567. Do not use tools.'
          })
        });`,
      );

      const failovers: Array<{
        from: RunnerKind;
        to: RunnerKind;
        failureClass: string;
        failedRunId: string;
        nextRunId: string;
      }> = [];
      const result = await runAutomation({
        automationRef: 'smoke/fallback',
        runId: baseRunId,
        appsDir,
        codeAppsDir,
        journalDbFile,
        runner: primary,
        runnerLadder: [primary, fallback],
        runnerPrefsFor: async (runner) => {
          if (runner === primary) {
            return { kind: runner, binPath: path.join(root, 'missing-codex-binary') };
          }
          const binPath =
            runner === 'codex'
              ? process.env.CENTRAID_CODEX_BIN
              : runner === 'claude-code'
                ? process.env.CENTRAID_CLAUDE_BIN
                : runner === 'gemini'
                  ? process.env.CENTRAID_GEMINI_BIN
                  : runner === 'opencode'
                    ? process.env.CENTRAID_OPENCODE_BIN
                    : undefined;
          return { kind: runner, ...(binPath ? { binPath } : {}) };
        },
        onFailover: (event) => failovers.push(event),
        timeoutMs: 90_000,
        triggerKind: 'manual',
        triggerOrigin: 'manual',
      });

      const fallbackRunId = `${baseRunId}:failover:1:${fallback}`;
      const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
      const primaryTurn = store.getTurn(baseRunId);
      const fallbackTurn = store.getTurn(fallbackRunId);
      store.close();

      const answer = result.outcome.output;
      const output =
        typeof answer === 'string'
          ? answer
          : answer && typeof answer === 'object' && 'output' in answer
            ? String(answer.output)
            : (JSON.stringify(answer) ?? '');
      const audit = {
        check: 'automation-failover',
        route: `broken-${primary}->${fallback}`,
        markerObserved: output.includes('AUTOMATION_FAILOVER_OK_567'),
        primary: primaryTurn
          ? { turnId: primaryTurn.turnId, ok: primaryTurn.ok, error: primaryTurn.error }
          : null,
        fallback: fallbackTurn
          ? {
              turnId: fallbackTurn.turnId,
              ok: fallbackTurn.ok,
              note: fallbackTurn.note,
              error: fallbackTurn.error,
            }
          : null,
        failovers,
      };
      process.stdout.write(`${JSON.stringify(audit)}\n`);

      expect(result.outcome.ok).toBe(true);
      expect(output).toContain('AUTOMATION_FAILOVER_OK_567');
      expect(primaryTurn).toMatchObject({ turnId: baseRunId, ok: false });
      expect(primaryTurn?.error).toContain('centraid-agent-failure:');
      expect(fallbackTurn).toMatchObject({ turnId: fallbackRunId, ok: true });
      expect(fallbackTurn?.note).toContain('spawn');
      expect(failovers).toEqual([
        expect.objectContaining({
          from: primary,
          to: fallback,
          failureClass: 'spawn',
          failedRunId: baseRunId,
          nextRunId: fallbackRunId,
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
