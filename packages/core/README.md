# `@centraid/core`

Dependency-free shared contracts for Centraid clients and the backend.

Subpath exports — there is no root barrel:

| Subpath | What it is |
| --- | --- |
| `@centraid/core/protocol` | Wire types, route constants, handshake, capability map |
| `@centraid/core/blob` | CBSF wire-format constants and codecs |
| `@centraid/core/time` | IANA wall-clock resolution and RRULE recurrence |

Every subpath carries a `react-native` export condition pointing at `src/`. The package has no runtime dependencies; `zero-dep-guard.ts` fails if one appears.

Formerly published as `@centraid/protocol`, `@centraid/blob-format`, and `@centraid/time-engine`.
