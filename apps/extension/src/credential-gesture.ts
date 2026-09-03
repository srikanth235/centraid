import type { FillMaterial } from "./types.js";

export function isTrustedCredentialGesture(
  event: Pick<Event, "isTrusted">
): boolean {
  return event.isTrusted;
}

export function clearFillMaterial(material: FillMaterial | unknown): void {
  if (!material || typeof material !== "object") return;
  const mutable = material as Record<string, unknown>;
  delete mutable["username"];
  delete mutable["password"];
  delete mutable["totp"];
  delete mutable["receipt_id"];
}

export function clearSavedPassword(request: unknown): void {
  if (!request || typeof request !== "object") return;
  const mutable = request as Record<string, unknown>;
  if (mutable["type"] === "locker:save") delete mutable["password"];
}

export function passwordForSave(fields: {
  readonly password?: { readonly value: string };
  readonly newPassword?: { readonly value: string };
}): string {
  return fields.newPassword?.value || fields.password?.value || "";
}
