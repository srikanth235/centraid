import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushMacrotasks } from "@centraid/test-kit/flush";

vi.mock(import("../replica/shell-session.js"), () => ({
  installReplicaStorageLifecycle: () => undefined,
}));
vi.mock(import("../device-enrichment-worker.js"), () => ({
  installDeviceEnrichmentWorker: () => () => undefined,
}));
vi.mock(import("../assist-oauth-handoff.js"), () => ({
  consumeInitialAssistHandoff: () => Promise.resolve({ status: "none" }),
  installDesktopAssistHandoff: () => () => undefined,
}));
vi.mock(import("./shell/App.js"), () => ({
  default: () => <div data-testid="app-shell">home</div>,
}));

describe("boot first paint suite", { timeout: 30_000 }, () => {
  let shell: HTMLElement;

  const bootWith = async (
    getSettings: () => Promise<{ onboardingCompletedAt?: string }>,
    extra?: Partial<typeof window.CentraidApi>
  ): Promise<void> => {
    window.CentraidApi = {
      getSettings,
      saveSettings: () => Promise.resolve({}),
      updateProfileMetadata: () => Promise.resolve(),
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
      ...extra,
    } as unknown as typeof window.CentraidApi;
    await act(async () => {
      await import("./boot.js");
      await flushMacrotasks();
    });
  };

  beforeEach(() => {
    vi.resetModules();
    (window as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      cssText: ":root{}",
      icons: {},
    };
    shell = document.createElement("div");
    shell.id = "root";
    document.body.append(shell);
  });

  afterEach(() => {
    shell.remove();
    vi.restoreAllMocks();
  });

  it("renders the startup error, not the first-run chooser, when the settings read fails", async () => {
    await bootWith(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'settings:get': Error: gateway.db is locked but the daemon is not answering"
        )
      )
    );

    expect(shell.querySelector("[data-testid='first-run-choice']")).toBeNull();
    const error = shell.querySelector("[data-testid='startup-error']");
    expect(error).not.toBeNull();
    expect(error?.textContent ?? "").not.toMatch(
      /fresh|erase|reset|start over/iu
    );
    expect(error?.textContent ?? "").toContain(
      "gateway.db is locked but the daemon is not answering"
    );
    expect(error?.textContent ?? "").not.toContain("remote method");
  });

  it("still treats a successful read with no onboarding stamp as a genuine first run", async () => {
    await bootWith(() => Promise.resolve({}));

    expect(
      shell.querySelector("[data-testid='first-run-choice']")
    ).not.toBeNull();
    expect(shell.querySelector("[data-testid='startup-error']")).toBeNull();
  });

  it("mounts the shell when the read succeeds and the member has onboarded", async () => {
    await bootWith(() =>
      Promise.resolve({ onboardingCompletedAt: "2026-07-31T00:00:00.000Z" })
    );

    expect(shell.querySelector("[data-testid='app-shell']")).not.toBeNull();
    expect(shell.querySelector("[data-testid='first-run-choice']")).toBeNull();
  });

  it("retries the read and recovers into the shell", async () => {
    let attempts = 0;
    await bootWith(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("device key custody mismatch"))
        : Promise.resolve({
            onboardingCompletedAt: "2026-07-31T00:00:00.000Z",
          });
    });
    expect(shell.querySelector("[data-testid='startup-error']")).not.toBeNull();

    const retry = shell.querySelector<HTMLButtonElement>(
      "[data-testid='startup-error'] button"
    );
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await flushMacrotasks();
    });

    expect(attempts).toBe(2);
    expect(shell.querySelector("[data-testid='app-shell']")).not.toBeNull();
    expect(shell.querySelector("[data-testid='startup-error']")).toBeNull();
  });

  it("asks the host to restart the gateway before re-reading, and recovers", async () => {
    const order: string[] = [];
    let gatewayUp = false;
    const retryGatewayStart = vi.fn<
      () => Promise<{ ok: boolean; error?: string }>
    >(() => {
      order.push("retry-start");
      gatewayUp = true;
      return Promise.resolve({ ok: true });
    });

    await bootWith(
      () => {
        order.push("read");
        return gatewayUp
          ? Promise.resolve({
              onboardingCompletedAt: "2026-07-31T00:00:00.000Z",
            })
          : Promise.reject(
              new Error(
                'local gateway "local" failed to start repeatedly and stopped retrying'
              )
            );
      },
      { retryGatewayStart } as unknown as Partial<typeof window.CentraidApi>
    );

    expect(shell.querySelector("[data-testid='startup-error']")).not.toBeNull();
    expect(
      shell.querySelector("[data-testid='startup-error']")?.textContent ?? ""
    ).not.toContain("Settings");

    await act(async () => {
      shell
        .querySelector<HTMLButtonElement>(
          "[data-testid='startup-error'] button"
        )
        ?.click();
      await flushMacrotasks();
    });

    expect(retryGatewayStart).toHaveBeenCalledOnce();
    expect(order).toStrictEqual(["read", "retry-start", "read"]);
    expect(shell.querySelector("[data-testid='app-shell']")).not.toBeNull();
    expect(shell.querySelector("[data-testid='startup-error']")).toBeNull();
  });

  it("still re-reads on a host that has no local gateway to retry", async () => {
    let attempts = 0;
    await bootWith(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("gateway unreachable"))
        : Promise.resolve({
            onboardingCompletedAt: "2026-07-31T00:00:00.000Z",
          });
    });

    await act(async () => {
      shell
        .querySelector<HTMLButtonElement>(
          "[data-testid='startup-error'] button"
        )
        ?.click();
      await flushMacrotasks();
    });

    expect(attempts).toBe(2);
    expect(shell.querySelector("[data-testid='app-shell']")).not.toBeNull();
  });
});
