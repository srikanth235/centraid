/**
 * Shared error class for manifest validation. Lives in its own
 * module so the output-schema validator can reference it without
 * circularly depending on the main parser entrypoint.
 */

export type AutomationManifestValidationCode =
  | 'invalid_json'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_schedule'
  | 'invalid_action_path'
  | 'invalid_trigger'
  | 'invalid_output_schema'
  | 'invalid_history'
  | 'invalid_on_failure'
  | 'mock_model_disallowed';

export class AutomationManifestError extends Error {
  readonly code: AutomationManifestValidationCode;
  readonly field?: string;
  constructor(code: AutomationManifestValidationCode, message: string, field?: string) {
    super(message);
    this.name = 'AutomationManifestError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}
