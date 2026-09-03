export async function expectedRefreshCapability(
  refreshToken: string,
  receiptSecret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(refreshToken)
  );
  const tokenHash = base64Url(new Uint8Array(digest));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(receiptSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`centraid/oauth-refresh-capability/v1\n${tokenHash}`)
  );
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}
