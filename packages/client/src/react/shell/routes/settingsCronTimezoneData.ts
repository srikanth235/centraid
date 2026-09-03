import { isValidIanaTimeZone } from "../../../cron.js";
import { getUserPrefs, saveUserPrefs } from "../../../gateway-client.js";

export const CRON_DEFAULT_TIMEZONE_PREF = "automation.cron.defaultTimezone";

export async function loadDefaultCronTimeZone(): Promise<string> {
  const prefs = await getUserPrefs();
  const raw = prefs[CRON_DEFAULT_TIMEZONE_PREF];
  return typeof raw === "string" ? raw.trim() : "";
}

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
