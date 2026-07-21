// Local profile + first-run state (issue #263 onboarding).
//
// The phone is a client of a desktop gateway, so "who am I" is a light local
// preference — a display name, an accent color, and whether onboarding has
// completed. It lives in the same AsyncStorage-backed `Store` the rest of the
// app uses; nothing here is a security boundary (the vault link lives in
// secure-storage via phone-link.ts). Callers `hydrateProfile()` once at boot,
// then read synchronously on the render path.

import { Store } from '../storage';

const PROFILE_NAME_KEY = 'profile.name';
const PROFILE_COLOR_KEY = 'profile.color';
const PROFILE_ONBOARDED_KEY = 'profile.onboarded';

// Brand teal from the mobile design system — used for the profile avatar,
// the greeting highlight, and the onboarding call-to-actions. Distinct from
// the UI `accent` (indigo) that buttons and links use.
export const BRAND_TEAL = '#128A78';

/** Pull the profile prefs into the Store cache. Idempotent. */
export async function hydrateProfile(): Promise<void> {
  await Promise.all([
    Store.hydrate<string>(PROFILE_NAME_KEY, ''),
    Store.hydrate<string>(PROFILE_COLOR_KEY, BRAND_TEAL),
    Store.hydrate<boolean>(PROFILE_ONBOARDED_KEY, false),
  ]);
}

export function getProfileName(): string {
  return Store.get<string>(PROFILE_NAME_KEY, '');
}

export function setProfileName(name: string): void {
  Store.set<string>(PROFILE_NAME_KEY, name.trim());
}

export function getProfileColor(): string {
  return Store.get<string>(PROFILE_COLOR_KEY, BRAND_TEAL) || BRAND_TEAL;
}

export function setProfileColor(hex: string): void {
  Store.set<string>(PROFILE_COLOR_KEY, hex);
}

export function isOnboarded(): boolean {
  return Store.get<boolean>(PROFILE_ONBOARDED_KEY, false);
}

export function setOnboarded(value: boolean): void {
  Store.set<boolean>(PROFILE_ONBOARDED_KEY, value);
}

/** Up-to-two-letter initials for an avatar. Falls back to a person glyph. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[parts.length - 1]!.slice(0, 1)).toUpperCase();
}

/** First name only, for the greeting line. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/).find(Boolean) ?? '';
}

/** Time-of-day greeting to match the home header. */
export function greetingFor(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
