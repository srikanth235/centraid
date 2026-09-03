const POINTER = "(pointer: fine)";

export function sectionsStartCollapsed(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return !window.matchMedia(POINTER).matches;
  } catch {
    return false;
  }
}
