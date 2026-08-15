import { fileURLToPath } from "node:url";

import { jsdomProject } from "@centraid/test-kit/vitest";

export default jsdomProject({
  resolve: {
    // Array form: every `@centraid/design` subpath resolves to SOURCE here, so
    // a suite reads the package's current tree rather than a stale `dist`.
    alias: [
      {
        // The browser element substrate the blueprint apps render on. No
        // `react-native` condition and never re-exported from the design
        // barrel — see packages/design/src/elements/index.ts.
        find: /^@centraid\/design\/elements$/u,
        replacement: fileURLToPath(
          new URL("../design/src/elements/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@centraid\/design\/kit\.css$/u,
        replacement: fileURLToPath(
          new URL("../design/src/elements/kit.css", import.meta.url)
        ),
      },
      {
        // Measurement machinery (contrast, oklab, emitted-CSS readers) is a
        // subpath rather than part of the barrel — pulling it through
        // `@centraid/design` would trip oxlint's 100-module barrel ceiling on
        // `packages/client/src/index.ts`.
        find: /^@centraid\/design\/(?<module>color|css-vars|oklab)$/u,
        replacement: fileURLToPath(
          new URL("../design/src/$1.ts", import.meta.url)
        ),
      },
      {
        // The headless block layer — the logic the DOM and React Native kits
        // share. A subpath for the same barrel-ceiling reason.
        find: /^@centraid\/design\/blocks$/u,
        replacement: fileURLToPath(
          new URL("../design/src/blocks/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@centraid\/design$/u,
        replacement: fileURLToPath(
          new URL("../design/src/index.ts", import.meta.url)
        ),
      },
    ],
  },
  test: {
    name: "@centraid/client",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Full affected runs execute the client beside five dependency-heavy
    // packages. Dynamic-import setup may be event-loop-starved even though it
    // completes in under a second alone; assertions keep their own deadlines.
    hookTimeout: 60_000,
  },
});
