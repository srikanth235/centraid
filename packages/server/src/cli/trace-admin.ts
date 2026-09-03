/*
 * `centraid-gateway trace last` (#927 P1) — the developer's waterfall.
 *
 * ONE COMMAND, on the owner's own machine, reading the owner's own file. It
 * opens no socket, contacts no daemon, and there is no route that would serve
 * this: the records live inside the vault directory (`<vaultDir>/<vaultId>/
 * diagnostics/traces.jsonl`) and are purged with the vault. That is the whole
 * egress story, and it is a property of where the file is rather than of a
 * policy someone has to remember.
 *
 * It renders through `waterfall()` from `@centraid/core/protocol` — the same
 * pure helper the journey rigs use — so what a developer reads on their machine
 * and what a rig asserts in CI are the same rows, laid out the same way.
 *
 * Spans are OFF by default. A vault with no records prints how to turn them on
 * rather than an empty table, because "nothing here" and "I never recorded
 * anything" are different answers and only one of them is a bug.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { waterfall } from "@centraid/core/protocol";
import type { TraceRecord, WaterfallRow } from "@centraid/core/protocol";

import { TraceStore, traceFileFor } from "../serve/trace-store.js";
import { jsonFail, runJson } from "./json-cli.js";
import type { Fail } from "./json-cli.js";
import { daemonLayoutFor } from "./paths.js";

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * Every mounted vault under the registry root, newest trace file first, so
 * "the last tap" means the last tap on this machine and not the last tap in
 * whichever vault happens to sort first.
 */
export function vaultDirsByTraceRecency(vaultDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(vaultDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(vaultDir, entry.name));
  } catch {
    return [];
  }
  return entries
    .map((dir) => {
      try {
        return { dir, at: statSync(traceFileFor(dir)).mtimeMs };
      } catch {
        return { dir, at: -1 };
      }
    })
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.dir);
}

/** The waterfall as text: indented by depth, offsets relative to the root. */
export function renderWaterfall(record: TraceRecord): string {
  const rows: WaterfallRow[] = waterfall(record);
  const total = record.root.endMs - record.root.startMs;
  const lines = rows.map((row) => {
    const name = `${"  ".repeat(row.depth)}${row.name}`;
    return [
      name.padEnd(44),
      row.hop.padEnd(8),
      `+${row.offsetMs.toFixed(2)}ms`.padStart(12),
      `${row.durationMs.toFixed(2)}ms`.padStart(11),
    ].join(" ");
  });
  const counters = Object.entries(record.counters)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("  ");
  return [
    `trace ${record.root.traceId}${record.journey ? ` journey=${record.journey}` : ""}`,
    `${"span".padEnd(44)} ${"hop".padEnd(8)} ${"offset".padStart(12)} ${"duration".padStart(11)}`,
    ...lines,
    `total ${total.toFixed(2)}ms`,
    counters.length > 0 ? `work  ${counters}` : "work  (none recorded)",
  ].join("\n");
}

export async function commandTrace(
  argv: readonly string[],
  realFail: Fail
): Promise<void> {
  const json = argv.includes("--json");
  const fail = jsonFail(json, realFail);
  await runJson(json, realFail, () => {
    const [sub] = argv;
    if (sub !== "last") {
      fail(
        `usage: centraid-gateway trace last [--data-dir <path>] [--vault-dir <path>] [--json] [--clear]`,
        2
      );
    }
    const explicit = option(argv, "--vault-dir");
    const dataDir = option(argv, "--data-dir") ?? ".";
    const candidates = explicit
      ? [explicit]
      : vaultDirsByTraceRecency(daemonLayoutFor(dataDir).vaultDir);
    for (const dir of candidates) {
      const store = new TraceStore(dir);
      const record = store.last();
      if (!record) continue;
      if (argv.includes("--clear")) store.clear();
      process.stdout.write(
        json
          ? `${JSON.stringify({ ok: true, vaultDir: dir, record })}\n`
          : `${renderWaterfall(record)}\n`
      );
      return;
    }
    fail(
      "no traces recorded on this machine. Spans are off by default: start the gateway with CENTRAID_TRACE=1 (and optionally CENTRAID_TRACE_SAMPLE_EVERY=N), take the action, then run this again.",
      1
    );
  });
}
