import { describe, expect, test } from "vitest";

import type { TurnConfig, TurnInput } from "@centraid/server/engine";

import { runTurn } from "./runtime.ts";

describe(runTurn, () => {
  test("rejects an unknown configured kind", async () => {
    const input = {
      cwd: "/tmp/x",
      message: "hi",
      extraSystemPrompt: "",
      abortSignal: new AbortController().signal,
      onEvent: () => undefined,
    } as unknown as TurnInput;
    const config = { prefs: { kind: "bogus" } } as unknown as TurnConfig;

    await expect(runTurn(input, config)).rejects.toThrow(
      /unknown harness kind/u
    );
  });
});
