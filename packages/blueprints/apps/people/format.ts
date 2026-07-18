// Formatting + identity/status helpers — pure functions of their arguments
// (verbatim mapping from the People prototype), plus `data.lists` lookups
// (`listName`) that take `data` as a plain argument rather than a closure.
// None hold or mutate app state. Split out of app.tsx so the orchestrator and
// every component (Sidebar/Grid/List/Details/Journal/Activity) can call these
// directly instead of threading them all as props.
import type { AppData, Person, Reminder } from './types.ts';

// The per-contact palette (prototype). Avatar hues come from here or a name
// hash; a list's chrome dot hashes its id into the same eight colours so a
// list is always the same colour.
export const PALETTE = [
  '#7C5BD9',
  '#2EA098',
  '#4E68DD',
  '#E89A3C',
  '#5C8A4E',
  '#E0567A',
  '#B47B3F',
  '#5C677D',
];

const DAY = 86400000;

/** The minimal cadence-bearing shape `daysSince`/`statusOf` need — every
 *  `Person` and `DetailPerson` satisfies it structurally. */
export interface CadencePerson {
  last_contacted_at?: string | null;
  created_at?: string;
  cadence_days?: number;
  avatar_color?: string | null;
  name?: string;
  reminders?: Reminder[];
}

// Days since last contact — derived from the timestamp (the prototype held an
// in-memory lastDays; here it's real).
export function daysSince(p: CadencePerson): number {
  const iso = p.last_contacted_at ?? p.created_at;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

export function fmt(d: number): string {
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return d + ' days ago';
  if (d < 14) return 'last week';
  if (d < 31) return Math.round(d / 7) + ' weeks ago';
  if (d < 61) return 'last month';
  return Math.round(d / 30) + ' months ago';
}
export function shortFmt(d: number): string {
  if (d <= 0) return 'now';
  if (d < 7) return d + 'd';
  if (d < 31) return Math.round(d / 7) + 'w';
  return Math.round(d / 30) + 'mo';
}
export function inFmt(d: number): string {
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d < 14) return 'in ' + d + ' days';
  if (d < 60) return 'in ' + Math.round(d / 7) + ' weeks';
  return 'in ' + Math.round(d / 30) + ' months';
}
export function cadence(d: number): string {
  return (
    (
      {
        7: 'weekly',
        14: 'every 2 weeks',
        21: 'every 3 weeks',
        30: 'monthly',
        45: 'every 6 weeks',
        60: 'every 2 months',
        90: 'quarterly',
      } as Record<number, string>
    )[d] || 'every ' + d + ' days'
  );
}

// A "MM-DD" annual date → days until its next occurrence from today.
export function daysUntilAnnual(monthDay: string | null | undefined): number {
  const parts = String(monthDay ?? '').split('-');
  if (parts.length !== 2) return 999;
  const mo = Number(parts[0]) - 1;
  const da = Number(parts[1]);
  if (Number.isNaN(mo) || Number.isNaN(da)) return 999;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), mo, da);
  if (next < today) next = new Date(now.getFullYear() + 1, mo, da);
  return Math.round((next.getTime() - today.getTime()) / DAY);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtMonthDay(monthDay: string | null | undefined): string {
  const parts = String(monthDay ?? '').split('-');
  if (parts.length !== 2) return String(monthDay ?? '');
  const mo = Number(parts[0]) - 1;
  const da = Number(parts[1]);
  if (Number.isNaN(mo) || Number.isNaN(da) || mo < 0 || mo > 11) return String(monthDay);
  return `${MONTHS[mo]} ${da}`;
}
// A yyyy-mm-dd date value → "MM-DD".
export function dateInputToMonthDay(v: string | null | undefined): string | null {
  const parts = String(v ?? '').split('-');
  if (parts.length !== 3) return null;
  return `${parts[1]}-${parts[2]}`;
}

// A journal ENTRY carries a "YYYY-MM-DD" date; an AUTO row carries an iso.
export function fmtJournalDate(v: string | null | undefined): string {
  if (!v) return '';
  const s = String(v);
  const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Days since an iso, for activity/interaction relative time.
export function daysSinceIso(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

// ---------- Identity helpers ----------

export function hashInt(s: string | null | undefined): number {
  let n = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) n = (n * 31 + str.charCodeAt(i)) >>> 0;
  return n;
}
// Avatar hue: honour a stored colour, else derive from the name hash.
export function avatarColor(p: CadencePerson): string {
  return p.avatar_color || PALETTE[hashInt(p.name) % PALETTE.length]!;
}
// List chrome dot: deterministic from the list id.
export function listColor(listId: string | null | undefined): string {
  if (listId == null) return 'var(--ink-3)';
  return PALETTE[hashInt(listId) % PALETTE.length]!;
}
export function listName(data: AppData, id: string | null): string {
  if (id == null) return '—';
  const c = data.lists.find((x) => x.list_id === id);
  return c ? c.name : '—';
}

// ---------- Status ----------

export interface Status {
  key: 'overdue' | 'due' | 'ok';
  label: string;
  color: string;
}

export function statusOf(p: CadencePerson): Status {
  const days = daysSince(p);
  const cad = p.cadence_days ?? 30;
  const over = days >= cad;
  const due = !over && days >= cad * 0.72;
  if (over) return { key: 'overdue', label: 'overdue', color: 'var(--danger)' };
  if (due) return { key: 'due', label: 'due soon', color: 'var(--c-family)' };
  return { key: 'ok', label: 'on track', color: 'var(--ok)' };
}

export function metaLine(p: CadencePerson): string {
  return `Last spoke ${shortFmt(daysSince(p))}`;
}
