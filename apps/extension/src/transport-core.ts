export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBytes(raw: string): Uint8Array {
  return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
}

export function isConnectFailure(
  error: unknown,
  connectFailureMarker: string
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(connectFailureMarker);
}

export function isDeviceRevoked(
  error: unknown,
  deviceRevokedMarker: string
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(deviceRevokedMarker);
}

export function shouldRetryCompanionRequest(input: {
  attempt: number;
  maxAttempts: number;
  method: string;
  error: unknown;
  connectFailureMarker: string;
  deviceRevokedMarker: string;
  idempotentMethods?: ReadonlySet<string>;
}): boolean {
  if (isDeviceRevoked(input.error, input.deviceRevokedMarker)) return false;
  if (input.attempt >= input.maxAttempts) return false;
  const idempotent =
    input.idempotentMethods ??
    new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
  if (idempotent.has(input.method.toUpperCase())) return true;
  return isConnectFailure(input.error, input.connectFailureMarker);
}

export function companionHttpError(status: number, bodyText: string): string {
  if (status === 401)
    return "This device was revoked — pair it again in Centraid Settings.";
  return bodyText || `Gateway returned HTTP ${status}.`;
}
