// @vitest-environment jsdom
import { describeAppBoot } from "../app-boot-harness.ts";

describeAppBoot("agenda", { expectLive: true });
