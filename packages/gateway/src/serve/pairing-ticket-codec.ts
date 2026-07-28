export interface PairingTicketPayload {
  v: 1;
  kind: "centraid-gw-pair";
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
}

export function encodePairingTicket(payload: PairingTicketPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parsePairingTicket(
  raw: string
): PairingTicketPayload | undefined {
  try {
    const obj = JSON.parse(
      Buffer.from(raw.trim(), "base64url").toString("utf8")
    ) as Partial<PairingTicketPayload>;
    if (obj.v !== 1 || obj.kind !== "centraid-gw-pair") return undefined;
    if (
      typeof obj.gw !== "string" ||
      typeof obj.t !== "string" ||
      typeof obj.s !== "string"
    ) {
      return undefined;
    }
    if (typeof obj.vaultName !== "string" || typeof obj.exp !== "number")
      return undefined;
    return obj as PairingTicketPayload;
  } catch {
    return undefined;
  }
}
