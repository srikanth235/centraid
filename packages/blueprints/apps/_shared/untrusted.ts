const SAFE_DATA_MEDIA =
  /^data:(?:image\/(?:avif|gif|jpeg|png|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);/iu;
const SAFE_DATA_DOCUMENT =
  /^data:(?:application\/pdf|text\/plain|image\/(?:avif|gif|jpeg|png|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);/iu;
export const VAULT_BLOB_PATH = "/centraid/_vault/blobs/";

export function displayText(value: unknown): string {
  return [...String(value ?? "")]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const unsafe =
        code <= 8 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127 ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      return unsafe ? "\uFFFD" : character;
    })
    .join("");
}

function hasUrlControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 32 || code === 127;
  });
}

function safeHttpUrl(value: string): string | null {
  if (hasUrlControls(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? value
      : null;
  } catch {
    return null;
  }
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  const url = value.trim();
  if (url === "" || hasUrlControls(url)) return null;
  if (/^(?:mailto|tel):/iu.test(url)) return url;
  return safeHttpUrl(url);
}

export function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16 * 1024 * 1024) return null;
  if (value.startsWith(VAULT_BLOB_PATH)) return value;
  if (SAFE_DATA_MEDIA.test(value)) return value;
  return safeHttpUrl(value);
}

export function safeDocumentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16 * 1024 * 1024) return null;
  if (value.startsWith(VAULT_BLOB_PATH)) return value;
  if (SAFE_DATA_DOCUMENT.test(value)) return value;
  return safeHttpUrl(value);
}

export function safeBackgroundImage(
  value: unknown
): `url("${string}")` | undefined {
  const url = safeMediaUrl(value);
  if (!url) return undefined;
  const escaped = url.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `url("${escaped}")`;
}
