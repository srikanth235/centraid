import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "design",
    include: ["src/**/*.test.ts"],
  },
});
