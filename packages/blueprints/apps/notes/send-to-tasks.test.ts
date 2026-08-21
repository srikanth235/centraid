import { describe, expect, it } from "vitest";

import {
  dateFromLine,
  sendToTasksPayload,
  wantsDate,
} from "./send-to-tasks.ts";

/** A Wednesday, so every weekday case has both directions around it. */
const NOW = new Date(2026, 2, 11);

describe(dateFromLine, () => {
  it("reads an explicit calendar day", () => {
    expect(dateFromLine("Sign the transfer 2026-04-02", NOW)).toBe(
      "2026-04-02"
    );
  });

  it("reads today and tomorrow against the injected clock", () => {
    expect(dateFromLine("Ring the roofer today", NOW)).toBe("2026-03-11");
    expect(dateFromLine("Ring the roofer tonight", NOW)).toBe("2026-03-11");
    expect(dateFromLine("Ring the roofer tomorrow", NOW)).toBe("2026-03-12");
  });

  it("resolves a weekday forward, and names today when it is today", () => {
    expect(dateFromLine("Ask the solicitor on Friday", NOW)).toBe("2026-03-13");
    expect(dateFromLine("Ask the solicitor on Tuesday", NOW)).toBe(
      "2026-03-17"
    );
    expect(dateFromLine("Ask the solicitor on Wednesday", NOW)).toBe(
      "2026-03-11"
    );
  });

  it("reads a month and a day, rolling to next year once it is past", () => {
    expect(dateFromLine("Meter readings 2 April", NOW)).toBe("2026-04-02");
    expect(dateFromLine("Meter readings April 2", NOW)).toBe("2026-04-02");
    expect(dateFromLine("Meter readings 3 January", NOW)).toBe("2027-01-03");
  });

  it("finds no date where the line names none", () => {
    expect(dateFromLine("Cancel the storage unit", NOW)).toBeNull();
  });
});

describe(wantsDate, () => {
  it("offers the control on an open line that names a day", () => {
    expect(
      wantsDate({ text: "Ring the roofer tomorrow", checked: false })
    ).toBe(true);
  });

  it("offers it on an open line that waits on someone else", () => {
    expect(
      wantsDate({
        text: "Ask [[Tom Pemberton]] about the survey",
        checked: false,
      })
    ).toBe(true);
  });

  it("stays away from a finished line, a blank one, and plain content", () => {
    expect(wantsDate({ text: "Ring the roofer tomorrow", checked: true })).toBe(
      false
    );
    expect(wantsDate({ text: "   ", checked: false })).toBe(false);
    expect(wantsDate({ text: "Cancel the storage unit", checked: false })).toBe(
      false
    );
  });
});

describe(sendToTasksPayload, () => {
  it("carries the line's words, its date and the note it came from", () => {
    expect(
      sendToTasksPayload({
        noteId: "note-1",
        line: 4,
        text: "  Ring the roofer tomorrow  ",
        now: NOW,
      })
    ).toStrictEqual({
      title: "Ring the roofer tomorrow",
      due_at: "2026-03-12",
      note_id: "note-1",
      line: 4,
      exact: "Ring the roofer tomorrow",
    });
  });

  /**
   * UNDATED UNLESS THE LINE CARRIED A DATE. An undated task never touches
   * Today and never reaches the calendar grid, so the absence of `due_at` here
   * is the property the whole projection rests on — not a default that happens
   * to be missing.
   */
  it("sends no due date when the line named none", () => {
    const payload = sendToTasksPayload({
      noteId: "note-1",
      line: 2,
      text: "Ask [[Tom Pemberton]] about the survey",
      now: NOW,
    });
    expect(payload).not.toHaveProperty("due_at");
    // The sigils are markup, not words: a task title is a sentence to read.
    expect(payload.title).toBe("Ask Tom Pemberton about the survey");
    // The anchor keeps the line VERBATIM, so the link points at the passage
    // as the member actually wrote it.
    expect(payload.exact).toBe("Ask [[Tom Pemberton]] about the survey");
  });
});
