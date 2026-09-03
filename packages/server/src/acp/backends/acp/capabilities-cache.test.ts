import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test, afterEach } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  CAPABILITIES_TTL_MS,
  clearCapabilitiesCache,
  resolveAcpCapabilities,
} from "./capabilities-cache.ts";
import { probeAcpCapabilities } from "./probe-capabilities.ts";
import { FAKE_HARNESS } from "./test-fixtures.js";

describe("capabilities-cache suite", () => {
  afterEach(() => {
    clearCapabilitiesCache();
  });

  test("probeAcpCapabilities reports reachable + advertised caps from fake harness", async () => {
    const caps = await probeAcpCapabilities(
      {
        kind: "acp",
        acpArgs: [],
        binPath: FAKE_HARNESS,
        extraArgs: [
          "--mode=normal",
          "--session-resume",
          "--session-close",
          "--session-addl-dirs",
          "--mcp-http",
          "--prompt-caps=image,audio,embeddedContext",
        ],
      },
      { timeoutMs: 8_000, probeLivePrompt: true }
    );
    expect(caps.reachable).toBe(true);
    expect(caps.resume).toBe(true);
    expect(caps.close).toBe(true);
    expect(caps.additionalDirectories).toBe(true);
    expect(caps.mcpHttp).toBe(true);
    expect(caps.promptImage).toBe(true);
    expect(caps.promptAudio).toBe(true);
    expect(caps.promptEmbeddedContext).toBe(true);
    expect(caps.modelConfigurable).toBe(true);
    expect(caps.configOptions.map((option) => option.category)).toStrictEqual([
      "model",
      "thought_level",
    ]);
    expect(caps.usageUpdateObserved).toBe(true);
    expect(caps.configOptionUpdateObserved).toBe(true);
    expect(caps.locationsObserved).toBe(true);
    expect(caps.livePromptProbed).toBe(true);
    expect(caps.authRequired).toBe(false);
  });

  test("without probeLivePrompt the probe sends no session/prompt", async () => {
    const dir = await tempDir("acp-probe-noprompt-");
    const promptMarker = path.join(dir, "prompt.json");
    const caps = await probeAcpCapabilities(
      {
        kind: "acp",
        acpArgs: [],
        binPath: FAKE_HARNESS,
        extraArgs: ["--mode=normal", `--prompt-marker=${promptMarker}`],
      },
      { timeoutMs: 8_000 }
    );
    expect(caps.reachable).toBe(true);
    expect(caps.modelConfigurable).toBe(true);
    expect(caps.livePromptProbed).toBe(false);
    expect(caps.usageUpdateObserved).toBe(false);
    await expect(fs.access(promptMarker)).rejects.toThrow(/ENOENT/u);
  });

  test("a snapshot past its TTL is served marked stale, and re-probed on demand", async () => {
    const first = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
      refresh: true,
    });
    expect(first?.reachable).toBe(true);

    const clock = useFakeClock(undefined, { toFake: ["Date"] });
    clock.set(new Date(Date.now() + CAPABILITIES_TTL_MS + 1));
    const stale = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
    });
    expect(stale?.reachable).toBe(true);
    expect(stale?.stale).toBe(true);

    const refreshed = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
      probeIfMissing: true,
    });
    expect(refreshed?.stale).toBeUndefined();
    expect(refreshed?.probedAt).toBeGreaterThan(first!.probedAt);
  });

  test("probeIfMissing serves a fresh cache without spawning, and never buys a live prompt", async () => {
    const dir = await tempDir("acp-probe-ifmissing-");
    const promptMarker = path.join(dir, "prompt.json");
    const opts = {
      binPath: FAKE_HARNESS,
      extraArgs: ["--mode=normal", `--prompt-marker=${promptMarker}`],
    };
    const cold = await resolveAcpCapabilities("acp", {
      ...opts,
      probeIfMissing: true,
    });
    expect(cold?.reachable).toBe(true);
    expect(cold?.livePromptProbed).toBe(false);
    await expect(fs.access(promptMarker)).rejects.toThrow(/ENOENT/u);

    const warm = await resolveAcpCapabilities("acp", {
      ...opts,
      probeIfMissing: true,
    });
    expect(warm).toBe(cold);
  });

  test.each([
    {
      name: "config-option-less",
      args: ["--mode=normal", "--no-model-option", "--no-effort-option"],
      expected: {
        model: false,
        effort: false,
        usage: true,
        configUpdate: false,
        locations: true,
      },
    },
    {
      name: "model only",
      args: ["--mode=normal", "--no-effort-option"],
      expected: {
        model: true,
        effort: false,
        usage: true,
        configUpdate: true,
        locations: true,
      },
    },
    {
      name: "effort without model",
      args: ["--mode=normal", "--no-model-option"],
      expected: {
        model: false,
        effort: true,
        usage: true,
        configUpdate: false,
        locations: true,
      },
    },
    {
      name: "no optional observations",
      args: [
        "--mode=normal",
        "--no-usage-update",
        "--no-config-update",
        "--no-locations",
      ],
      expected: {
        model: true,
        effort: true,
        usage: false,
        configUpdate: false,
        locations: false,
      },
    },
  ])("capability matrix: $name", async ({ args, expected }) => {
    const caps = await probeAcpCapabilities(
      { kind: "acp", acpArgs: [], binPath: FAKE_HARNESS, extraArgs: args },
      { timeoutMs: 8_000, probeLivePrompt: true }
    );
    expect(caps.reachable).toBe(true);
    expect(caps.modelConfigurable).toBe(expected.model);
    expect(
      caps.configOptions.some((option) => option.category === "thought_level")
    ).toBe(expected.effort);
    expect(caps.usageUpdateObserved).toBe(expected.usage);
    expect(caps.configOptionUpdateObserved).toBe(expected.configUpdate);
    expect(caps.locationsObserved).toBe(expected.locations);
  });

  test("probeAcpCapabilities sets authRequired when session/new rejects auth", async () => {
    const caps = await probeAcpCapabilities(
      {
        kind: "acp",
        acpArgs: [],
        binPath: FAKE_HARNESS,
        extraArgs: ["--mode=auth"],
      },
      { timeoutMs: 8_000 }
    );
    expect(caps.reachable).toBe(true);
    expect(caps.authRequired).toBe(true);
  });

  test("probeAcpCapabilities sets authRequired when the diagnostic prompt rejects auth", async () => {
    const caps = await probeAcpCapabilities(
      {
        kind: "acp",
        acpArgs: [],
        binPath: FAKE_HARNESS,
        extraArgs: ["--mode=auth-prompt"],
      },
      { timeoutMs: 8_000, probeLivePrompt: true }
    );
    expect(caps.reachable).toBe(true);
    expect(caps.authRequired).toBe(true);
  });

  test("probeAcpCapabilities returns reason when binary cannot launch", async () => {
    const caps = await probeAcpCapabilities({
      kind: "acp",
      acpArgs: [],
    });
    expect(caps.reachable).toBe(false);
    expect(caps.reason).toMatch(/binary/iu);
  });

  test("resolveAcpCapabilities does not probe without refresh", async () => {
    const cold = await resolveAcpCapabilities("acp", { binPath: FAKE_HARNESS });
    expect(cold).toBeUndefined();
  });

  test("resolveAcpCapabilities caches a refresh probe and serves it cold", async () => {
    const first = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
      refresh: true,
    });
    expect(first?.reachable).toBe(true);

    const cached = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
    });
    expect(cached).toStrictEqual(first);
  });

  test("resolveAcpCapabilities coalesces concurrent refresh probes", async () => {
    const [a, b] = await Promise.all([
      resolveAcpCapabilities("acp", { binPath: FAKE_HARNESS, refresh: true }),
      resolveAcpCapabilities("acp", { binPath: FAKE_HARNESS, refresh: true }),
    ]);
    expect(a).toStrictEqual(b);
    expect(a?.reachable).toBe(true);
  });

  test("cache and probe include the configured extraArgs launch profile", async () => {
    const withoutModel = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
      extraArgs: ["--mode=normal", "--no-model-option"],
      refresh: true,
    });
    expect(withoutModel?.modelConfigurable).toBe(false);

    await expect(
      resolveAcpCapabilities("acp", {
        binPath: FAKE_HARNESS,
        extraArgs: ["--mode=normal"],
      })
    ).resolves.toBeUndefined();
    const withModel = await resolveAcpCapabilities("acp", {
      binPath: FAKE_HARNESS,
      extraArgs: ["--mode=normal"],
      refresh: true,
    });
    expect(withModel?.modelConfigurable).toBe(true);
  });
});
