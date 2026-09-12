// WHY A TRANSFER DID NOT LAND, IN THE MEMBER'S WORDS (#1015 R-NY-10).
//
// `upload_item.last_error` is not a diagnostic. Three member surfaces print
// the row verbatim — Backup health's failure list, the backup verdict's detail
// line, Home's notification cause — so it is member copy, and it is produced
// HERE, at the one seam that still knows what failed. The raw text never
// enters the row: the drainer logs it (`[centraid] upload:`, docs/logs.md).
//
// It replaced a regex pass on the seat that lowered "gateway" to "vault host"
// AFTER the fact, which could only ever launder the vocabulary of a sentence
// the member should not have been shown at all.

import { DirectTransferError } from "./gateway-client";

/** One error noun per outcome; no trailing stop — the callers compose. */
const PAIRING_LOST = "This phone is no longer paired with your vault";
const OUT_OF_SPACE = "Your vault is out of space";
const UNREACHABLE = "Your vault could not be reached";
const REFUSED = "Your vault would not take this file";
/** Anything this phone cannot classify, including its own refusals. */
const UNKNOWN = "This phone could not send this file";

/** The sentence a member reads for a failed transfer. */
export function memberTransferFailure(error: unknown): string {
  if (!(error instanceof DirectTransferError)) return UNKNOWN;
  if (error.member !== undefined) return error.member;
  const { status } = error;
  if (status === 401 || status === 403) return PAIRING_LOST;
  if (status === 413 || status === 507) return OUT_OF_SPACE;
  // 408/429 are the retryable pair `DirectTransferError.terminal` exempts;
  // they and every 5xx say the same thing to a member: not now.
  if (status === 408 || status === 429 || status >= 500) return UNREACHABLE;
  return REFUSED;
}

/** The raw text, for the log. Never for a screen. */
export function transferFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
