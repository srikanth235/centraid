/*
 * Issue #567 Phase-0 evidence: emit one bounded capability record for every
 * registered runner. Missing CLIs are honest `available:false` rows rather
 * than omissions, so the dump always proves full registry coverage.
 */

import type { RunnerKind } from '@centraid/app-engine';
import { probeAcpCapabilities } from '../src/backends/acp/probe-capabilities.js';
import { acpConfigFor, getRunnerBackend, RUNNER_BACKENDS } from '../src/registry.js';
import { probeCliAvailability } from '../src/preflight.js';

const runnerKinds = Object.keys(RUNNER_BACKENDS) as RunnerKind[];

const envKey = (kind: RunnerKind): string =>
  `CENTRAID_${kind.replaceAll('-', '_').toUpperCase()}_BIN`;

const rows = await Promise.all(
  runnerKinds.map(async (kind) => {
    const configured = process.env[envKey(kind)];
    const availability = await probeCliAvailability(kind, configured);
    if (!availability.available) {
      return {
        kind,
        label: getRunnerBackend(kind).label,
        available: false,
        reachable: false,
        reason: configured
          ? `${configured} did not pass the version preflight`
          : 'runner binary is not installed or configured on this host',
      };
    }
    const capabilities = await probeAcpCapabilities(
      acpConfigFor(kind, configured ? { binPath: configured } : {}),
      { timeoutMs: 20_000 },
    );
    return {
      kind,
      label: getRunnerBackend(kind).label,
      available: true,
      ...(availability.version ? { version: availability.version } : {}),
      ...capabilities,
    };
  }),
);

for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
if (rows.length !== runnerKinds.length) process.exitCode = 1;
