// Mixed sizes leave a HOLE when a 1×1 is followed by a full-width tile. Pull
// the next 1×1 FORWARD — never resize, drop, or demote. `orderByPins` first.
// A lone small at the END is not a hole.

/** Parameter, not a constant: smalls pack into runs of `columns`. Phone is 2. */
export const MOBILE_COLUMNS = 2;

export function packTiles<T>(
  items: readonly T[],
  isWide: (item: T) => boolean,
  columns: number = MOBILE_COLUMNS
): T[] {
  const queue = [...items];
  const packed: T[] = [];
  while (queue.length > 0) {
    const next = queue.shift() as T;
    packed.push(next);
    if (isWide(next)) continue;
    // Fill the rest of this smalls row; skip wides between partners.
    for (let seat = 1; seat < columns; seat += 1) {
      const partner = queue.findIndex((item) => !isWide(item));
      if (partner < 0) break;
      packed.push(...queue.splice(partner, 1));
    }
  }
  return packed;
}
