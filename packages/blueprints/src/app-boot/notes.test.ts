// @vitest-environment jsdom
// One file per app: vitest's forks pool isolates per FILE, and each app must
// own its process (module-scope timers that outlive a test, and apps that
// define custom elements at module scope). See ../app-boot-harness.ts for why.
import { describeAppBoot } from "../app-boot-harness.js";

describeAppBoot("notes");
