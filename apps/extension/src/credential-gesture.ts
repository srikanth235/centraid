import type { FillMaterial } from './types.js';

/** Page-created events are never authority to reveal, save, or generate a secret. */
export function isTrustedCredentialGesture(event: Pick<Event, 'isTrusted'>): boolean {
  return event.isTrusted;
}

/**
 * Drop the extension's mutable references as soon as structured cloning or
 * field assignment completes. JavaScript strings cannot be zeroized, but the
 * worker/content-script objects must not retain secret-bearing properties.
 */
export function clearFillMaterial(material: FillMaterial | unknown): void {
  if (!material || typeof material !== 'object') return;
  const mutable = material as Record<string, unknown>;
  delete mutable['username'];
  delete mutable['password'];
  delete mutable['totp'];
  delete mutable['receipt_id'];
}

/** Clear the worker's cloned save request once its transport operation settles. */
export function clearSavedPassword(request: unknown): void {
  if (!request || typeof request !== 'object') return;
  const mutable = request as Record<string, unknown>;
  if (mutable['type'] === 'locker:save') delete mutable['password'];
}

/** Prefer a generated signup secret, falling back to the current-login field. */
export function passwordForSave(fields: {
  readonly password?: { readonly value: string };
  readonly newPassword?: { readonly value: string };
}): string {
  return fields.newPassword?.value || fields.password?.value || '';
}
