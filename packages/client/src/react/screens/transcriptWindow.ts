export const TRANSCRIPT_WINDOW = 60;

export interface TranscriptWindow<T> {
  rendered: readonly T[];
  hiddenCount: number;
}

export function windowTranscript<T>(
  messages: readonly T[],
  windowSize: number
): TranscriptWindow<T> {
  const hiddenCount = Math.max(0, messages.length - Math.max(0, windowSize));
  if (hiddenCount === 0) return { rendered: messages, hiddenCount: 0 };
  return { rendered: messages.slice(hiddenCount), hiddenCount };
}

export function anchoredScrollTop(
  before: { scrollHeight: number; scrollTop: number },
  after: { scrollHeight: number }
): number {
  const distanceFromBottom = before.scrollHeight - before.scrollTop;
  return Math.max(0, after.scrollHeight - distanceFromBottom);
}
