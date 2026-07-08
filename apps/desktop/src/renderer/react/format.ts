// Pure display formatters for the React screens. Mirror the same-named
// helpers in app-format.ts (which reaches ambient globals the React island's
// tsconfig doesn't carry) — kept as a tiny self-contained copy so the React
// bundle stays decoupled from the vanilla shell. Keep the two in step.

/** Compact token count — 12_300 → "12k", 2_500_000 → "2.50M". */
export function insK(v: number): string {
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(2)}M`;
  }
  if (v >= 1_000) {
    return `${Math.round(v / 1_000)}k`;
  }
  return String(v);
}

/** USD with a sub-cent floor label. */
export function insUsd(n: number): string {
  if (n > 0 && n < 0.01) {
    return '<$0.01';
  }
  return `$${n.toFixed(2)}`;
}

/** Run-kind → display label. */
export function insKindLabel(kind: string): string {
  if (kind === 'chat') {
    return 'Chat';
  }
  if (kind === 'build') {
    return 'Build';
  }
  if (kind === 'automation') {
    return 'Automation';
  }
  return kind;
}

/** Coarse relative time. `now` is injectable so tests are deterministic. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) {
    return 'Recently';
  }
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) {
    return 'Recently';
  }
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  if (d < 30) {
    return `${d}d ago`;
  }
  return new Date(iso).toLocaleDateString();
}
