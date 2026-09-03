import { fileURLToPath } from "node:url";

import { jsdomProject } from "@centraid/test-kit/vitest";

export default jsdomProject({
  resolve: {
    alias: [
      {
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
        find: /^@centraid\/design\/(?<module>color|css-vars|oklab)$/u,
        replacement: fileURLToPath(
          new URL("../design/src/$1.ts", import.meta.url)
        ),
      },
      {
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
    hookTimeout: 60_000,
  },
});
