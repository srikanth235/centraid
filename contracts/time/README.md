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

The first deliberate widening was monthly positional days in [#1119](https://github.com/srikanth235/centraid/issues/1119). Five captured refusals remain frozen and `crates/vault/tests/time_corpus.rs::WIDENED_1119` checks their typed pins and readable summaries. The broader RFC support below names its further departures separately; every other accepted rule and summary must still agree with the original capture.

### RFC expansion in #1173

The vault now accepts all seven RFC 5545 frequencies, standard BY* selectors, positions and WKST. `WIDENED_1173` names every newly accepted captured rule and its readable summary; `REFUSED_1173` names invalid RFC combinations and malformed bounds that now receive specific reasons. No frozen JSON fixture is regenerated. Unknown parts, duplicate parts, invalid dates, `COUNT` with `UNTIL`, ordinal weekdays outside monthly/yearly, and `BYSETPOS` without another selector are refused. A captured non-positive count or interval still safely means one. Invalid text such as `COUNT=banana` and `UNTIL=SOON` cannot become an infinite series.

RFC's default week start is Monday. Plain monthly/yearly repeats now skip absent dates, as explicit month-day selectors already did: January 31 skips February, and February 29 skips non-leap years. The corpus comparison names the two captured anchors affected and compares all surviving captured instants and offsets. New independent expected-date tests in `crates/vault/tests/rrule_rfc.rs` cover RFC examples, week-year boundaries, leap days, subdaily rules, DST gaps/folds, sparse filters, large counts and BYSETPOS without materializing a yearly second grid.

The vault does not represent leap seconds (`BYSECOND=60`), and calendar extensions such as BYEASTER are refused by name. Date-only anchors use daily or coarser frequencies; clock selectors do not turn an all-day date into an instant.
