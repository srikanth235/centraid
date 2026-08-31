// THE ALARM TEST (#890 W6) — mutation testing for the device layer.
//
// Every other gate in this repo answers "does the product still work?". This one
// answers the question no green run can: "would this suite notice if it did
// not?". Six mobile flows were once green while observing nothing (#474/#478/
// #483), and the only reason anybody found out was a human reading the YAML. A
// suite that cannot be shown to go red is not evidence, it is a habit.
//
// So a scheduled lane builds the app with ONE surface deliberately blanked and
// requires the suite to FAIL. A green run there is the alarm not sounding, and
// it fails the job.
//
// WHY THIS LIVES IN PRODUCTION SOURCE, AND WHY THAT IS SAFE. The mutation has to
// be in the artifact the suite drives, or it proves nothing about that artifact:
// a mutant injected by the test harness would only prove the harness can inject
// mutants. `EXPO_PUBLIC_*` is inlined by Metro at export time, so this is a
// build-time constant — the branch is statically false and dead-code-eliminated
// in every build that does not set the flag, which is every store build and
// every ordinary CI build. It is the same mechanism, with the same reasoning, as
// the frame probe's `EXPO_PUBLIC_CENTRAID_FRAME_PROBE` (#890 W1).
//
// THE FLAG NAMES ONE SURFACE, never "on". A boolean would let a future edit
// blank whatever it liked; naming the surface keeps the mutation reviewable and
// keeps the lane's expected failure attributable to a specific screen.

/** Surfaces the alarm lane may blank. Closed on purpose — see the header. */
export const ALARM_SURFACES = ["home", "photos-grid", "notes-library"] as const;

export type AlarmSurface = (typeof ALARM_SURFACES)[number];

/**
 * The surface this build blanks, or `null` in every ordinary build.
 *
 * Read once at module scope: it is a build-time constant, and re-reading it per
 * render would suggest it can change.
 */
const BLANKED: AlarmSurface | null = (() => {
  const requested = process.env.EXPO_PUBLIC_CENTRAID_E2E_ALARM;
  if (!requested) return null;
  // An unrecognised value is `null`, not a crash and not a wildcard. A typo in
  // the lane's env must make the alarm NOT sound — which fails the alarm lane
  // loudly — rather than blanking something nobody named.
  return (ALARM_SURFACES as readonly string[]).includes(requested)
    ? (requested as AlarmSurface)
    : null;
})();

/**
 * Is this surface deliberately blanked for the alarm lane?
 *
 * Call it at the top of a screen's render and return `null` when it answers
 * true. Do not use it to blank a *part* of a screen: a partial mutation can be
 * survived by a flow that happens to assert the other part, and the lane would
 * then report a green that means nothing.
 */
export function isAlarmBlanked(surface: AlarmSurface): boolean {
  return BLANKED === surface;
}
