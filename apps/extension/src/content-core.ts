/**
 * Content-script pure helpers (issue #545 C10) — password generation and
 * message-envelope unwrapping without DOM / chrome APIs.
 */

export interface CompanionEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

/** Unwrap a chrome.runtime.sendMessage envelope or throw. */
export function unwrapCompanionEnvelope<T>(envelope: CompanionEnvelope<T> | undefined): T {
  if (!envelope?.ok) throw new Error(envelope?.error ?? 'Centraid request failed.');
  return envelope.value as T;
}

/**
 * Unbiased charset sampling (rejection sampling over crypto.getRandomValues).
 * Exported for unit tests; content.ts uses the same alphabet + length.
 */
export function randomPassword(
  length = 20,
  randomValues: (size: number) => Uint32Array = (size) => {
    const values = new Uint32Array(size);
    crypto.getRandomValues(values);
    return values;
  },
): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
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
  return out.join('');
}

/** Build a page capture from tab/context-menu inputs (worker context-menu path). */
export function pageCaptureFromTab(input: {
  title?: string;
  url: string;
  selectionText?: string;
}): { title: string; url: string; selection?: string } {
  return {
    title: input.title ?? input.url,
    url: input.url,
    ...(input.selectionText ? { selection: input.selectionText } : {}),
  };
}
