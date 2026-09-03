export interface ArgMaxResult {
  index: number;
  value: number;
}

export function argmax(row: readonly number[]): ArgMaxResult {
  if (row.length === 0) {
    throw new Error("argmax: row must be non-empty");
  }
  let bestIndex = 0;
  let bestValue = row[0] as number;
  for (let i = 1; i < row.length; i++) {
    const value = row[i] as number;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return { index: bestIndex, value: bestValue };
}

export interface CtcDecodeResult {
  text: string;
  confidence: number;
}

export function ctcGreedyDecode(
  probs: readonly (readonly number[])[],
  dictionary: readonly string[],
  blankIndex = 0
): CtcDecodeResult {
  const chars: string[] = [];
  const keptProbs: number[] = [];
  let previousIndex: number | undefined;

  for (const row of probs) {
    const { index, value } = argmax(row);
    if (index !== previousIndex && index !== blankIndex) {
      const char = dictionary[index];
      if (char !== undefined) {
        chars.push(char);
        keptProbs.push(value);
      }
    }
    previousIndex = index;
  }

  const confidence =
    keptProbs.length === 0
      ? 0
      : keptProbs.reduce((sum, p) => sum + p, 0) / keptProbs.length;

  return { text: chars.join(""), confidence };
}
