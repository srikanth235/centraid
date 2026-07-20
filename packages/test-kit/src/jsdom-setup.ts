// React 18+ reads this global to decide whether it is running under a test
// renderer. Testing Library wraps `render`/`fireEvent` in `act()` internally,
// and React prints "The current testing environment is not configured to
// support act(...)" on every such call when the flag is unset.
//
// The warning is not cosmetic. Outside act mode React does not flush updates on
// the schedule the tests assume, and the companion "not wrapped in act"
// diagnostics are suppressed rather than surfaced — so an async state update
// that never settles reads as a pass. Setting it here, once, for every jsdom
// project is what makes those tests assert against a settled tree.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
