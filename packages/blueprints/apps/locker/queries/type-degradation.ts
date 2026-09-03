const KNOWN: ReadonlySet<string> = new Set([
  "login",
  "card",
  "note",
  "identity",
  "wifi",
  "password",
  "ssh_key",
  "api_credential",
  "passport",
  "bank_account",
  "driving_licence",
  "software_licence",
  "crypto_wallet",
  "membership",
  "document",
]);

export function isKnownType(type: string): boolean {
  return KNOWN.has(type);
}

export function degradeType(type: string): string {
  return KNOWN.has(type) ? type : "note";
}
