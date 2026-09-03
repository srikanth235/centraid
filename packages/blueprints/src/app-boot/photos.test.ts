import { describeAppBoot } from "../app-boot-harness.js";

describeAppBoot("photos", { expectLive: true });
// @vitest-environment jsdom
