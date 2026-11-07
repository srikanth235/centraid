# `contracts/time` — the civil-time corpus

A **frozen golden**, compared in Rust by `crates/vault/tests/time_corpus.rs`. It was captured from the TypeScript tree's civil-time functions before that tree was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020), so it is an independent implementation's answer. **Nothing here is typed by hand, and nothing is regenerated from the Rust side**: a fixture the implementation under test could rewrite proves nothing. A change to these files is a reviewed change in expected behaviour.

| File | Captured functions | What it would falsify |
| --- | --- | --- |
| `rrule-cases.json` | `inspectRrule`, `rruleRefusalMessage`, `canonicalizeRrule`, `describeRecurrence` | that a part this engine cannot honour is REFUSED with the captured sentence, and that a rule has a shape (the vault's `rrule::shape`) exactly where v0 had a sentence; v0's English is no longer asserted (see below) |
| `dst-cases.json` | `expandRecurrence`, `resolveWallTime` | the three DST sentences (with the gap flipped to RFC 5545, below), in six zones including a 30-minute shift, a negative-DST zone and a `:45` offset |
| `occurrence-cases.json` | `occurrenceExceptionsOf`, `overrideAt`, `applyRecurrenceExceptions`, `occurrenceSearchWindow`, `nextOccurrence`, `collapseMissedOccurrences`, `classifyTemporal` | that the occurrence key is `original_start_local` — the series-local wall clock, never the resolved instant (#996 R21, drift ONT-25) |

## The cautionary case, by name

`FREQ=MONTHLY;BYSETPOS=-1` is in `rrule-cases.json` with its refusal and its sentence. It is why the refusal exists: it used to parse as a plain monthly rule and a "last Friday of the month" reminder fired on the wrong date forever.

## Deliberate departures from the capture

The golden is v0's answer, and the vault has widened past it twice: `FREQ=MONTHLY` with one positional `BYDAY` or one `BYMONTHDAY` ([#1119](https://github.com/srikanth235/centraid/issues/1119), R-1119-1), and then every day-or-coarser RFC 5545 rule ([#1173](https://github.com/srikanth235/centraid/issues/1173): `BYDAY` lists and ordinals, `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS` and `WKST`). The cases in `rrule-cases.json` that still record v0's refusal of such a rule are NOT rewritten, and `crates/vault/tests/time_corpus.rs` holds the rules for them:

- `WIDENED_PARTS`: a case v0 refused for one of these parts may now be accepted, and must then have a shape for the one summariser (its words are the core strings'). `crates/vault/tests/rrule_*.rs` pin what each part means.
- `REFUSED_DIFFERENTLY`: a case v0 refused that is still refused, with a sentence that is no longer v0's because v0's words became false (the cautionary `FREQ=MONTHLY;BYSETPOS=-1` stays refused: a lone `BYSETPOS` has nothing to select from) or because the refusal is now exact (`BYWEEKNO` is YEARLY's, `BYYEARDAY` is YEARLY's, a numbered weekday is MONTHLY's and YEARLY's).
- `read_past_in_v0`: a case v0 ACCEPTED by reading past a value it could not read (`COUNT=banana`, `INTERVAL=banana`, `UNTIL=SOON`) and the engine now refuses, naming the part. Unknown parts, a part written twice, and `COUNT` with `UNTIL` are refused the same way (none is in the golden).

Every other refusal sentence still agrees with v0 word for word: `BYHOUR`, `BYMINUTE`, `BYSECOND` and the sub-daily frequencies. `occurrence-cases.json` is untouched and passes: the week now starts on Monday, as RFC 5545 says, which no golden case distinguishes from Sunday.

### Flipped to RFC 5545 (owner decision on #1173)

Two-way sync with EventKit and CalendarContract has to expand exactly the occurrences the phone expands, and both follow RFC 5545 where v0 did not. So the engine's last two departures from the RFC are gone, and `dst-cases.json` was edited to say so (each edited case carries a `flipped` note naming the section and what v0 answered; the new answers are those of an independent implementation, `python-dateutil` over `zoneinfo`, whose `fold=0` is PEP 495's "the offset before the change"):

- **A gap moves forward and counts** (section 3.3.5). 02:30 New York on the spring-forward day is 03:30 EDT, an occurrence like any other, and `COUNT` counts it. v0 skipped it and did not count it. The wall clock stays the exception key (02:30). The fold is unchanged: it occurs once, at the earlier instant. `resolveWallTime` itself (the `wallResolutions`, which return no instant for a gap) is unchanged; each gap probe now also carries `forward`, the RFC's reading, checked against `FireZone::resolve_wall_time_forward`.
- **An implied day is never clamped** (section 3.3.10). Plain `FREQ=MONTHLY` anchored on the 31st skips the months with no 31st, and plain `FREQ=YEARLY` anchored on Feb 29 skips the common years, with `COUNT` counting real occurrences only. v0 clamped to the month's last day. A member who wants "the last day" writes `BYMONTHDAY=-1` (the Custom repeat sheet's "Last day"); the sheet's own default for a weekday position on the 29th to 31st is "last" (`BYDAY=-1FR`), an explicit rule.
- **The summariser's words left the vault.** `rrule-cases.json` keeps v0's `summary` text as provenance, but nothing asserts it: the vault answers a rule's shape (`rrule::shape`) and the one sentence is built in the core strings (`crates/screens`, `agenda::rule_words`), shared with the Custom repeat sheet, so "Daily" is now "Every day" and a count ends `, 4 times`. `crates/screens/tests/agenda_repeat_words.rs` pins the words.
