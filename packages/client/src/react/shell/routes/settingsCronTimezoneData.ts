import { isValidIanaTimeZone } from "../../../cron.js";
/**
 * Gateway-wide default cron timezone (#570).
 * Prefs key mirrors `automation.CRON_DEFAULT_TIMEZONE_PREF` in the automation package.
 */
import { getUserPrefs, saveUserPrefs } from "../../../gateway-client.js";

export const CRON_DEFAULT_TIMEZONE_PREF = "automation.cron.defaultTimezone";

export async function loadDefaultCronTimeZone(): Promise<string> {
  const prefs = await getUserPrefs();
  const raw = prefs[CRON_DEFAULT_TIMEZONE_PREF];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Persist the gateway default. Empty string clears the pref (host-local fallback).
 *
 * Resolves `null` when the zone was written, and otherwise the sentence the
 * field shows. THE ERROR NAMES THE LAST GOOD VALUE: "not a known IANA
 * timezone" told a member what they had just typed, which they could already
 * see, and left the more useful fact — which zone automations are still firing
 * in — unstated. A gateway refusal is reported the same way, in its own words.
 */
export async function saveDefaultCronTimeZone(
  value: string,
  lastGood = ""
): Promise<string | null> {
  const standing = lastGood || "the host clock";
  const trimmed = value.trim();
  if (trimmed && !isValidIanaTimeZone(trimmed)) {
    return `Not a zone the gateway knows. Still using ${standing}.`;
  }
  try {
    await saveUserPrefs({
      [CRON_DEFAULT_TIMEZONE_PREF]: trimmed || null,
    });
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return `${text}. Still using ${standing}.`;
  }
  return null;
}
