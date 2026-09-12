// THE AUTOMATIONS PARITY BUNDLE, GENERATED FROM v0 (#1020, wave 4 lane
// automations, D-1020-D3-6).
//
// The emitter is also the oracle: `tests/quality/automations-parity.contract.test.ts`
// calls `buildAutomationsParity()` and either WRITES the files (with
// `CENTRAID_WRITE_CONTRACTS=1`) or asserts they match. So "the fixture passes
// in v0 too" is not a second suite that could rot — it is that test, and it
// fails the moment a v0 function's answer moves.
//
// FIVE FILES, and what each one pins:
//
// | File | v0 function | The property |
// |---|---|---|
// | `cron-cases.json` | `cronMatches` | every field form, Vixie OR, the fail-safe, and DST in three zones |
// | `cron-windows.json` | `readCronCursor` | the backfill classes, the gap, and the fall-back dedupe |
// | `manifests.json` | `parseManifest` | the five kinds, the pending webhook, and the watch refusals |
// | `gate.json` | `decideEnrichmentGate` | the tier x lane grid, both provenance answers |
// | `recipes.json` | `system-recognition.ts` + `models.lock.json` | the tiers, the templates and the pinned weights |
//
// ONE DELIBERATE ASYMMETRY, and it is the lane's central finding. Every case
// here names its zone explicitly, because v0's third resolution tier is the
// HOST clock and a fixture whose answer depends on the machine that generated
// it is not a fixture. `cron-cases.json` carries one case named
// `utc-host-third-tier` that records what v0 answers with NO zone at all on a
// UTC host — the answer a VPS gives — beside what the vault's zone would have
// answered. The Rust port has no third tier at all, so it answers the second
// column; the fixture carries both so the difference is a row rather than a
// paragraph.

import {
  cronCases,
  cronWindows,
  gateGrid,
  manifests,
  recipeCatalogue,
  utcHostCase,
} from "./automations-parity-cases.js";
import type { CronCase, WindowCase } from "./automations-parity-cases.js";

/** Where the bundle is written, relative to the repository root. */
export const AUTOMATIONS_PARITY_DIR = "contracts/automations";

/**
 * The v0 modules, imported through COMPUTED specifiers.
 *
 * Literal imports pull the whole `packages/server` graph into whatever
 * TypeScript program type-checks this file, and no program that can also see
 * `contracts/` has that tsconfig — the same reason Tally's and Photos'
 * generators compute theirs.
 */
async function loadV0(): Promise<{
  cronMatches: (expr: string, date: Date, timeZone?: string) => boolean;
  readCronCursor: (
    schedules: readonly unknown[],
    cursor: { positionJson?: string } | undefined,
    at: Date
  ) => {
    elements: { position: string; occurredAt: number }[];
    positionJson?: string;
    skipped?: number;
    gapReason?: string;
  };
  parseManifest: (text: string) => unknown;
  decideEnrichmentGate: (input: unknown) => unknown;
  SYSTEM_AUTOMATION_IDS: readonly string[];
  BUNDLED_OPTIONAL_AUTOMATION_IDS: readonly string[];
  ENRICH_TIERS: readonly string[];
  ENRICH_LANES: readonly string[];
  MAX_BACKFILL_OCCURRENCES: number;
}> {
  const base = "../../packages/server/src";
  const [cronMatch, cronCursor, manifest, gate, recognition] =
    await Promise.all([
      import(`${base}/automation/fire/cron-match.ts`),
      import(`${base}/automation/fire/cron-cursor.ts`),
      import(`${base}/automation/manifest/manifest.ts`),
      import(`${base}/automation/fire/enrich-gate.ts`),
      import(`${base}/enrich/system-recognition.ts`),
    ]);
  return {
    cronMatches: (cronMatch as { cronMatches: never }).cronMatches,
    readCronCursor: (cronCursor as { readCronCursor: never }).readCronCursor,
    parseManifest: (manifest as { parseManifest: never }).parseManifest,
    MAX_BACKFILL_OCCURRENCES: (manifest as { MAX_BACKFILL_OCCURRENCES: never })
      .MAX_BACKFILL_OCCURRENCES,
    decideEnrichmentGate: (gate as { decideEnrichmentGate: never })
      .decideEnrichmentGate,
    ENRICH_TIERS: (gate as { ENRICH_TIERS: never }).ENRICH_TIERS,
    ENRICH_LANES: (gate as { ENRICH_LANES: never }).ENRICH_LANES,
    SYSTEM_AUTOMATION_IDS: (recognition as { SYSTEM_AUTOMATION_IDS: never })
      .SYSTEM_AUTOMATION_IDS,
    BUNDLED_OPTIONAL_AUTOMATION_IDS: (
      recognition as { BUNDLED_OPTIONAL_AUTOMATION_IDS: never }
    ).BUNDLED_OPTIONAL_AUTOMATION_IDS,
  };
}

/** Canonical JSON: sorted keys, two-space indent, one trailing newline. */
export function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])])
      );
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export interface AutomationsParityBundle {
  cronCases: { cases: CronCase[]; finding: unknown };
  cronWindows: { maxBackfillOccurrences: number; cases: WindowCase[] };
  manifests: unknown[];
  gate: { tiers: string[]; lanes: string[]; grid: unknown[] };
  recipes: unknown;
}

/** Build the whole bundle from the live v0 tree. */
export async function buildAutomationsParity(): Promise<AutomationsParityBundle> {
  const v0 = await loadV0();
  return {
    cronCases: {
      cases: cronCases(v0.cronMatches),
      finding: utcHostCase(v0.cronMatches),
    },
    cronWindows: {
      maxBackfillOccurrences: v0.MAX_BACKFILL_OCCURRENCES,
      cases: cronWindows(v0.readCronCursor),
    },
    manifests: manifests(v0.parseManifest),
    gate: {
      tiers: [...v0.ENRICH_TIERS],
      lanes: [...v0.ENRICH_LANES],
      grid: gateGrid(v0.decideEnrichmentGate, v0.ENRICH_TIERS, v0.ENRICH_LANES),
    },
    recipes: recipeCatalogue(
      v0.SYSTEM_AUTOMATION_IDS,
      v0.BUNDLED_OPTIONAL_AUTOMATION_IDS
    ),
  };
}

/** The five files, and the slice of the bundle each one carries. */
export const AUTOMATIONS_PARITY_FILES = [
  "cron-cases.json",
  "cron-windows.json",
  "manifests.json",
  "gate.json",
  "recipes.json",
] as const;

export function payloadsFor(
  bundle: AutomationsParityBundle
): Record<(typeof AUTOMATIONS_PARITY_FILES)[number], string> {
  return {
    "cron-cases.json": stableJson(bundle.cronCases),
    "cron-windows.json": stableJson(bundle.cronWindows),
    "manifests.json": stableJson(bundle.manifests),
    "gate.json": stableJson(bundle.gate),
    "recipes.json": stableJson(bundle.recipes),
  };
}
