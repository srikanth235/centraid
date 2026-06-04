/**
 * Automation identity — id grammar + the globally-unique handle.
 *
 * An automation's directory slug (`isValidId`) is unique
 * within its owning app folder; its handle, `<appId>/<id>`, is unique
 * across the whole gateway and is what scheduler labels, webhook
 * routing, and `onFailure` address it by (issue #98).
 */

import { isValidAppId } from '@centraid/app-engine';

/**
 * Validate an automation *id* (the directory slug under `automations/`).
 * Filesystem-safe; unique within its owning app.
 */
export function isValidId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * A parsed automation handle — the globally-unique address of an
 * automation across scheduler labels, webhook routing, and `onFailure`.
 */
export interface Ref {
  readonly appId: string;
  readonly automationId: string;
}

/** Format an automation handle from its owning app id and automation id. */
export function formatRef(appId: string, automationId: string): string {
  return `${appId}/${automationId}`;
}

/**
 * Parse an automation handle. Accepts the canonical `<appId>/<id>` form;
 * a bare `<id>` (no slash) resolves against `withinApp` — a sibling in
 * the same app, the form `onFailure` uses. Returns `undefined` for a
 * malformed handle.
 */
export function parseRef(ref: string, withinApp?: string): Ref | undefined {
  const slash = ref.indexOf('/');
  if (slash === -1) {
    if (!withinApp || !isValidId(ref)) return undefined;
    return { appId: withinApp, automationId: ref };
  }
  const appId = ref.slice(0, slash);
  const automationId = ref.slice(slash + 1);
  if (!isValidAppId(appId) || !isValidId(automationId)) return undefined;
  return { appId, automationId };
}

/** True for a syntactically valid automation handle (with or without app prefix). */
export function isValidRef(ref: string): boolean {
  const slash = ref.indexOf('/');
  if (slash === -1) return isValidId(ref);
  return isValidAppId(ref.slice(0, slash)) && isValidId(ref.slice(slash + 1));
}
