import { isValidIanaTimeZone } from '../../../cron.js';
/**
 * Gateway-wide default cron timezone (issue #570).
 * Prefs key mirrors `automation.CRON_DEFAULT_TIMEZONE_PREF` in the automation package.
 */
import { getUserPrefs, saveUserPrefs } from '../../../gateway-client.js';

export const CRON_DEFAULT_TIMEZONE_PREF = 'automation.cron.defaultTimezone';

export async function loadDefaultCronTimeZone(): Promise<string> {
  const prefs = await getUserPrefs();
  const raw = prefs[CRON_DEFAULT_TIMEZONE_PREF];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Persist the gateway default. Empty string clears the pref (host-local fallback).
 * Returns an error message when the name is non-empty but not a known IANA zone.
 */
export async function saveDefaultCronTimeZone(value: string): Promise<string | null> {
  const trimmed = value.trim();
  if (trimmed && !isValidIanaTimeZone(trimmed)) {
    return `"${trimmed}" is not a known IANA timezone`;
  }
  await saveUserPrefs({
    [CRON_DEFAULT_TIMEZONE_PREF]: trimmed || null,
  });
  return null;
}
