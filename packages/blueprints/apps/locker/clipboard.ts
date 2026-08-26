// THE CLIPBOARD LEG OF THE BOUNDARY (README-Locker §2, "Clipboard").
//
// A copied secret clears in thirty seconds, and the copy SAYS SO. The
// semantics here are carried forward verbatim from the pre-rebuild `logic.ts`
// (issue #298 item 5) because they were right, and because the reason is not
// obvious enough to re-derive: copy-password legitimately crosses into the OS
// clipboard, and from there into clipboard-history tools. The native
// `org.nspasteboard.ConcealedType` mark is unreachable from a browser context
// (navigator.clipboard only speaks text/html/png), so the portable mitigation
// is a timed clear — and it is a COMPARE-THEN-CLEAR: we wipe only if the
// clipboard still holds the exact value we put there, never clobbering
// something the member copied since.
//
// NO SECRET IS RETURNED, LOGGED OR STORED HERE. `lastSecretCopied` is module
// state that exists solely so `clearSecretClipboard` can compare; it is
// dropped the moment the compare runs, and nothing reads it.

/** Seconds a copied secret is allowed to live on the clipboard. */
export const CLIPBOARD_CLEAR_SECONDS = 30;

/** What a copy attempt resolved to, as the ONE status line carries it. The
 *  caller publishes it; this module never touches the frame. */
export interface CopyOutcome {
  ok: boolean;
  text: string;
}

/** A copy this seat cannot perform. Stated, never silently swallowed. */
export const COPY_UNAVAILABLE = "Copy is unavailable here.";

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastSecretCopied: string | null = null;

function clipboard(): Clipboard | undefined {
  return globalThis.navigator?.clipboard;
}

/**
 * Arm the timed wipe for one copied secret. Exported so a caller that put a
 * secret on the clipboard by another route (the Companion fill) can arm the
 * same clock rather than inventing a second one.
 */
export function scheduleClipboardClear(secret: string): void {
  if (clearTimer) clearTimeout(clearTimer);
  lastSecretCopied = secret;
  const board = clipboard();
  if (!board?.writeText) return;
  clearTimer = setTimeout(() => {
    clearTimer = null;
    // No read permission → leave the clipboard alone rather than risk wiping
    // something the member copied since.
    if (!board.readText) return;
    void board
      .readText()
      .then(async (current) => {
        if (current === secret) await board.writeText("");
        if (lastSecretCopied === secret) lastSecretCopied = null;
      })
      .catch(() => {
        /* clipboard permissions changed — leave its current value alone */
      });
  }, CLIPBOARD_CLEAR_SECONDS * 1000);
}

/**
 * Lock-time hygiene: clear the exact secret Locker most recently copied.
 * Called by `wipeSecretState` (session.ts), so locking and clipboard hygiene
 * can never come apart.
 */
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
    .catch(() => {
      /* best effort under a withheld permission; the session is locked either
         way, and a rejected wipe must not become an unhandled rejection */
    });
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

/**
 * Copy a SECRET value. Arms the timed wipe and returns the sentence that says
 * the clipboard clears itself — the copy is not honest without it.
 */
export async function copySecret(
  text: string,
  label: string
): Promise<CopyOutcome> {
  if (!(await write(text))) return { ok: false, text: COPY_UNAVAILABLE };
  scheduleClipboardClear(text);
  return {
    ok: true,
    text: `${label} copied · the clipboard clears itself in ${CLIPBOARD_CLEAR_SECONDS} seconds`,
  };
}

/** Copy a METADATA value — a username, an address. No timer, no sentence about
 *  one: a username on the clipboard is not a secret, and claiming it would be
 *  wiped when it is not would be the wrong kind of reassurance. */
export async function copyMetadata(
  text: string,
  label: string
): Promise<CopyOutcome> {
  if (!(await write(text))) return { ok: false, text: COPY_UNAVAILABLE };
  return { ok: true, text: `${label} copied` };
}
