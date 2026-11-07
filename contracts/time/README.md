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

The golden is v0's answer, and the vault has widened past it twice: `FREQ=MONTHLY` with one positional `BYDAY` or one `BYMONTHDAY` ([#1119](https://github.com/srikanth235/centraid/issues/1119), R-1119-1), and then every day-or-coarser RFC 5545 rule ([#1173](https://github.com/srikanth235/centraid/issues/1173): `BYDAY` lists and ordinals, `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS` and `WKST`). The cases in `rrule-cases.json` that still record v0's refusal of such a rule are NOT rewritten, and `crates/vault/tests/time_corpus.rs` holds the rules for them:

- `WIDENED_PARTS`: a case v0 refused for one of these parts may now be accepted, and must then have a sentence from the one summariser. `crates/vault/tests/rrule_*.rs` pin what each part means.
- `REFUSED_DIFFERENTLY`: a case v0 refused that is still refused, with a sentence that is no longer v0's because v0's words became false (the cautionary `FREQ=MONTHLY;BYSETPOS=-1` stays refused: a lone `BYSETPOS` has nothing to select from) or because the refusal is now exact (`BYWEEKNO` is YEARLY's, `BYYEARDAY` is YEARLY's, a numbered weekday is MONTHLY's and YEARLY's).
- `read_past_in_v0`: a case v0 ACCEPTED by reading past a value it could not read (`COUNT=banana`, `INTERVAL=banana`, `UNTIL=SOON`) and the engine now refuses, naming the part. Unknown parts, a part written twice, and `COUNT` with `UNTIL` are refused the same way (none is in the golden).

Every other refusal sentence still agrees with v0 word for word: `BYHOUR`, `BYMINUTE`, `BYSECOND` and the sub-daily frequencies. The expansion goldens (`dst-cases.json`, `occurrence-cases.json`) are untouched and pass: the week now starts on Monday, as RFC 5545 says, which no golden case distinguishes from Sunday.
