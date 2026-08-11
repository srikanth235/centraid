import type {
  ReplicaIdFactory,
  ReplicaValue,
} from "@centraid/client/replica/native";

const DOUBLE_TAP_WINDOW_MS = 2_000;

function stableJson(value: ReplicaValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

/**
 * Gesture-scoped idempotency for native writes. Two taps carrying the same
 * action/payload inside the platform double-tap window share one intent id;
 * the same legitimate action can be repeated after the window.
 */
export class MobileIntentIds {
  readonly #recent = new Map<string, { intentId: string; expiresAt: number }>();

  constructor(
    private readonly createId: ReplicaIdFactory,
    private readonly now: () => number = Date.now
  ) {}

  forWrite(
    appId: string,
    action: string,
    input: ReplicaValue,
    explicit?: string
  ): string {
    if (explicit) return explicit;
    const now = this.now();
    for (const [key, entry] of this.#recent) {
      if (entry.expiresAt <= now) this.#recent.delete(key);
    }
    const key = `${appId}\u0000${action}\u0000${stableJson(input)}`;
    const prior = this.#recent.get(key);
    if (prior) return prior.intentId;
    const intentId = this.createId();
    this.#recent.set(key, {
      intentId,
      expiresAt: now + DOUBLE_TAP_WINDOW_MS,
    });
    return intentId;
  }

  /**
   * A fresh id, bypassing the double-tap coalescing cache entirely (issue
   * #738): a retry re-issues a write whose action/input are deliberately
   * IDENTICAL to the one that just failed — `forWrite` would coalesce that
   * onto the old id if the member retries inside the double-tap window,
   * defeating the durable attention journal's "the old id's payload hash is
   * bound to the attempt that failed" contract.
   */
  mint(): string {
    return this.createId();
  }
}
