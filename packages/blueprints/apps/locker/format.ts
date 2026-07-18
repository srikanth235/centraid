// Pure, JSX-free helpers: category metadata (label/color/icon key), row-level
// derivations (subtitle, warn color, monogram) and date formatting. No app
// state, no vault IO — every function is a plain projection of its
// arguments so app.tsx and the components can both call them without a
// circular import. Crypto (TOTP, password strength/generation) lives in
// totp.ts instead — see that file for why it's split out.

export interface CatMeta {
  label: string;
  color: string;
}

export const CATS: Record<string, CatMeta> = {
  login: { label: 'Logins', color: '#2F63E6' },
  card: { label: 'Credit Cards', color: '#7C5BD9' },
  note: { label: 'Secure Notes', color: '#E0902E' },
  identity: { label: 'Identities', color: '#2FA36B' },
  password: { label: 'Passwords', color: '#3AA6B9' },
  wifi: { label: 'Wi-Fi', color: '#E0567A' },
};
export const CAT_ORDER = ['login', 'card', 'note', 'identity', 'password', 'wifi'] as const;
export const TYPE_LABEL: Record<string, string> = {
  login: 'Login',
  card: 'Card',
  note: 'Note',
  identity: 'Identity',
  wifi: 'Wi-Fi',
  password: 'Password',
};

export function catOf(t: string | undefined): CatMeta {
  return (t ? CATS[t] : undefined) || { label: 'Item', color: '#5C677D' };
}

export function monoOf(it: { title?: string | null }): string {
  return (it.title || '?').trim().slice(0, 1).toUpperCase();
}

/** The server already computes a safe subtitle; keep a fallback. */
export function subOf(it: { subtitle?: string; type?: string }): string {
  if (it.subtitle) return it.subtitle;
  const t = it.type;
  if (t === 'note') return 'Secure note';
  return catOf(t).label;
}

export function warnColor(it: {
  severity?: string;
  compromised?: boolean;
  weak?: boolean;
  reused?: boolean;
}): string {
  if (it.severity === 'danger' || it.compromised) return 'var(--danger)';
  if (it.severity === 'warn' || it.weak || it.reused) return 'var(--warn)';
  return '';
}

export function byTitle(a: { title?: string | null }, b: { title?: string | null }): number {
  return String(a.title || '').localeCompare(String(b.title || ''));
}

export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const mon = months[d.getMonth()] ?? '';
    return mon + ' ' + d.getDate() + ', ' + d.getFullYear();
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function purgeCountdown(iso: string | undefined | null): string {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'purges today';
  if (days === 1) return 'purges tomorrow';
  return `purges in ${days} days`;
}
