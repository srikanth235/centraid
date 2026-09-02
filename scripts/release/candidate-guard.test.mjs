import { describe, expect, it } from "vitest";

import {
  CANDIDATE_REF,
  judgeCandidate,
  readCandidatePointer,
} from "./candidate-guard.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("release candidate guard (#915)", () => {
  it("reads the promoted SHA out of git ls-remote", () => {
    expect(readCandidatePointer(() => `${HEAD}\t${CANDIDATE_REF}\n`)).toBe(
      HEAD
    );
    expect(readCandidatePointer(() => "")).toBeNull();
    expect(
      readCandidatePointer(() => {
        throw new Error("no remote");
      })
    ).toBeNull();
  });

  it("passes when HEAD is the promoted candidate", () => {
    const verdict = judgeCandidate({
      head: HEAD,
      candidate: HEAD,
      allowUncandidated: false,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("is the promoted candidate");
  });

  it("refuses a SHA that was never promoted, and names both", () => {
    const verdict = judgeCandidate({
      head: HEAD,
      candidate: OTHER,
      allowUncandidated: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(HEAD);
    expect(verdict.message).toContain(OTHER);
  });

  it("says so plainly when nothing has ever been promoted", () => {
    const verdict = judgeCandidate({
      head: HEAD,
      candidate: null,
      allowUncandidated: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("no candidate has ever been promoted");
  });

  it("the escape hatch passes but prints the reason it was used", () => {
    const verdict = judgeCandidate({
      head: HEAD,
      candidate: OTHER,
      allowUncandidated: true,
      reason: "hotfix for a live outage",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("hotfix for a live outage");
  });

  it("an override with no reason still records that none was given", () => {
    const verdict = judgeCandidate({
      head: HEAD,
      candidate: OTHER,
      allowUncandidated: true,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("none given");
  });
});
