import { defineConfig } from "vitest/config";

/*
 * The desktop seat's own vitest project (#1020 wave 3 lane F).
 *
 * One project over both halves — `electron/` (main + preload) and `renderer/`
 * — because the pure cores are shared across the boundary and a test that
 * imports one from the other must resolve it the same way the build does.
 *
 * Deliberately NOT a member of the repository-wide `vitest.config.ts` project
 * list: that list drives the v0 coverage run scored against
 * `tests/floors.json`, and adding a new tree to it would move coverage numbers
 * for reasons that have nothing to do with the v0 oracle it measures. The v1
 * gate entrypoint is `cargo xtask gate`, which runs this config by name — see
 * `contracts/handoff/F/desktop-e2e.md`.
 */
export default defineConfig({
  test: {
    name: "desktop-seat",
    root: import.meta.dirname,
    include: ["electron/src/**/*.test.ts", "renderer/src/**/*.test.ts"],
    environment: "node",
    // One worker: the sidecar tests spawn a real child process against a real
    // socket path, and two of those at once would race the path.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
  },
});
