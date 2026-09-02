/** `{ unref? }` because Node `Timeout#unref` is missing under DOM typecheck. Callers must use the global `setTimeout`/`setInterval`, never `node:timers` — vitest fake timers never fire a real bound timer. */
export function unrefTimer(
  timer: { unref?: () => unknown } | number | undefined | null
): void {
  if (timer && typeof timer === "object") timer.unref?.();
}
