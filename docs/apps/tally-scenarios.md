# Tally scenario × layer contract

Instance of [docs/app-scenario-layer-template.md](../app-scenario-layer-template.md).

- **App**: Tally · **north star**: Splitwise ([docs/blueprint-seats.md](../blueprint-seats.md#north-stars)).
- **Seat class**: `record-only`.
- **Graduation issue**: none — Tally's rendered surface is **held** on every seat pending a ground-up redesign ([#831](https://github.com/srikanth235/centraid/issues/831)). The app.json doors stay live; the interface does not.
- **Journey ownership**: none, while held.
- **Structural exclusions**: every designed state is `held` in `tests/matrix.json#appStates`; every seat is `skip` in `#appSeats`, citing #831.

| Tally scenario | U | C | E | Owner / evidence |
| --- | --- | --- | --- | --- |
| rendered interface | — | — | — | **held** (#831): no scenario can own a surface that is not drawn |
