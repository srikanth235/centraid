import { base64ToBytes } from "./upload/bytes";

export type DesktopPairPayload = {
  kind: "centraid-pair";
  ticket: string;
  code: string;
};

export type GatewayPairPayload = {
  kind: "centraid-gw-pair";
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
};

export type PairingInput = DesktopPairPayload | GatewayPairPayload;

export function parsePairQr(
  raw: string
): { ticket: string; code: string } | undefined {
  const parsed = parsePairingInput(raw);
  if (!parsed || parsed.kind !== "centraid-pair") return undefined;
  return { ticket: parsed.ticket, code: parsed.code };
}

export function parsePairingInput(raw: string): PairingInput | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const obj = JSON.parse(trimmed) as Partial<{
      v: number;
      kind: string;
      ticket: string;
      code: string;
    }>;
    if (obj.v === 1 && obj.kind === "centraid-pair") {
      if (typeof obj.ticket !== "string" || typeof obj.code !== "string")
        return undefined;
      return { kind: "centraid-pair", ticket: obj.ticket, code: obj.code };
    }
  } catch {
    // Intentionally empty.
  }

  try {
    const json = utf8FromBase64Url(trimmed);
    const obj = JSON.parse(json) as Partial<{
      v: number;
      kind: string;
      gw: string;
      t: string;
      s: string;
      vaultName?: string;
      exp: number;
    }>;
    if (obj.v !== 1 || obj.kind !== "centraid-gw-pair") return undefined;
    if (typeof obj.gw !== "string" || obj.gw.length === 0) return undefined;
    if (typeof obj.t !== "string" || obj.t.length === 0) return undefined;
    if (typeof obj.s !== "string" || obj.s.length === 0) return undefined;
    if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp))
      return undefined;
    if (typeof obj.vaultName !== "string") return undefined;
    return {
      kind: obj.kind,
      gw: obj.gw,
      t: obj.t,
      s: obj.s,
      vaultName: obj.vaultName,
      exp: obj.exp,
    };
  } catch {
    return undefined;
  }
}

function utf8FromBase64Url(raw: string): string {
  const b64 = raw.replace(/-/gu, "+").replace(/_/gu, "/");
  const bytes = base64ToBytes(b64);
  return new TextDecoder().decode(bytes);
}
