// Pure, JSX-free helpers: category metadata (label/color/icon key), row-level
// derivations (subtitle, warn color, monogram) and date formatting. No app
// state, no vault IO — every function is a plain projection of its
// arguments so app.jsx and the components can both call them without a
// circular import. Crypto (TOTP, password strength/generation) lives in
// totp.js instead — see that file for why it's split out.

export const CATS = {
  login: { label: 'Logins', color: '#2F63E6' },
  card: { label: 'Credit Cards', color: '#7C5BD9' },
  note: { label: 'Secure Notes', color: '#E0902E' },
  identity: { label: 'Identities', color: '#2FA36B' },
  password: { label: 'Passwords', color: '#3AA6B9' },
  wifi: { label: 'Wi-Fi', color: '#E0567A' },
};
export const CAT_ORDER = ['login', 'card', 'note', 'identity', 'password', 'wifi'];
export const TYPE_LABEL = {
  login: 'Login',
  card: 'Card',
  note: 'Note',
  identity: 'Identity',
  wifi: 'Wi-Fi',
  password: 'Password',
};

export function catOf(t) {
  return CATS[t] || { label: 'Item', color: '#5C677D' };
}

export function monoOf(it) {
  return (it.title || '?').trim().slice(0, 1).toUpperCase();
}

/** The server already computes a safe subtitle; keep a fallback. */
export function subOf(it) {
  if (it.subtitle) return it.subtitle;
  const t = it.type;
  if (t === 'note') return 'Secure note';
  return catOf(t).label;
}

export function warnColor(it) {
  if (it.severity === 'danger' || it.compromised) return 'var(--danger)';
  if (it.severity === 'warn' || it.weak || it.reused) return 'var(--warn)';
  return '';
}

export function byTitle(a, b) {
  return String(a.title || '').localeCompare(String(b.title || ''));
}

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return (
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
        d.getMonth()
      ] +
      ' ' +
      d.getDate() +
      ', ' +
      d.getFullYear()
    );
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function purgeCountdown(iso) {
  if (!iso) return '';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'purges today';
  if (days === 1) return 'purges tomorrow';
  return `purges in ${days} days`;
}
