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
    for (let seat = 1; seat < columns; seat += 1) {
      const partner = queue.findIndex((item) => !isWide(item));
      if (partner < 0) break;
      packed.push(...queue.splice(partner, 1));
    }
  }
  return packed;
}
