import { AppCard } from '@centraid/desktop-shell-ds';

// Realistic resolved app metas (id + name + colorKey + iconKey + desc + color).
const todos = {
  id: 'todos',
  name: 'Todos',
  colorKey: 'violet',
  iconKey: 'Todo',
  desc: 'Capture and clear small things.',
  color: '#7C5BD9',
} as const;
const focus = {
  id: 'focus',
  name: 'Focus',
  colorKey: 'teal',
  iconKey: 'Pomodoro',
  desc: '25-minute work blocks with breaks.',
  color: '#2EA098',
} as const;
const journal = {
  id: 'journal',
  name: 'Journal',
  colorKey: 'amber',
  iconKey: 'Journal',
  desc: 'A clean place to write each day.',
  color: '#E89A3C',
} as const;
const habits = {
  id: 'habits',
  name: 'Habits',
  colorKey: 'rose',
  iconKey: 'Habit',
  desc: 'A streak counter for daily things.',
  color: '#E55772',
} as const;

const grid = (min = 220): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
  gap: 16,
  maxWidth: 720,
});

/** The home-grid app tile: icon plate + name + blurb + footer badge. */
export function Default() {
  return (
    <div style={{ width: 260 }}>
      <AppCard app={todos} stamp="opened 2h ago" />
    </div>
  );
}

/** Tile finish is the primary variant axis — it follows the user's
 *  `tileVariant` preference. The icon plate paints differently per finish. */
export function Finishes() {
  return (
    <div style={grid()}>
      <AppCard app={todos} variant="solid" />
      <AppCard app={focus} variant="gradient" />
      <AppCard app={journal} variant="glassy" />
      <AppCard app={habits} variant="flat" />
    </div>
  );
}

/** Corner state — a freshly-created app ("new") or an unpublished draft. */
export function States() {
  return (
    <div style={grid()}>
      <AppCard app={focus} tone="new" stamp="just now" />
      <AppCard app={journal} tone="draft" stamp="saved" />
    </div>
  );
}

/** A populated home grid — several apps at rest. */
export function Grid() {
  return (
    <div style={grid()}>
      <AppCard app={todos} stamp="2h ago" />
      <AppCard app={focus} stamp="yesterday" />
      <AppCard app={journal} stamp="3d ago" />
      <AppCard app={habits} stamp="1w ago" />
    </div>
  );
}

/** Compact tile — the smaller Discover/library variant. */
export function Small() {
  return (
    <div style={grid(200)}>
      <AppCard app={todos} small stamp="app" />
      <AppCard app={focus} small stamp="app" />
    </div>
  );
}
