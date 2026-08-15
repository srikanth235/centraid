/*
 * Recognition-handler suites use the repository-owned automation harness.
 * The shared implementation lives in test-kit so the source and published
 * handler trees exercise the same ctx.vault semantics without copied rails.
 */

export {
  bytesContent,
  createAutomationHandlerHarness as createHarness,
  selectRows,
  textContent,
} from "@centraid/test-kit/automation-handler-harness";

export type {
  AutomationHandlerHarness as Harness,
  AutomationHandlerHarnessOptions as HarnessOptions,
  ContentReply,
  DelegateCall,
  InvokeOutcome,
  InvokeRecord,
  ReadRequest,
  VaultRow,
} from "@centraid/test-kit/automation-handler-harness";
