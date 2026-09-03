import { fileURLToPath } from "node:url";

import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  resolve: {
    alias: [
      {
        find: /^@centraid\/design\/elements$/u,
        replacement: fileURLToPath(
          new URL("../design/src/elements/index.ts", import.meta.url)
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
    name: "@centraid/blueprints",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "automations/**/*.test.ts",
    ],
  },
});
