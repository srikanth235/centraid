/** JSON-object helpers for Node tooling that reads untrusted parse trees. */

export type Loose = Record<string, unknown>;

/** The nightly report page model — a JSON bag plus the arrays the renderer walks. */
export type ReportModel = Loose & {
  night?: unknown;
  verdict: Loose & { verdict?: string; why?: unknown; flip?: unknown };
  counts: Loose;
  lanes: Loose[];
  journeys: Array<Loose & { flows?: unknown[] }>;
  coverage: Loose & { rows?: unknown[]; platforms?: unknown[] };
  promises: Loose & {
    qualities?: unknown[];
    surfaces?: unknown[];
    cells?: unknown;
  };
  trends: unknown[];
  blockers: unknown[];
  since: Loose & { newRed?: unknown[]; newGreen?: unknown[] };
  attention: unknown[];
  adversaries: Loose & {
    seeds?: unknown[];
    mutation?: unknown[];
    fuzzTargets?: unknown[];
    fuzz?: unknown[];
    engines?: unknown[];
  };
  candidate: Loose;
  run: Loose;
  links: Loose;
  delta: Loose;
  evidencePanels: Loose;
  validationErrors: unknown[];
  minutesUsed?: unknown;
  budgetMinutes?: unknown;
  evidenceAgeMs?: unknown;
  repoUrl?: unknown;
  alarm?: unknown;
  caseResults?: Map<string, unknown>;
  consentVerdicts?: Loose;
  joinVerdicts?: Loose;
  severity?: unknown;
  vocabulary?: unknown;
};

export function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dict(value: unknown): Loose {
  return isRecord(value) ? value : {};
}

export function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
}

export function bags(value: unknown): Loose[] {
  return items(value).map(dict);
}

export function entries(value: unknown): Array<[string, unknown]> {
  return Object.entries(dict(value));
}

export function has(collection: readonly unknown[], value: unknown): boolean {
  return collection.includes(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fromAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of iterable) collected.push(item);
  return collected;
}

export function parseJson(source: string): unknown {
  return JSON.parse(source) as unknown;
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
