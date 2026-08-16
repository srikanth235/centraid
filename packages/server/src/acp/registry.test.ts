import { existsSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { HARNESS_KINDS } from "@centraid/server/engine";
import type {
  HarnessKind,
  TurnConfig,
  TurnInput,
  TurnStreamEvent,
} from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { resolveAdapterEntry } from "./backends/acp/adapter-bin.ts";
import { planLaunch } from "./backends/acp/launch.ts";
import { HARNESSES, acpConfigFor, getHarness } from "./registry.ts";
import { runTurn } from "./runtime.ts";

describe("registry", () => {
  test("every known harness kind is registered with coherent metadata", () => {
    for (const kind of HARNESS_KINDS) {
      const harness = HARNESSES[kind];
      expect(harness, `missing harness for ${kind}`).toBeDefined();
      expect(harness.kind).toBe(kind);
      expect(harness.label.length).toBeGreaterThan(0);
      expect(harness.installHint.length).toBeGreaterThan(0);
      expect(harness.runTurn).toBeTypeOf("function");
      expect(harness.enumerateModels).toBeTypeOf("function");
    }
  });

  test("every kind keeps the USER-FACING CLI as its default bin; custom acp has none", () => {
    // Adapter-backed kinds included: preflight probes and version-hints the CLI
    // the user installs, never the ACP adapter we launch it through.
    expect(HARNESSES.codex.defaultBin).toBe("codex");
    expect(HARNESSES["claude-code"].defaultBin).toBe("claude");
    expect(HARNESSES.gemini.defaultBin).toBe("gemini");
    expect(HARNESSES.qwen.defaultBin).toBe("qwen");
    expect(HARNESSES.opencode.defaultBin).toBe("opencode");
    expect(HARNESSES.grok.defaultBin).toBe("grok");
    expect(HARNESSES.kimi.defaultBin).toBe("kimi");
    expect(HARNESSES.kilo.defaultBin).toBe("kilo");
    expect(HARNESSES.cline.defaultBin).toBe("cline");
    expect(HARNESSES.goose.defaultBin).toBe("goose");
    expect(HARNESSES.auggie.defaultBin).toBe("auggie");
    expect(HARNESSES.droid.defaultBin).toBe("droid");
    // copilot: the npm package is `@github/copilot` but the BIN is `copilot`.
    // Also NOT `copilot-language-server` — that is a different package entirely
    // (an LSP for editor completions), and it does not speak ACP.
    expect(HARNESSES.copilot.defaultBin).toBe("copilot");
    expect(HARNESSES.copilot.defaultBin).not.toBe("@github/copilot");
    expect(HARNESSES.copilot.defaultBin).not.toBe("copilot-language-server");
    // cursor: the installer makes BOTH `agent` and `cursor-agent`. We use the
    // qualified one on purpose — a bare `agent` on PATH is far too generic.
    expect(HARNESSES.cursor.defaultBin).toBe("cursor-agent");
    expect(HARNESSES.cursor.defaultBin).not.toBe("agent");
    // vibe: `vibe-acp` is a SEPARATE binary from `vibe`, not a mode of it.
    expect(HARNESSES.vibe.defaultBin).toBe("vibe-acp");
    // pi: same shape as vibe — `pi-acp` is a standalone ACP server binary.
    expect(HARNESSES.pi.defaultBin).toBe("pi-acp");
    expect(HARNESSES.acp.defaultBin).toBeUndefined();
  });

  test("natively ACP-speaking kinds enumerate no models (no hardcoded provider ids)", async () => {
    await Promise.all(
      (
        [
          "gemini",
          "qwen",
          "opencode",
          "grok",
          "kimi",
          "copilot",
          "cursor",
          "kilo",
          "cline",
          "goose",
          "auggie",
          "vibe",
          "droid",
          "pi",
          "acp",
        ] as const
      ).map((kind) =>
        expect(HARNESSES[kind].enumerateModels({})).resolves.toStrictEqual([])
      )
    );
  });

  // ---- ACP-native kinds: launch invocation is the only thing that differs ----

  test("opencode/grok/kimi launch ACP natively with their own subcommand", () => {
    // The ACP entry point is the whole per-kind difference, so it is pinned
    // exactly. `opencode acp` and `kimi acp` are SUBCOMMANDS: kimi's deprecated
    // `--acp` flag is single-session and has no session/load, which would break
    // resume, so a regression to the flag form must fail here.
    expect(acpConfigFor("opencode", {}).acpArgs).toStrictEqual(["acp"]);
    expect(acpConfigFor("grok", {}).acpArgs).toStrictEqual(["agent", "stdio"]);
    expect(acpConfigFor("kimi", {}).acpArgs).toStrictEqual(["acp"]);

    for (const kind of ["opencode", "grok", "kimi"] as const) {
      const config = acpConfigFor(kind, { binPath: `/opt/bin/${kind}` });
      // No adapter: these CLIs are the ACP process, so binPath is the spawn
      // target rather than an adapter env var.
      expect(config.adapter).toBeUndefined();
      expect(config.binPath).toBe(`/opt/bin/${kind}`);
      // Claude tier vocabulary must not leak onto non-Claude harnesses.
      expect(config.resolveModel).toBeUndefined();
    }
  });

  test("opencode is never launched with --mdns, which would bind 0.0.0.0", () => {
    // `--mdns` defaults opencode's hostname to 0.0.0.0, exposing an
    // unauthenticated code-execution harness on the LAN. We contribute only `acp`.
    expect(acpConfigFor("opencode", {}).acpArgs).not.toContain("--mdns");
  });

  test("grok pins the ACP-capable minimum, not the string-sort-adjacent 0.2.11", () => {
    // 0.2.11 predates ACP support; only a string sort makes it look newer.
    expect(HARNESSES.grok.minVersion).toStrictEqual({
      major: 0,
      minor: 2,
      patch: 106,
    });
    expect(HARNESSES.opencode.minVersion).toStrictEqual({
      major: 1,
      minor: 18,
      patch: 4,
    });
    expect(HARNESSES.kimi.minVersion).toStrictEqual({
      major: 1,
      minor: 17,
      patch: 0,
    });
  });

  test("kimi install hint uses the Python toolchain, not npm", () => {
    // Every other hint is an `npm i -g`; kimi-cli is installed with uv or the
    // vendor script, so a copy-pasted npm hint would be wrong for it.
    const hint = HARNESSES.kimi.installHint;
    expect(hint).toMatch(/uv tool install kimi-cli/u);
    expect(hint).not.toMatch(/npm/u);
    // Grok's paid-subscription requirement is what makes an install-but-fail
    // harness self-explanatory, so it must stay in the hint.
    expect(HARNESSES.grok.installHint).toMatch(/SuperGrok|X Premium/u);
  });

  // ---- wave 7: eight more ACP-native kinds ---------------------------------

  test("the eight added kinds pin their exact ACP invocation", () => {
    // The invocation is the whole per-kind difference, so each is pinned
    // exactly — a "tidy-up" that changes any of these ships a broken harness.
    expect(acpConfigFor("copilot", {}).acpArgs).toStrictEqual(["--acp"]);
    expect(acpConfigFor("cursor", {}).acpArgs).toStrictEqual(["acp"]);
    expect(acpConfigFor("kilo", {}).acpArgs).toStrictEqual(["acp"]);
    expect(acpConfigFor("cline", {}).acpArgs).toStrictEqual(["--acp"]);
    expect(acpConfigFor("goose", {}).acpArgs).toStrictEqual(["acp"]);
    expect(acpConfigFor("auggie", {}).acpArgs).toStrictEqual(["--acp"]);
    // droid: a subcommand plus a VALUE-BEARING flag. The three tokens are one
    // invocation; splitting or reordering them is not equivalent.
    expect(acpConfigFor("droid", {}).acpArgs).toStrictEqual([
      "exec",
      "--output-format",
      "acp-daemon",
    ]);
    // vibe: EMPTY. `vibe-acp` is its own entrypoint, so there is no mode flag to
    // pass. If this ever becomes `['acp']`, the harness is broken.
    expect(acpConfigFor("vibe", {}).acpArgs).toStrictEqual([]);
  });

  test("copilot is never launched in TCP mode", () => {
    // `--acp --port <n>` is a real Copilot mode, but it puts the harness on a
    // socket our stdio ACP client never reads. We contribute only `--acp`.
    expect(acpConfigFor("copilot", {}).acpArgs).not.toContain("--port");
  });

  test("the eight added kinds are native: no adapter, binPath is the spawn target", () => {
    for (const kind of [
      "copilot",
      "cursor",
      "kilo",
      "cline",
      "goose",
      "auggie",
      "vibe",
      "droid",
    ] as const) {
      const config = acpConfigFor(kind, { binPath: `/opt/bin/${kind}` });
      expect(config.adapter, kind).toBeUndefined();
      expect(config.binPath, kind).toBe(`/opt/bin/${kind}`);
      // Claude tier vocabulary must not leak onto non-Claude harnesses.
      expect(config.resolveModel, kind).toBeUndefined();
    }
  });

  test("auggie and droid carry their self-update suppressors as native launch env", () => {
    // These CLIs update themselves by default, which can swap the binary out
    // from under a running turn. The env vars are the fix — and they prove the
    // launch-env field reaches NATIVE kinds, not just adapter-backed ones.
    expect(acpConfigFor("auggie", {}).env).toStrictEqual({
      AUGMENT_DISABLE_AUTO_UPDATE: "1",
    });
    expect(acpConfigFor("droid", {}).env).toStrictEqual({
      DROID_DISABLE_AUTO_UPDATE: "true",
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    });
    // Kinds that need no launch env carry none.
    expect(acpConfigFor("kilo", {}).env).toBeUndefined();
  });

  test("a native kind with launch env spawns with it applied", () => {
    // The seam that matters: `planLaunch` must merge `config.env` on the native
    // path too. Asserted on the spawn plan, so nothing is actually spawned.
    const plan = planLaunch(acpConfigFor("droid", {}), undefined, []);
    expect(plan.bin).toBe("droid");
    expect(plan.args).toStrictEqual(["exec", "--output-format", "acp-daemon"]);
    expect(plan.env.DROID_DISABLE_AUTO_UPDATE).toBe("true");
    expect(plan.env.FACTORY_DROID_AUTO_UPDATE_ENABLED).toBe("false");
    // PATH still comes from `harnessSpawnEnv` — per-kind env must not clobber it.
    expect(plan.env.PATH).toBeTypeOf("string");

    const auggie = planLaunch(acpConfigFor("auggie", {}), undefined, []);
    expect(auggie.env.AUGMENT_DISABLE_AUTO_UPDATE).toBe("1");
  });

  test("cursor pins a CalVer floor, which still compares numerically", () => {
    // 2026.07.16 is year.month.day, NOT semver. It flows through the same
    // numeric comparison and orders correctly, so it needs no special case —
    // but do not "normalise" the major down to something semver-shaped.
    expect(HARNESSES.cursor.minVersion).toStrictEqual({
      major: 2026,
      minor: 7,
      patch: 16,
    });
    expect(HARNESSES.copilot.minVersion).toStrictEqual({
      major: 1,
      minor: 0,
      patch: 71,
    });
    expect(HARNESSES.kilo.minVersion).toStrictEqual({
      major: 7,
      minor: 4,
      patch: 11,
    });
    expect(HARNESSES.cline.minVersion).toStrictEqual({
      major: 3,
      minor: 0,
      patch: 46,
    });
    expect(HARNESSES.goose.minVersion).toStrictEqual({
      major: 1,
      minor: 43,
      patch: 0,
    });
    expect(HARNESSES.auggie.minVersion).toStrictEqual({
      major: 0,
      minor: 33,
      patch: 0,
    });
    expect(HARNESSES.vibe.minVersion).toStrictEqual({
      major: 2,
      minor: 21,
      patch: 0,
    });
    expect(HARNESSES.droid.minVersion).toStrictEqual({
      major: 0,
      minor: 175,
      patch: 1,
    });
  });

  test("pi launches ACP natively through its own dedicated binary, like vibe", () => {
    // `pi-acp` is the ACP server's own entrypoint, so `acpArgs` is EMPTY (no mode
    // flag to add) and there is no adapter — binPath is the spawn target.
    expect(acpConfigFor("pi", {}).acpArgs).toStrictEqual([]);
    expect(HARNESSES.pi.minVersion).toStrictEqual({
      major: 0,
      minor: 0,
      patch: 31,
    });
    const config = acpConfigFor("pi", { binPath: "/opt/bin/pi-acp" });
    expect(config.adapter).toBeUndefined();
    expect(config.binPath).toBe("/opt/bin/pi-acp");
    // Claude tier vocabulary must not leak onto a non-Claude harness.
    expect(config.resolveModel).toBeUndefined();
    expect(HARNESSES.pi.installHint).toMatch(/pi-acp/u);
  });

  test("paid-plan and out-of-band-setup requirements stay in the install hints", () => {
    // An installed-but-failing harness has to explain itself, or it reads as our
    // bug. These three fail AFTER a successful install for reasons only the
    // hint can convey.
    expect(HARNESSES.copilot.installHint).toMatch(
      /paid Copilot subscription/iu
    );
    expect(HARNESSES.cursor.installHint).toMatch(/paid Cursor plan/iu);
    expect(HARNESSES.auggie.installHint).toMatch(/paid Augment plan/iu);
    // goose fails session/new with an opaque -32603, NOT ACP's AUTH_REQUIRED,
    // until a provider is configured — so the hint has to say so up front.
    expect(HARNESSES.goose.installHint).toMatch(/goose configure/u);
    // vibe is a Python tool, like kimi — an npm hint would be wrong.
    expect(HARNESSES.vibe.installHint).toMatch(/uv tool install mistral-vibe/u);
    expect(HARNESSES.vibe.installHint).not.toMatch(/npm/u);
  });

  test("the eight added kinds route their turns through the generic ACP client", async () => {
    // An already-aborted turn can only terminate with the ACP client's own
    // `aborted` event, and nothing is spawned on that path.
    await Promise.all(
      (
        [
          "copilot",
          "cursor",
          "kilo",
          "cline",
          "goose",
          "auggie",
          "vibe",
          "droid",
        ] as const
      ).map(async (kind) => {
        const events: TurnStreamEvent[] = [];
        const controller = new AbortController();
        controller.abort();
        const result = await HARNESSES[kind].runTurn(
          {
            cwd: await tempDir("registry-acp-wave7-"),
            message: "hi",
            extraSystemPrompt: "",
            abortSignal: controller.signal,
            onEvent: (e: TurnStreamEvent) => events.push(e),
          } as unknown as TurnInput,
          { prefs: { kind } }
        );
        expect(result.harnessKind, kind).toBe(kind);
        expect(
          events.map((e) => e.type),
          kind
        ).toContain("aborted");
      })
    );
  });

  // ---- issue #479: one integration path, per-kind launch config -------------

  test("codex and claude-code drive the generic ACP client, not a bespoke harness", async () => {
    // The bespoke backends are gone; the only way to observe the transport from
    // here is that a turn now fails the way an ACP launch fails. Point each kind
    // at a binPath that cannot be a harness and confirm the ACP client's own
    // error surface (not a codex/claude-specific one) is what we get.
    await Promise.all(
      (["codex", "claude-code"] as const).map(async (kind) => {
        const events: TurnStreamEvent[] = [];
        const controller = new AbortController();
        controller.abort();
        const result = await HARNESSES[kind].runTurn(
          {
            cwd: await tempDir("registry-acp-"),
            message: "hi",
            extraSystemPrompt: "",
            abortSignal: controller.signal,
            onEvent: (e: TurnStreamEvent) => events.push(e),
          } as unknown as TurnInput,
          { prefs: { kind } }
        );
        expect(result.harnessKind).toBe(kind);
        // The ACP client always terminates an aborted turn with `aborted`.
        expect(events.map((e) => e.type)).toContain("aborted");
      })
    );
  });

  test("the ACP-native kinds route their turns through the generic ACP client", async () => {
    // Same observation as the codex/claude-code case: an already-aborted turn
    // can only terminate with the ACP client's own `aborted` event, and nothing
    // is spawned on that path.
    await Promise.all(
      (["opencode", "grok", "kimi"] as const).map(async (kind) => {
        const events: TurnStreamEvent[] = [];
        const controller = new AbortController();
        controller.abort();
        const result = await HARNESSES[kind].runTurn(
          {
            cwd: await tempDir("registry-acp-native-"),
            message: "hi",
            extraSystemPrompt: "",
            abortSignal: controller.signal,
            onEvent: (e: TurnStreamEvent) => events.push(e),
          } as unknown as TurnInput,
          { prefs: { kind } }
        );
        expect(result.harnessKind).toBe(kind);
        expect(events.map((e) => e.type)).toContain("aborted");
      })
    );
  });

  test("codex launches headless; claude launches in bypass mode; binPath targets the CLI", () => {
    // The launch config is what makes each adapter behave like the bespoke
    // harness it replaced, so it is asserted explicitly rather than inferred.
    const codex = acpConfigFor("codex", { binPath: "/opt/bin/codex" });
    expect(codex.adapter?.packageName).toBe("@agentclientprotocol/codex-acp");
    // Parity with the retired `approvalPolicy:'never'` + full-access sandbox.
    // Launch env is ONE field shared by native and adapter-backed kinds, so it
    // reads off the config, not off `adapter`.
    expect(codex.env).toStrictEqual({
      INITIAL_AGENT_MODE: "agent-full-access",
    });
    // binPath now means "the harness CLI", so it rides in as CODEX_PATH.
    expect(codex.adapter?.binPathEnvVar).toBe("CODEX_PATH");
    expect(codex.binPath).toBe("/opt/bin/codex");
    expect(codex.acpArgs).toStrictEqual([]);

    const claude = acpConfigFor("claude-code", { binPath: "/opt/bin/claude" });
    expect(claude.adapter?.packageName).toBe(
      "@agentclientprotocol/claude-agent-acp"
    );
    // Parity with the retired `permissionMode: 'bypassPermissions'`.
    expect(claude.adapter?.sessionModeId).toBe("bypassPermissions");
    // The adapter refuses bypass for a root process unless IS_SANDBOX is set.
    expect(claude.adapter?.bypassNeedsSandboxWhenRoot).toBe(true);
    expect(claude.adapter?.binPathEnvVar).toBe("CLAUDE_CODE_EXECUTABLE");
    // Capability tiers still resolve to the CLI's aliases before matching.
    expect(claude.resolveModel?.("smart")).toBe("opus");

    // Natively ACP-speaking kinds carry no adapter at all.
    expect(acpConfigFor("gemini", {}).adapter).toBeUndefined();
  });

  test("both adapter packages resolve to a real executable entry point", () => {
    // Guards the "no runtime npx -y" rule: the adapters must be installed
    // dependencies whose bin we can resolve offline.
    for (const pkg of [
      "@agentclientprotocol/codex-acp",
      "@agentclientprotocol/claude-agent-acp",
    ]) {
      const entry = resolveAdapterEntry(pkg);
      expect(existsSync(entry)).toBe(true);
    }
  });

  test("getHarness rejects an unknown kind", () => {
    expect(() => getHarness("nope" as HarnessKind)).toThrow(/no harness spec/u);
  });

  test("runTurn dispatches to the harness for the configured kind", async () => {
    // Stub a harness in the table and confirm runTurn routes to it, threading
    // input/config through unchanged.
    const original = HARNESSES.acp;
    let seen: { input?: TurnInput; config?: TurnConfig } = {};
    HARNESSES.acp = {
      ...original,
      runTurn: async (input, config) => {
        seen = { input, config };
        return { harnessKind: "acp", sessionId: "stub-session" };
      },
    };
    try {
      const input = {
        cwd: "/tmp/x",
        message: "hi",
        extraSystemPrompt: "",
        abortSignal: new AbortController().signal,
        onEvent: () => undefined,
      } as unknown as TurnInput;
      const config: TurnConfig = {
        prefs: { kind: "acp", binPath: "/bin/whatever" },
      };
      const result = await runTurn(input, config);
      expect(result).toStrictEqual({
        harnessKind: "acp",
        sessionId: "stub-session",
      });
      expect(seen.config?.prefs.kind).toBe("acp");
      expect(seen.input?.message).toBe("hi");
    } finally {
      HARNESSES.acp = original;
    }
  });
});
