// Pure, JSX-free helpers: dates, effort formatting, natural-language due
// parsing, bucketing and text-highlight segmentation. No app state, no vault
// IO — every function is a plain projection of its arguments so app.jsx and
// the components can both call them without a circular import.
import { localDayKey } from './kit.js';

export const OPEN_STATUSES = new Set(['needs-action', 'in-process']);

export function todayStr() {
  return localDayKey(new Date());
}

export function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDayKey(d);
}

export function fmtDay(iso) {
  if (!iso) return '';
  const key = String(iso).slice(0, 10);
  const today = todayStr();
  if (key === today) return 'Today';
  if (key === plusDays(1)) return 'Tomorrow';
  if (key === plusDays(-1)) return 'Yesterday';
  try {
    return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return key;
  }
}

export function fmtEffort(min) {
  const n = Number(min);
  if (!n) return '';
  if (n >= 60) return n % 60 === 0 ? `${n / 60}h` : `${Math.floor(n / 60)}h${n % 60}`;
  return `${n}m`;
}

export function isOpenTask(task) {
  return OPEN_STATUSES.has(task.status);
}

// priority: 0 none, 1-3 high, 4-6 medium, 7-9 low (RFC 5545).
export function flagLevel(priority) {
  const p = Number(priority ?? 0);
  if (p <= 0) return '';
  if (p <= 3) return 'high';
  if (p <= 6) return 'medium';
  return 'low';
}

// ---------- Natural-language dates in the capture bar ----------
// A trailing token in the title ("tomorrow", "fri", "jul 12", "+3d") becomes
// the due date, previewed live before submit. An explicit When chip always
// wins — see logic.js's capture submit.

const NL_WEEKDAYS = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const NL_MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseNlDue(title) {
  const t = String(title).trim();
  let m = t.match(/^(.*\S)\s+\+(\d{1,3})([dw])$/i);
  if (m) {
    const n = Number(m[2]) * (m[3].toLowerCase() === 'w' ? 7 : 1);
    return { clean: m[1], due: plusDays(n), token: `+${m[2]}${m[3]}` };
  }
  m = t.match(/^(.*\S)\s+(today|tod|tomorrow|tmr|tom)$/i);
  if (m) {
    const w = m[2].toLowerCase();
    const due = w === 'today' || w === 'tod' ? todayStr() : plusDays(1);
    return { clean: m[1], due, token: m[2] };
  }
  m = t.match(/^(.*\S)\s+([a-z]{3,9})$/i);
  if (m && NL_WEEKDAYS[m[2].toLowerCase()] !== undefined) {
    const target = NL_WEEKDAYS[m[2].toLowerCase()];
    const diff = (target - new Date().getDay() + 7) % 7 || 7;
    return { clean: m[1], due: plusDays(diff), token: m[2] };
  }
  m = t.match(/^(.*\S)\s+([a-z]{3,9})\s+(\d{1,2})$/i);
  if (m && NL_MONTHS[m[2].toLowerCase()] !== undefined) {
    const now = new Date();
    const day = Number(m[3]);
    if (day < 1 || day > 31) return null;
    const d = new Date(now.getFullYear(), NL_MONTHS[m[2].toLowerCase()], day, 12);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d < startOfToday) d.setFullYear(d.getFullYear() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      clean: m[1],
      due: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      token: `${m[2]} ${m[3]}`,
    };
  }
  return null;
}

// ---------- Bucketing (board sections + focus-view folding) ----------

export const BUCKETS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'anytime', label: 'Anytime' },
];

// Which buckets each focus view shows; Today folds in Overdue (Things-style),
// Upcoming is This week + Later, Anytime is only the loose (undated) bucket.
export const VIEW_BUCKETS = {
  all: new Set(['overdue', 'today', 'week', 'later', 'anytime']),
  today: new Set(['overdue', 'today']),
  upcoming: new Set(['week', 'later']),
  anytime: new Set(['anytime']),
};

export function bucketFor(task, today, weekEnd) {
  const due = task.due_at ? String(task.due_at).slice(0, 10) : null;
  if (!due) return 'anytime';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due <= weekEnd) return 'week';
  return 'later';
}

// ---------- Text highlight segments (title + snippet) ----------

/** Case-insensitive substring highlight of `text` against `term` — returns
 * `[{ text, hit }]` segments a component turns into plain text / <mark>. */
export function highlightSegments(text, term) {
  const str = String(text ?? '');
  const needle = String(term ?? '').trim();
  if (!needle) return [{ text: str, hit: false }];
  const low = str.toLowerCase();
  const lowNeedle = needle.toLowerCase();
  const segments = [];
  let i = 0;
  let idx = low.indexOf(lowNeedle);
  while (idx !== -1) {
    if (idx > i) segments.push({ text: str.slice(i, idx), hit: false });
    segments.push({ text: str.slice(idx, idx + needle.length), hit: true });
    i = idx + needle.length;
    idx = low.indexOf(lowNeedle, i);
  }
  if (i < str.length) segments.push({ text: str.slice(i), hit: false });
  return segments;
}

/** Split a vault FTS `⟦hit⟧`-marked snippet into `[{ text, hit }]` segments. */
export function snippetSegments(snippet) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return parts
    .map((text, i) => ({ text, hit: i % 2 === 1 }))
    .filter((s) => s.text !== '');
}
