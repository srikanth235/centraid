/**
 * Automation identity — id grammar + the globally-unique handle.
 *
 * An automation's directory slug (`isValidAutomationId`) is unique
 * within its owning app folder; its handle, `<appId>/<id>`, is unique
 * across the whole gateway and is what scheduler labels, webhook
 * routing, `ctx.invoke`, and `onFailure` address it by (issue #98).
 */

/**
 * Validate an automation *id* (the directory slug under `automations/`).
 * Filesystem-safe; unique within its owning app.
 */
export function isValidAutomationId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Validate an app folder id. Permits dots — the `auto.` prefix an
 * automation app carries — but excludes path separators and `_`-prefixed
 * (plugin-internal) ids.
 */
export function isValidAppId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.startsWith('_') || id.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/**
 * A parsed automation handle — the globally-unique address of an
 * automation across scheduler labels, webhook routing, `ctx.invoke`,
 * and `onFailure`.
 */
export interface AutomationRef {
  readonly appId: string;
  readonly automationId: string;
}

/** Format an automation handle from its owning app id and automation id. */
export function formatAutomationRef(appId: string, automationId: string): string {
  return `${appId}/${automationId}`;
}

/**
 * Parse an automation handle. Accepts the canonical `<appId>/<id>` form;
 * a bare `<id>` (no slash) resolves against `withinApp` — a sibling in
 * the same app, the form `onFailure` uses. Returns `undefined` for a
 * malformed handle.
 */
export function parseAutomationRef(ref: string, withinApp?: string): AutomationRef | undefined {
  const slash = ref.indexOf('/');
  if (slash === -1) {
    if (!withinApp || !isValidAutomationId(ref)) return undefined;
    return { appId: withinApp, automationId: ref };
  }
  const appId = ref.slice(0, slash);
  const automationId = ref.slice(slash + 1);
  if (!isValidAppId(appId) || !isValidAutomationId(automationId)) return undefined;
  return { appId, automationId };
}

/** True for a syntactically valid automation handle (with or without app prefix). */
export function isValidAutomationRef(ref: string): boolean {
  const slash = ref.indexOf('/');
  if (slash === -1) return isValidAutomationId(ref);
  return isValidAppId(ref.slice(0, slash)) && isValidAutomationId(ref.slice(slash + 1));
}
