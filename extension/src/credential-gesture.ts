/*
 * THE CREDENTIAL'S LIFETIME IN THIS PROCESS (#1020 wave 4 lane extension).
 *
 * Carried from v0 (`apps/extension/src/credential-gesture.ts`) with its
 * reasoning intact, because none of it was about the transport:
 *
 * - a **page-created event is never authority** to reveal, save or generate a
 *   secret, so the gesture must be trusted;
 * - the extension's references to fill material are dropped **as soon as the
 *   round trip completes**. JavaScript strings cannot be zeroised, so what this
 *   can do is stop the worker and content-script objects retaining
 *   secret-bearing properties — which is the difference between a credential
 *   that lives for one fill and one that lives until the worker is evicted.
 *
 * ## What is new, and it is the gap census §E seam 4 named
 *
 * v0 calls `clearFillMaterial` on the message response and *nothing tests that
 * it happened*. `host-link.test.ts` now does: it drives a real fill round trip
 * against a fake native port and asserts the material is gone from the object
 * the worker held — and, separately, that the value the caller received is
 * still intact, because a clearing that also emptied the answer would pass a
 * weaker test and break the feature.
 */

/** The fields a fill answer may carry. Named, so the clearing cannot drift. */
export const FILL_FIELDS = [
  "value",
  "username",
  "password",
  "totp",
  "receipt_id",
] as const;

/** Page-created events are never authority to reveal, save or generate. */
export function isTrustedCredentialGesture(
  event: Pick<Event, "isTrusted">
): boolean {
  return event.isTrusted;
}

/**
 * Drop this process's references to fill material.
 *
 * Mutates in place and returns nothing: the point is the object the WORKER still
 * holds, not a copy — a function that returned a cleaned clone would leave the
 * original exactly where it was.
 */
export function clearFillMaterial(material: unknown): void {
  if (!material || typeof material !== "object") return;
  const mutable = material as Record<string, unknown>;
  for (const field of FILL_FIELDS) delete mutable[field];
}

/** Clear the worker's cloned save request once its operation settles. */
export function clearSavedPassword(request: unknown): void {
  if (!request || typeof request !== "object") return;
  const mutable = request as Record<string, unknown>;
  if (mutable["t"] === "locker:save" || mutable["type"] === "locker:save") {
    delete mutable["password"];
  }
}

/** Whether a frame is a fill, and therefore whose answer must be cleared. */
export function isFillFrame(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const shape = message as { t?: unknown; type?: unknown };
  return shape.t === "locker:fill" || shape.type === "locker:fill";
}

/** Whether an object still carries any secret-bearing field. */
export function holdsFillMaterial(material: unknown): boolean {
  if (!material || typeof material !== "object") return false;
  const held = material as Record<string, unknown>;
  return FILL_FIELDS.some((field) => field in held);
}

/** Prefer a generated signup secret, falling back to the current-login field. */
export function passwordForSave(fields: {
  readonly password?: { readonly value: string };
  readonly newPassword?: { readonly value: string };
}): string {
  return fields.newPassword?.value || fields.password?.value || "";
}
