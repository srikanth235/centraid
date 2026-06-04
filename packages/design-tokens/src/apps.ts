// Built-in app catalog — names, descriptions, color/icon picks.
// Shared across desktop + mobile so both home grids stay in sync.

import { palette } from './palette';
import type { ColorKey, ColorHex } from './palette';
import type { IconName } from './icons';

export interface AppMeta {
  id: string;
  name: string;
  colorKey: ColorKey;
  iconKey: IconName;
  desc: string;
}

export interface AppMetaResolved extends AppMeta {
  color: ColorHex;
}

const BUILTIN_APPS: readonly AppMeta[] = [
  {
    colorKey: 'violet',
    desc: 'Capture and clear small things.',
    iconKey: 'Todo',
    id: 'todos',
    name: 'Todos',
  },
  {
    colorKey: 'rose',
    desc: 'A streak counter for daily things.',
    iconKey: 'Habit',
    id: 'habits',
    name: 'Habits',
  },
  {
    colorKey: 'amber',
    desc: 'A clean place to write each day.',
    iconKey: 'Journal',
    id: 'journal',
    name: 'Journal',
  },
  {
    colorKey: 'teal',
    desc: '25-minute work blocks with breaks.',
    iconKey: 'Pomodoro',
    id: 'focus',
    name: 'Focus',
  },
  {
    colorKey: 'forest',
    desc: 'Watering reminders for my plants.',
    iconKey: 'Plant',
    id: 'plants',
    name: 'Plant Care',
  },
  {
    colorKey: 'indigo',
    desc: 'Track 8 cups a day.',
    iconKey: 'Water',
    id: 'hydrate',
    name: 'Hydrate',
  },
  {
    colorKey: 'ochre',
    desc: 'Half-formed ideas for friends.',
    iconKey: 'Gift',
    id: 'gifts',
    name: 'Gift Ideas',
  },
  {
    colorKey: 'slate',
    desc: 'A 5-second daily check-in.',
    iconKey: 'Mood',
    id: 'mood',
    name: 'Mood',
  },
];

export const apps: readonly AppMetaResolved[] = BUILTIN_APPS.map((a) => ({
  ...a,
  color: palette[a.colorKey],
}));
