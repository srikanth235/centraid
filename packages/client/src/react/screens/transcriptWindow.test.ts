import { describe, expect, it } from "vitest";

import { anchoredScrollTop, windowTranscript } from "./transcriptWindow.js";

const transcript = (n: number): { id: string }[] =>
  Array.from({ length: n }, (_unused, index) => ({ id: `m${index}` }));

describe(windowTranscript, () => {
  it("renders the NEWEST messages, not the oldest", () => {
    const messages = transcript(10);
    const { rendered } = windowTranscript(messages, 3);
    expect(rendered.map((m) => m.id)).toStrictEqual(["m7", "m8", "m9"]);
  });

  it("reports how many are above so the reader is told, never silently short", () => {
    expect(windowTranscript(transcript(10), 3).hiddenCount).toBe(7);
  });

  it("hides nothing when the transcript fits", () => {
    const messages = transcript(4);
    const { rendered, hiddenCount } = windowTranscript(messages, 60);
    expect(hiddenCount).toBe(0);
    // The SAME array, so a windowing pass never reads as new content to a
    // dependency array or a memo.
    expect(rendered).toBe(messages);
  });

  it("keeps every rendered element referentially identical to its source", () => {
    const messages = transcript(10);
    const { rendered } = windowTranscript(messages, 3);
    expect(rendered[0]).toBe(messages[7]);
    expect(rendered[2]).toBe(messages[9]);
  });

  it("grows toward the start as the window widens, keeping the tail fixed", () => {
    const messages = transcript(10);
    const first = windowTranscript(messages, 3);
    const second = windowTranscript(messages, 6);
    expect(second.rendered.slice(-3)).toStrictEqual(first.rendered);
    expect(second.hiddenCount).toBe(4);
  });

  it("treats a window at or past the length as the whole transcript", () => {
    const messages = transcript(5);
    expect(windowTranscript(messages, 5).rendered).toBe(messages);
    expect(windowTranscript(messages, 99).hiddenCount).toBe(0);
  });

  it("survives a nonsense window rather than returning a negative slice", () => {
    const messages = transcript(5);
    const { rendered, hiddenCount } = windowTranscript(messages, -1);
    expect(rendered).toStrictEqual([]);
    expect(hiddenCount).toBe(5);
  });
});

describe(anchoredScrollTop, () => {
  it("holds the viewport still when content is prepended", () => {
    // Reader is 400px from the bottom of a 2000px transcript; 800px of older
    // messages arrive above them.
    const next = anchoredScrollTop(
      { scrollHeight: 2000, scrollTop: 1600 },
      { scrollHeight: 2800 }
    );
    expect(next).toBe(2400);
    // Same distance from the bottom ⇒ the same content under the viewport.
    expect(2800 - next).toBe(2000 - 1600);
  });

  it("is a no-op when nothing was added", () => {
    expect(
      anchoredScrollTop(
        { scrollHeight: 2000, scrollTop: 1600 },
        { scrollHeight: 2000 }
      )
    ).toBe(1600);
  });

  it("keeps a reader pinned at the bottom at the bottom", () => {
    const next = anchoredScrollTop(
      { scrollHeight: 2000, scrollTop: 2000 },
      { scrollHeight: 2800 }
    );
    expect(next).toBe(2800);
  });

  it("never returns a negative offset if the content shrank instead", () => {
    expect(
      anchoredScrollTop(
        { scrollHeight: 2000, scrollTop: 100 },
        { scrollHeight: 500 }
      )
    ).toBe(0);
  });
});
