import * as Clipboard from "expo-clipboard";

import {
  CLIPBOARD_CLEAR_SECONDS,
  copiedMetadataCopy,
  copiedSecretCopy,
} from "@centraid/blueprints/apps/locker/clipboard";
import type { CopyOutcome } from "@centraid/blueprints/apps/locker/clipboard";

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastSecretCopied: string | null = null;

async function compareThenClear(secret: string): Promise<void> {
  const current = await Clipboard.getStringAsync().catch(() => "");
  if (current === secret) await Clipboard.setStringAsync("").catch(() => false);
  if (lastSecretCopied === secret) lastSecretCopied = null;
}

export function scheduleLockerClipboardClear(secret: string): void {
  if (clearTimer) clearTimeout(clearTimer);
  lastSecretCopied = secret;
  clearTimer = setTimeout(() => {
    clearTimer = null;
    void compareThenClear(secret);
  }, CLIPBOARD_CLEAR_SECONDS * 1000);
}

export function clearLockerClipboard(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  const secret = lastSecretCopied;
  lastSecretCopied = null;
  if (secret) void compareThenClear(secret);
}

export async function copyLockerSecret(
  text: string,
  label: string
): Promise<CopyOutcome> {
  try {
    await Clipboard.setStringAsync(text);
  } catch {
    return { ok: false, text: "Copy is unavailable here." };
  }
  scheduleLockerClipboardClear(text);
  return { ok: true, text: copiedSecretCopy(label) };
}

export async function copyLockerMetadata(
  text: string,
  label: string
): Promise<CopyOutcome> {
  try {
    await Clipboard.setStringAsync(text);
  } catch {
    return { ok: false, text: "Copy is unavailable here." };
  }
  return { ok: true, text: copiedMetadataCopy(label) };
}
