// Pure-math CTC greedy decode, shared by the ocr recognition postprocess.
// Takes already-normalized per-timestep class probabilities (softmax done by
// the caller, typically the ONNX model's own output or a manual softmax over
// its logits) so this module has nothing to do with ONNX and can be tested
// directly with synthetic tensors.

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
  /** Mean probability of the kept (non-blank, de-duplicated) characters, 0..1. */
  confidence: number;
}

/**
 * Greedy CTC decode: argmax each timestep, collapse consecutive repeats,
 * then drop the blank symbol (PaddleOCR/PP-OCR dictionaries reserve index 0
 * as CTC blank, with `dictionary[i]` giving the character for class `i`).
 * Confidence is the mean probability of the characters that survive both
 * the repeat-collapse and the blank-removal — i.e. exactly the characters
 * that end up in `text`.
 */
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
