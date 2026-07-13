// `cx` — the one classnames helper the desktop React shell uses everywhere.
// Kept in ui-core (not desktop-ui) because it is framework-neutral: mobile's
// RN StyleSheet arrays and the desktop DOM `className` string both need the
// same "join the truthy ones" primitive, and neither should depend on the
// other's runtime.
//
// Accepts strings, falsy values (skipped), and `{ 'class-name': boolean }`
// maps. Returns a single space-joined className string.

export type ClassValue = string | number | false | null | undefined | Record<string, boolean>;

export function cx(...values: readonly ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value));
      continue;
    }
    for (const [name, on] of Object.entries(value)) {
      if (on) {
        out.push(name);
      }
    }
  }
  return out.join(' ');
}
