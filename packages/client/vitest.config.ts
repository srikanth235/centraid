import { fileURLToPath } from "node:url";

import { jsdomProject } from "@centraid/test-kit/vitest";

import { inlineBlueprintAliases } from "./src/react/blueprints/inline-vite-aliases.ts";

export default jsdomProject({
  resolve: {
    // Array form so the inline-app `./kit.ts` adapter alias applies under
    // vitest too (issue #505).
    alias: [
      ...inlineBlueprintAliases(),
      {
        find: "@centraid/design/kit",
        replacement: fileURLToPath(new URL("../design/kit", import.meta.url)),
      },
      {
        // Measurement machinery (contrast, oklab, emitted-CSS readers) is a
        // subpath rather than part of the barrel — pulling it through
        // `@centraid/design` would trip oxlint's 100-module barrel ceiling on
        // `packages/client/src/index.ts`.
        find: /^@centraid\/design\/(?<module>color|oklab)$/u,
        replacement: fileURLToPath(
          new URL("../design/src/$1.ts", import.meta.url)
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
