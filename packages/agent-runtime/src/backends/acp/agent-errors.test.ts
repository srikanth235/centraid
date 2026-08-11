import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import {
  AUTH_REQUIRED_CODE,
  authRequiredMessage,
  classifyAgentFailure,
  classifyAgentFailureDetail,
} from "./agent-errors.js";
import type { AcpTurnConfig } from "./types.js";

const config: AcpTurnConfig = {
  kind: "goose",
  acpArgs: ["acp"],
  label: "goose",
  installHint: "brew install block-goose-cli and run goose configure.",
};
describe("agent-errors suite", () => {
  test("AUTH_REQUIRED uses install hint", () => {
    const msg = classifyAgentFailure(
      new RequestError(AUTH_REQUIRED_CODE, "Authentication required"),
      "",
      config
    );
    expect(msg).toBe(authRequiredMessage(config));
    expect(msg).toContain("goose configure");
  });

  test("internal error with auth-ish text becomes actionable", () => {
    const msg = classifyAgentFailure(
      new RequestError(-32603, "Internal error"),
      "provider not configured",
      config
    );
    expect(msg).toMatch(/sign-in|provider|configure/iu);
    expect(msg).toContain("goose configure");
  });

  test("internal error classifies an expired OAuth authentication failure as auth", () => {
    expect(
      classifyAgentFailureDetail(
        new RequestError(
          -32603,
          "Failed to authenticate: OAuth session expired"
        ),
        "",
        config
      ).failureClass
    ).toBe("auth");
  });

  test("unrelated errors keep message + stderr tail", () => {
    const msg = classifyAgentFailure(new Error("boom"), "stack line", {
      kind: "acp",
      acpArgs: [],
    });
    expect(msg).toContain("boom");
    expect(msg).toContain("stack line");
  });

  test("auth-ish RPC wording without AUTH_REQUIRED still gets an unauth message", () => {
    const msg = classifyAgentFailure(
      new RequestError(-32001, "please sign in first"),
      "",
      config
    );
    expect(msg).toMatch(/unauthenticated|unconfigured/iu);
    expect(msg).toContain("goose configure");
  });

  test("auth-ish text with acp rpc string (non-RequestError) is classified", () => {
    const msg = classifyAgentFailure(
      new Error("acp rpc failed: login required"),
      "not logged in",
      {
        kind: "acp",
        acpArgs: [],
        label: "Custom",
      }
    );
    expect(msg).toMatch(/unauthenticated|unconfigured/iu);
    expect(msg).toContain("not logged in");
  });

  test("authRequiredMessage omits hint when installHint is absent", () => {
    const msg = authRequiredMessage({
      kind: "gemini",
      acpArgs: ["--acp"],
      label: "Gemini",
    });
    expect(msg).toContain("Gemini");
    expect(msg).toMatch(/isn’t signed in/u);
    expect(msg).not.toMatch(/\.\s{2}/u); // no dangling double space from empty hint
  });

  test("internal error without auth-ish text falls through to raw message", () => {
    const msg = classifyAgentFailure(
      new RequestError(-32603, "disk full"),
      "ENOSPC",
      config
    );
    expect(msg).toContain("disk full");
    expect(msg).toContain("ENOSPC");
    expect(msg).not.toMatch(/sign-in|provider setup/iu);
  });

  test.each([
    ["rate limit quota exceeded", "quota"],
    ["prompt idle watchdog timed out (wedge)", "wedge"],
    ["initialize timed out", "timeout"],
    ["spawn ENOENT", "spawn"],
    ["agent exited with signal", "exit"],
  ] as const)("classifies %s as %s", (message, failureClass) => {
    expect(
      classifyAgentFailureDetail(new Error(message), "", config).failureClass
    ).toBe(failureClass);
  });

  // ---- classification precedence ------------------------------------------
  //
  // The class drives a per-class circuit breaker (issue #567 D7), so a
  // misclassification trips the wrong breaker. Structured signals must beat
  // keyword scans, and the primary message must beat vendor stderr — these
  // stderr strings are the full, realistic multi-line dumps agents actually
  // print, not one hand-picked line.

  const CRASH_STDERR = [
    "thread 'main' panicked at src/session.rs:214:",
    "called `Result::unwrap()` on an `Err` value: Elapsed(())",
    "note: request timeout was set to 30s (RUST_BACKTRACE=1 for a backtrace)",
    "  0: agent_core::session::prompt",
    "  1: agent_core::main",
  ].join("\n");

  test("a crash whose stderr mentions a timeout is not classified as a timeout", () => {
    const detail = classifyAgentFailureDetail(
      new Error("acp agent exited with code 101"),
      CRASH_STDERR,
      config
    );
    expect(detail.failureClass).toBe("exit");
    // The evidence is still reported to the owner verbatim.
    expect(detail.message).toContain("panicked");
  });

  test("stderr is still consulted when the message decides nothing", () => {
    expect(
      classifyAgentFailureDetail(
        new Error("agent stopped responding"),
        CRASH_STDERR,
        config
      ).failureClass
    ).toBe("timeout");
  });

  test("a quota RPC code outranks a message with no quota wording", () => {
    const detail = classifyAgentFailureDetail(
      // -32029 is what the scripted agent (and agents in this space) answer for
      // a rate limit; the text alone would fall through to `init`.
      new RequestError(-32029, "The model is overloaded, please retry"),
      "HTTP 429 from provider\nretry-after: 60",
      config
    );
    expect(detail.failureClass).toBe("quota");
  });

  test("a forwarded HTTP 429 RPC code is a quota failure", () => {
    expect(
      classifyAgentFailureDetail(
        new RequestError(429, "Too Many Requests"),
        "",
        config
      ).failureClass
    ).toBe("quota");
  });

  test("our own stage timeouts classify by stage, not by keyword", () => {
    // These strings are authored by the backend's `requestWithTimeout`, so the
    // stage name in them is structured evidence.
    expect(
      classifyAgentFailureDetail(
        new Error("ACP session/new timed out after 20000ms"),
        "",
        config
      ).failureClass
    ).toBe("init");
    expect(
      classifyAgentFailureDetail(
        new Error("ACP initialize timed out after 20000ms"),
        "",
        config
      ).failureClass
    ).toBe("init");
    expect(
      classifyAgentFailureDetail(
        new Error("ACP session/close timed out after 20000ms"),
        "",
        config
      ).failureClass
    ).toBe("timeout");
    expect(
      classifyAgentFailureDetail(
        new Error("ACP prompt idle watchdog timed out after 120000ms (wedge)"),
        "",
        config
      ).failureClass
    ).toBe("wedge");
  });
});
