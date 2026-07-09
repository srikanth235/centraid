import { Icon } from '@centraid/desktop-shell-ds';

const cell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  color: 'var(--ink)',
  fontFamily: 'var(--font-sans)',
  fontSize: 11,
};
const label: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 10.5 };

/** The line-icon set — one shared glyph vocabulary drawn by desktop + mobile. */
export function Overview() {
  const names = [
    'Home', 'Search', 'Compass', 'Sparkle', 'Bolt', 'Command',
    'Plus', 'Check', 'Pencil', 'Trash', 'Send', 'Share',
    'Star', 'Bell', 'Settings', 'History', 'Folder', 'Code',
  ] as const;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 18, color: 'var(--ink)' }}>
      {names.map((n) => (
        <div key={n} style={cell}>
          <Icon name={n} size={22} />
          <span style={label}>{n}</span>
        </div>
      ))}
    </div>
  );
}

/** Size scale — glyphs stay crisp because stroke width is intrinsic, not scaled. */
export function Sizes() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, color: 'var(--ink)' }}>
      {[16, 20, 24, 32].map((s) => (
        <div key={s} style={cell}>
          <Icon name="Sparkle" size={s} />
          <span style={label}>{s}px</span>
        </div>
      ))}
    </div>
  );
}

/** Color inherits `currentColor` by default — pass `color` to override per glyph. */
export function Colors() {
  return (
    <div style={{ display: 'flex', gap: 22 }}>
      <Icon name="Bolt" size={24} color="var(--accent)" />
      <Icon name="CheckCircle" size={24} color="var(--success)" />
      <Icon name="AlertCircle" size={24} color="var(--danger)" />
      <Icon name="Star" size={24} color="var(--accent-violet)" />
      <Icon name="MoreHoriz" size={24} color="var(--ink-3)" />
    </div>
  );
}
