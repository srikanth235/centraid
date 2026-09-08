/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.untrusted.mutation.config.ts",
    related: false,
  },
  testFiles: ["apps/_shared/untrusted-properties.test.ts"],
  // The render-boundary policy every first-party app leans on: the display-text
  // scrubber (control + bidi code points) and the four dynamic URL sinks
  // (external / media / document / background-image) that gate `javascript:`,
  // `data:text/html`, `data:image/svg`, control smuggling, and CSS url()
  // break-out. A survived mutant here is member-supplied content reaching a
  // sink the module claims to have closed — an XSS or spoof bug, not a UI one.
  //
  // This is the NODE-side property suite on purpose: the module's other suite
  // (src/untrusted-rendering.test.ts) runs under jsdom, and Stryker's vitest
  // runner dry-runs a jsdom project as "No tests were executed", so it defends
  // no mutant. See tests/floors.json#mutation (#864) for the floor's provenance.
  mutate: ["apps/_shared/untrusted.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/untrusted-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
