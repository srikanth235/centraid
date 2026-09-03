import { BRAND, IDENTITY_COLORS, identityInitials } from "@centraid/design";

import { Store } from "../storage";

const PROFILE_NAME_KEY = "profile.name";
const PROFILE_COLOR_KEY = "profile.color";
const PROFILE_ONBOARDED_KEY = "profile.onboarded";

export { BRAND } from "@centraid/design";

export const PROFILE_COLORS: readonly string[] = IDENTITY_COLORS;

export async function hydrateProfile(): Promise<void> {
  await Promise.all([
    Store.hydrate<string>(PROFILE_NAME_KEY, ""),
    Store.hydrate<string>(PROFILE_COLOR_KEY, BRAND),
    Store.hydrate<boolean>(PROFILE_ONBOARDED_KEY, false),
  ]);
}

export function getProfileName(): string {
  return Store.get<string>(PROFILE_NAME_KEY, "");
}

export function setProfileName(name: string): void {
  Store.set<string>(PROFILE_NAME_KEY, name.trim());
}

export function getProfileColor(): string {
  return Store.get<string>(PROFILE_COLOR_KEY, BRAND) || BRAND;
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

export function initialsOf(name: string): string {
  return identityInitials(name);
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u).find(Boolean) ?? "";
}

export function greetingFor(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
