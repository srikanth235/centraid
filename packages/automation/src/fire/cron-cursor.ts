import type { AutomationTriggerCursor } from '@centraid/app-engine';
import type { CursorReadResult } from './cursor-engine.js';
import { cronMatches } from './cron-match.js';

export function floorMinute(time: number): number {
  return Math.floor(time / 60_000) * 60_000;
}

/** Pure virtual cron stream over `(from, to]`, ordered oldest-first. */
export function dueInstants(expr: string, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const fromMs = floorMinute(from.getTime());
  const toMs = floorMinute(to.getTime());
  for (let instant = fromMs + 60_000; instant <= toMs; instant += 60_000) {
    const candidate = new Date(instant);
    if (cronMatches(expr, candidate)) out.push(candidate);
  }
  return out;
}

/** Collapse a virtual cron window to its latest due instant and gap metadata. */
export function readCronCursor(
  expr: string,
  cursor: AutomationTriggerCursor | undefined,
  at: Date,
): CursorReadResult {
  const to = floorMinute(at.getTime());
  let parsed = to - 60_000;
  if (cursor?.positionJson) {
    try {
      parsed = Number(JSON.parse(cursor.positionJson));
    } catch {
      parsed = Number.NaN;
    }
  }
  const from = Number.isFinite(parsed) ? parsed : to - 60_000;
  const due = dueInstants(expr, new Date(from), new Date(to));
  const latest = due.at(-1);
  return {
    elements: latest ? [{ position: String(latest.getTime()), occurredAt: latest.getTime() }] : [],
    positionJson: JSON.stringify(to),
    windowFrom: from,
    windowTo: to,
    skipped: Math.max(0, due.length - 1),
    ...(due.length > 1 ? { gapReason: 'scheduler_gap' } : {}),
  };
}
