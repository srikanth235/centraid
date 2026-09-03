import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/tunnel",
    include: ["src/**/*.test.ts"],
  },
});
