export function unrefTimer(
  timer: { unref?: () => unknown } | number | undefined | null
): void {
  if (timer && typeof timer === "object") timer.unref?.();
}
