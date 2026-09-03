export const ALARM_SURFACES = ["home", "photos-grid", "notes-library"] as const;

export type AlarmSurface = (typeof ALARM_SURFACES)[number];

const BLANKED: AlarmSurface | null = (() => {
  const requested = process.env.EXPO_PUBLIC_CENTRAID_E2E_ALARM;
  if (!requested) return null;
  return (ALARM_SURFACES as readonly string[]).includes(requested)
    ? (requested as AlarmSurface)
    : null;
})();

export function isAlarmBlanked(surface: AlarmSurface): boolean {
  return BLANKED === surface;
}
