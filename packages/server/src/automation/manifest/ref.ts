import { isValidAppId } from "@centraid/server/engine";

export function isValidId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  return /^[A-Za-z0-9_-]+$/u.test(id);
}

export interface Ref {
  readonly appId: string;
  readonly automationId: string;
}

export function formatRef(appId: string, automationId: string): string {
  return `${appId}/${automationId}`;
}

export function parseRef(ref: string, withinApp?: string): Ref | undefined {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    if (!withinApp || !isValidId(ref)) return undefined;
    return { appId: withinApp, automationId: ref };
  }
  const appId = ref.slice(0, slash);
  const automationId = ref.slice(slash + 1);
  if (!isValidAppId(appId) || !isValidId(automationId)) return undefined;
  return { appId, automationId };
}

export function isValidRef(ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash === -1) return isValidId(ref);
  return isValidAppId(ref.slice(0, slash)) && isValidId(ref.slice(slash + 1));
}
