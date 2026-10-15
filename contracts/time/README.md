# `contracts/time` — the civil-time corpus

A **frozen golden**, compared in Rust by `crates/vault/tests/time_corpus.rs`. It was captured from the TypeScript tree's civil-time functions before that tree was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020), so it is an independent implementation's answer. **Nothing here is typed by hand, and nothing is regenerated from the Rust side**: a fixture the implementation under test could rewrite proves nothing. A change to these files is a reviewed change in expected behaviour.

| File | Captured functions | What it would falsify |
| --- | --- | --- |
| `rrule-cases.json` | `inspectRrule`, `rruleRefusalMessage`, `canonicalizeRrule`, `describeRecurrence` | that a part this engine cannot honour is REFUSED with the captured sentence, and that the one summariser says the captured words |
| `dst-cases.json` | `expandRecurrence`, `resolveWallTime` | the three DST sentences, in six zones including a 30-minute shift, a negative-DST zone and a `:45` offset |
| `occurrence-cases.json` | `occurrenceExceptionsOf`, `overrideAt`, `applyRecurrenceExceptions`, `occurrenceSearchWindow`, `nextOccurrence`, `collapseMissedOccurrences`, `classifyTemporal` | that the occurrence key is `original_start_local` — the series-local wall clock, never the resolved instant (#996 R21, drift ONT-25) |

## The cautionary case, by name

`FREQ=MONTHLY;BYSETPOS=-1` is in `rrule-cases.json` with its refusal and its sentence. It is why the refusal exists: it used to parse as a plain monthly rule and a "last Friday of the month" reminder fired on the wrong date forever.

## Deliberate departures from the capture

The golden is v0's answer, and the vault has widened one thing past it: `FREQ=MONTHLY` with one positional `BYDAY` or one `BYMONTHDAY` is accepted ([#1119](https://github.com/srikanth235/centraid/issues/1119), R-1119-1). Five cases in `rrule-cases.json` still record v0's refusal of such a rule; they are NOT rewritten, and `crates/vault/tests/time_corpus.rs::WIDENED_1119` names each with the pin and the sentence this build must give instead. A case outside that table has to agree with v0. Two refusal sentences changed with that widening: v0's `BYDAY` sentence said a positional day could never be honoured, and its `BYMONTHDAY` sentence that the expander only steps from the anchor day, both now false for a MONTHLY rule. The golden keeps v0's words; `time_corpus.rs::REWORDED_1119` holds them, asserts the golden still says them, and asserts this build's sentence differs and names what the subset takes. Every other refusal sentence still agrees with v0 word for word.
