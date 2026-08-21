/*
 * Issue #567 Phase-0 evidence: emit one bounded capability record for every
 * registered harness. Missing CLIs are honest `available:false` rows rather
 * than omissions, so the dump always proves full registry coverage.
 */

import type { HarnessKind } from "@centraid/server/engine";

import { probeAcpCapabilities } from "../src/acp/backends/acp/probe-capabilities.js";
import { probeCliAvailability } from "../src/acp/preflight.js";
import { acpConfigFor, getHarness, HARNESSES } from "../src/acp/registry.js";

const harnessKinds = Object.keys(HARNESSES) as HarnessKind[];

const envKey = (kind: HarnessKind): string =>
  `CENTRAID_${kind.replaceAll("-", "_").toUpperCase()}_BIN`;

/**
 * Each probed kind spawns a CLI and (when reachable) sends one live
 * diagnostic prompt to that vendor's provider. Running all ~31 at once would
 * fire a burst of real, billable requests at a handful of providers, so the
 * dump is bounded — evidence collection must not look like an attack.
 */
const MAX_CONCURRENT_PROBES = 3;

type Row = Record<string, unknown> & { kind: HarnessKind };

async function probeOne(kind: HarnessKind): Promise<Row> {
  const configured = process.env[envKey(kind)];
  const availability = await probeCliAvailability(kind, configured);
  if (!availability.available) {
    return {
      kind,
      label: getHarness(kind).label,
      available: false,
      reachable: false,
      reason: configured
        ? `${configured} did not pass the version preflight`
        : "harness binary is not installed or configured on this host",
    };
  }
  const capabilities = await probeAcpCapabilities(
    acpConfigFor(kind, configured ? { binPath: configured } : {}),
    // This dump is the one place that WANTS the live prompt: the observed
    // usage/config-update/locations signals are its whole point.
    { timeoutMs: 20_000, probeLivePrompt: true }
  );
  return {
    kind,
    label: getHarness(kind).label,
    available: true,
    ...(availability.version ? { version: availability.version } : {}),
    ...capabilities,
  };
}

const rows: Row[] = [];
let next = 0;
await Promise.all(
  Array.from(
    { length: Math.min(MAX_CONCURRENT_PROBES, harnessKinds.length) },
    () => {
      const probeNext = async (): Promise<void> => {
        const index = next++;
        if (index >= harnessKinds.length) return;
        rows[index] = await probeOne(harnessKinds[index]!);
        return probeNext();
      };
      return probeNext();
    }
  )
);

for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
if (rows.length !== harnessKinds.length) process.exitCode = 1;
