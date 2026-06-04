/**
 * Shared error class for manifest validation. Lives in its own
 * module so the output-schema validator can reference it without
 * circularly depending on the main parser entrypoint.
 */

export type ManifestValidationCode =
  | 'invalid_json'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_trigger'
  | 'invalid_output_schema'
  | 'invalid_history'
  | 'invalid_on_failure'
  | 'mock_model_disallowed';

export class ManifestError extends Error {
  readonly code: ManifestValidationCode;
  readonly field?: string;
  constructor(code: ManifestValidationCode, message: string, field?: string) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}
