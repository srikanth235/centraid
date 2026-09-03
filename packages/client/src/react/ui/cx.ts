export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | Record<string, boolean>;

export function cx(...values: readonly ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      out.push(String(value));
      continue;
    }
    for (const [name, on] of Object.entries(value)) {
      if (on) {
        out.push(name);
      }
    }
  }
  return out.join(" ");
}
