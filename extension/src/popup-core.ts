/*
 * Popup pure helpers, carried from v0 (`apps/extension/src/popup-core.ts`,
 * `popup-state.ts`) — error text, module availability and envelope unwrapping
 * with no DOM.
 */

/** What a member reads when something threw. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One module's state, as `modules` answers it. */
export interface ModuleStatus {
  readonly id: string;
  readonly name: string;
  readonly state: "granted" | "parked" | "revoked" | "unavailable" | "paused";
}

/** Which capture buttons are enabled and visible. */
export function moduleAvailability(modules: readonly ModuleStatus[]): {
  readonly enabled: ReadonlySet<string>;
  readonly agendaVisible: boolean;
  readonly peopleVisible: boolean;
} {
  const enabled = new Set(
    modules
      .filter((module) => module.state === "granted")
      .map((module) => module.id)
  );
  return {
    enabled,
    agendaVisible: enabled.has("agenda"),
    peopleVisible: enabled.has("people"),
  };
}

/** The envelope the worker answers a popup or content script with. */
export interface CompanionEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

/** Unwrap an envelope or throw its member sentence. */
export function unwrapEnvelope<T>(
  envelope: CompanionEnvelope<T> | undefined
): T {
  if (!envelope?.ok)
    throw new Error(envelope?.error ?? "Centraid request failed.");
  return envelope.value as T;
}

/**
 * An unbiased random password, by rejection sampling over the charset.
 *
 * Carried from v0 (`content-core.ts:28`–`:50`) unchanged, including the reason it
 * is not `value % alphabet.length`: a modulo over a range that is not a multiple
 * of the charset size biases the first characters of the alphabet, which is a
 * weaker password that looks fine.
 */
export function randomPassword(
  length = 20,
  randomValues: (size: number) => Uint32Array = (size) => {
    const values = new Uint32Array(size);
    crypto.getRandomValues(values);
    return values;
  }
): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const out: string[] = [];
  const bound = Math.floor(0x1_0000_0000 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    const values = randomValues(length - out.length);
    for (const value of values) {
      if (value >= bound) continue;
      out.push(alphabet[value % alphabet.length]!);
      if (out.length === length) break;
    }
  }
  return out.join("");
}
