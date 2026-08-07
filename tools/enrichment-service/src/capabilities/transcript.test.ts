import { afterEach, describe, expect, it, vi } from "vitest";

import { guessExtension, probeTranscriptEndpoint } from "./transcript.js";

describe(guessExtension, () => {
  it("extracts the subtype from a simple media type", () => {
    expect(guessExtension("audio/mpeg")).toBe("mpeg");
  });

  it("strips a trailing parameter (e.g. codecs)", () => {
    expect(guessExtension("audio/webm;codecs=opus")).toBe("webm");
  });

  it("falls back to bin for an unparseable media type", () => {
    expect(guessExtension("not-a-media-type")).toBe("bin");
  });
});

describe(probeTranscriptEndpoint, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the endpoint responds with a non-5xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    );
    await expect(
      probeTranscriptEndpoint("http://127.0.0.1:9/probe")
    ).resolves.toBe(true);
  });

  it("returns false when the endpoint responds with a 5xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    );
    await expect(
      probeTranscriptEndpoint("http://127.0.0.1:9/probe")
    ).resolves.toBe(false);
  });

  it("returns false when fetch throws (endpoint unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused"))
    );
    await expect(
      probeTranscriptEndpoint("http://127.0.0.1:9/probe")
    ).resolves.toBe(false);
  });
});
