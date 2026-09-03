import type {
  SessionConfigOption,
  SessionConfigSelectOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import type { TurnStreamEvent } from "@centraid/server/engine";

import {
  hasSessionCapability,
  modeAvailable,
  pinModel,
  pinThoughtLevel,
  readConfigOptionUpdate,
  readConfigOptions,
  readCurrentConfigValue,
  readOfferedModels,
  SET_CONFIG_OPTION,
} from "./session-config.ts";
import type { AcpBuiltinRequest } from "./session-config.ts";

const values = (...entries: string[]): SessionConfigSelectOption[] =>
  entries.map((value) => ({ value, name: value }));

function selectOption(
  id: string,
  currentValue: string,
  offered: SessionConfigSelectOption[],
  category: string = id
): Extract<SessionConfigOption, { type: "select" }> {
  return {
    type: "select",
    id,
    name: id,
    category,
    currentValue,
    options: offered,
  };
}

function requestReturning(response: SetSessionConfigOptionResponse): {
  request: AcpBuiltinRequest;
  calls: ReturnType<typeof vi.fn>;
} {
  const calls = vi.fn<() => Promise<SetSessionConfigOptionResponse>>(
    async () => response
  );
  return { request: calls as unknown as AcpBuiltinRequest, calls };
}

function rejectingRequest(): AcpBuiltinRequest {
  return vi.fn<() => Promise<never>>(async () => {
    throw new Error("stale option");
  }) as unknown as AcpBuiltinRequest;
}

describe("session-config suite", () => {
  test("session lifecycle capability objects are the supported signal", () => {
    expect(hasSessionCapability(undefined, "resume")).toBe(false);
    expect(hasSessionCapability({}, "resume")).toBe(false);
    expect(hasSessionCapability({ resume: null }, "resume")).toBe(false);
    expect(hasSessionCapability({ resume: {} }, "resume")).toBe(true);
    expect(hasSessionCapability({ close: {} }, "close")).toBe(true);
    expect(
      hasSessionCapability(
        { additionalDirectories: {} },
        "additionalDirectories"
      )
    ).toBe(true);
  });

  test("modeAvailable matches current and advertised SDK modes", () => {
    const modes = {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "bypassPermissions", name: "Confined" },
      ],
    };
    expect(modeAvailable(undefined, "default")).toBe(false);
    expect(modeAvailable(modes, "default")).toBe(true);
    expect(modeAvailable(modes, "bypassPermissions")).toBe(true);
    expect(modeAvailable(modes, "missing")).toBe(false);
  });

  test("config snapshots and full-set updates keep the SDK objects", () => {
    const model = selectOption("model", "m1", values("m1", "m2"));
    expect(readConfigOptions(undefined)).toStrictEqual([]);
    expect(
      readConfigOptions({ sessionId: "s1", configOptions: [model] })
    ).toStrictEqual([model]);
    expect(
      readConfigOptionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [model],
        },
      })
    ).toStrictEqual([model]);
    expect(
      readConfigOptionUpdate({
        sessionId: "s1",
        update: { sessionUpdate: "current_mode_update", currentModeId: "x" },
      })
    ).toBeUndefined();
  });

  test("model helpers read current value and flatten SDK option groups", () => {
    const grouped: SessionConfigOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "m1",
      options: [
        { group: "fast", name: "Fast", options: values("m1") },
        { group: "smart", name: "Smart", options: values("m2") },
      ],
    };
    expect(readCurrentConfigValue([grouped], "model")).toBe("m1");
    expect(readOfferedModels([grouped])).toStrictEqual({
      models: values("m1", "m2"),
      currentValue: "m1",
    });
  });

  test("pinModel returns current without an RPC when no change is needed", async () => {
    const request = vi.fn<
      () => Promise<never>
    >() as unknown as AcpBuiltinRequest;
    const option = selectOption("model", "opus", values("opus", "sonnet"));
    await expect(
      pinModel({
        request,
        emit: () => undefined,
        sessionId: "s1",
        configOptions: [option],
        requested: "opus",
      })
    ).resolves.toBe("opus");
    expect(request).not.toHaveBeenCalled();
  });

  test("pinModel applies the SDK request and trusts a matching echo", async () => {
    const option = selectOption("model", "opus", [
      { value: "opus", name: "Opus" },
      { value: "sonnet", name: "Sonnet" },
    ]);
    const next = selectOption(
      "model",
      "sonnet",
      option.options as SessionConfigSelectOption[]
    );
    const { request, calls } = requestReturning({ configOptions: [next] });
    await expect(
      pinModel({
        request,
        emit: () => undefined,
        sessionId: "s1",
        configOptions: [option],
        requested: "Sonnet",
      })
    ).resolves.toBe("sonnet");
    expect(calls).toHaveBeenCalledWith(SET_CONFIG_OPTION, {
      sessionId: "s1",
      configId: "model",
      value: "sonnet",
    });
  });

  test("pinModel warns for unsupported, unoffered, rejected, and contradicted pins", async () => {
    const notices: Array<{ code?: string }> = [];
    const emit = (event: TurnStreamEvent): void => {
      if ("code" in event) notices.push({ code: event.code });
    };
    const request = vi.fn<
      () => Promise<never>
    >() as unknown as AcpBuiltinRequest;
    await expect(
      pinModel({
        request,
        emit,
        sessionId: "s1",
        configOptions: [],
        requested: "missing",
      })
    ).resolves.toBeUndefined();
    expect(notices.at(-1)?.code).toBe("model_unsupported");

    const option = selectOption("model", "m1", values("m1", "m2"));
    await expect(
      pinModel({
        request,
        emit,
        sessionId: "s1",
        configOptions: [option],
        requested: "missing",
      })
    ).resolves.toBe("m1");
    expect(notices.at(-1)?.code).toBe("model_not_offered");

    await expect(
      pinModel({
        request: rejectingRequest(),
        emit,
        sessionId: "s1",
        configOptions: [option],
        requested: "m2",
      })
    ).resolves.toBe("m1");
    expect(notices.at(-1)?.code).toBe("model_not_offered");

    const contradiction = requestReturning({ configOptions: [option] });
    await expect(
      pinModel({
        request: contradiction.request,
        emit,
        sessionId: "s1",
        configOptions: [option],
        requested: "m2",
      })
    ).resolves.toBeUndefined();
    expect(notices.at(-1)?.code).toBe("model_unconfirmed");
  });

  test("pinThoughtLevel applies, rejects, and validates SDK echoes", async () => {
    const option = selectOption(
      "effort",
      "medium",
      values("medium", "high"),
      "thought_level"
    );
    const confirmed = requestReturning({
      configOptions: [
        selectOption(
          "effort",
          "high",
          values("medium", "high"),
          "thought_level"
        ),
      ],
    });
    await expect(
      pinThoughtLevel({
        request: confirmed.request,
        emit: () => undefined,
        sessionId: "s1",
        configOptions: [option],
        requested: "HIGH",
      })
    ).resolves.toBe("high");

    const notices: Array<{ code?: string }> = [];
    await expect(
      pinThoughtLevel({
        request: rejectingRequest(),
        emit: (event) => {
          if ("code" in event) notices.push({ code: event.code });
        },
        sessionId: "s1",
        configOptions: [option],
        requested: "high",
      })
    ).resolves.toBe("medium");
    expect(notices.at(-1)?.code).toBe("thought_level_not_offered");
  });
});
