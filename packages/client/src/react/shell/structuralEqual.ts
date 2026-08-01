// Value equality for the JSON-shaped DTOs the shell passes to screens
// (issue #659). Used to decide "did this projection actually change?" so a
// re-projection that produced an identical value can hand back the PREVIOUS
// object, keeping React's identity checks (memo, dep arrays) meaningful.
//
// Why a comparison and not a hand-written signature: a signature that forgets
// a field renders stale UI forever, and nothing catches it. Comparing the
// finished value cannot miss a field by construction. It stays cheap because
// large strings that were themselves memoized (the rich-answer HTML) compare
// by reference in one step, and the walk short-circuits on the first
// difference.

/**
 * Deep value equality over JSON-shaped data: primitives, plain objects and
 * arrays. Functions, Maps, Sets, Dates and class instances are compared by
 * reference — the DTOs this serves carry none of them.
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    const left = a as unknown[];
    const right = b as unknown[];
    if (left.length !== right.length) return false;
    for (const [index, value] of left.entries())
      if (!structuralEqual(value, right[index])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!structuralEqual(left[key], right[key])) return false;
  }
  return true;
}
