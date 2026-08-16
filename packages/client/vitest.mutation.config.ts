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
        find: /^@centraid\/design$/u,
        replacement: fileURLToPath(
          new URL("../design/src/index.ts", import.meta.url)
        ),
      },
    ],
  },
  test: {
    name: "@centraid/client-mutation",
    include: [
      "src/replica/intent-idempotency-properties.test.ts",
      "src/replica/intents.contract.test.ts",
      "src/replica/payload-hash-identity.test.ts",
      "src/replica/payload-hash-properties.test.ts",
      "src/replica/payload-hash.test.ts",
    ],
  },
});
