import { describe, expect, it } from "vitest";

import {
  readShareSection,
  shareAbsentLine,
  shareReadReach,
} from "./sharing-reads";

describe("one section's answer", () => {
  it("carries rows when the read landed", async () => {
    await expect(
      readShareSection(() => Promise.resolve([{ id: "a" }]), true)
    ).resolves.toStrictEqual({ state: "read", rows: [{ id: "a" }] });
  });

  it("is absent, not empty, when the read failed", async () => {
    const answer = await readShareSection(
      () => Promise.reject(new Error("list links (500)")),
      true
    );
    expect(answer.state).toBe("absent");
    expect(answer).not.toHaveProperty("rows");
  });

  it("says the gateway refused when the gateway answered", async () => {
    await expect(
      readShareSection(
        () => Promise.reject(new Error("list links (403)")),
        true
      )
    ).resolves.toStrictEqual({ state: "absent", reach: "refused" });
  });

  it("says out of reach when the request never left the device", async () => {
    await expect(
      readShareSection(
        () => Promise.reject(new TypeError("Network request failed")),
        true
      )
    ).resolves.toStrictEqual({ state: "absent", reach: "unreachable" });
  });
});

describe("naming which of the two happened", () => {
  it("reads a rejected fetch as unreachable, and any other error as refused", () => {
    expect(shareReadReach(new TypeError("Network request failed"), true)).toBe(
      "unreachable"
    );
    expect(shareReadReach(new Error("HTTP 500"), true)).toBe("refused");
  });

  it("trusts a replica that already knows the device is offline", () => {
    expect(shareReadReach(new Error("HTTP 500"), false)).toBe("unreachable");
  });

  it("gives the two failures different sentences", () => {
    const noun = "Who is linked";
    expect(shareAbsentLine(noun, "unreachable")).not.toBe(
      shareAbsentLine(noun, "refused")
    );
    expect(shareAbsentLine(noun, "unreachable")).toContain("out of reach");
    expect(shareAbsentLine(noun, "refused")).toContain("refused");
    expect(shareAbsentLine(noun, "refused")).not.toContain("yet");
  });
});
