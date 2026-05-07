// Mirrors renderer/store.js DateUtil.

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function formatDate(
  d: string,
  opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', weekday: 'long' },
): string {
  return new Date(d).toLocaleDateString(undefined, opts);
}

export function formatShort(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
