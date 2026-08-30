/** Node `Timeout#unref` is missing when the same file is typechecked under DOM.
 *  Callers must use the global `setTimeout`/`setInterval` so vitest fake
 *  timers still intercept; `import { setTimeout } from "node:timers"` binds
 *  the real timer and tests that advance a fake clock never fire. */
export function unrefTimer(
  timer: { unref?: () => unknown } | number | undefined | null
): void {
  if (timer && typeof timer === "object") timer.unref?.();
}
