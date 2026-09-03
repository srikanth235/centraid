export const CLIPBOARD_CLEAR_SECONDS = 30;

export interface CopyOutcome {
  ok: boolean;
  text: string;
}

export const COPY_UNAVAILABLE = "Copy is unavailable here.";

export function copiedSecretCopy(label: string): string {
  return `${label} copied · the clipboard clears itself in ${CLIPBOARD_CLEAR_SECONDS} seconds`;
}

export function copiedMetadataCopy(label: string): string {
  return `${label} copied`;
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastSecretCopied: string | null = null;

function clipboard(): Clipboard | undefined {
  return globalThis.navigator?.clipboard;
}

export function scheduleClipboardClear(secret: string): void {
  if (clearTimer) clearTimeout(clearTimer);
  lastSecretCopied = secret;
  const board = clipboard();
  if (!board?.writeText) return;
  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (!board.readText) return;
    void board
      .readText()
      .then(async (current) => {
        if (current === secret) await board.writeText("");
        if (lastSecretCopied === secret) lastSecretCopied = null;
      })
      .catch(() => {});
  }, CLIPBOARD_CLEAR_SECONDS * 1000);
}

export function clearSecretClipboard(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  const secret = lastSecretCopied;
  lastSecretCopied = null;
  const board = clipboard();
  if (!secret || !board?.readText) return;
  void board
    .readText()
    .then((current) => (current === secret ? board.writeText("") : undefined))
    .catch(() => {});
}

async function write(text: string): Promise<boolean> {
  const board = clipboard();
  if (!board?.writeText) return false;
  try {
    await board.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copySecret(
  text: string,
  label: string
): Promise<CopyOutcome> {
  if (!(await write(text))) return { ok: false, text: COPY_UNAVAILABLE };
  scheduleClipboardClear(text);
  return { ok: true, text: copiedSecretCopy(label) };
}

export async function copyMetadata(
  text: string,
  label: string
): Promise<CopyOutcome> {
  if (!(await write(text))) return { ok: false, text: COPY_UNAVAILABLE };
  return { ok: true, text: copiedMetadataCopy(label) };
}
