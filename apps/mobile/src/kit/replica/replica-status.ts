// WHAT THE REPLICA BAR SAYS, and when it says nothing.
//
// Split from ./ReplicaStatusBar for the reason ./home-status is split from
// HomeStatusLine: the copy is the part that can be wrong, so it is the part
// under test, and a pure module needs no renderer to assert it.
//
// The rule this module exists to hold: **a state is only worth a row if a
// member can act on it or is waiting for it.** This bar mounts on roughly
// twenty screens, so anything it says, it says twenty times.
//
// `device-offline` fails that test, and it is the case worth writing down.
// Centraid's vault is a local replica: offline, the library, the documents and
// the counts are exactly what they would be online, because the bytes are
// already on the phone. Announcing it per route made the product's own premise
// read as a fault — and it did so in `--net`, the token DESIGN.md reserves for
// "this LEAVES the device", while offline is precisely when nothing does.
// Google Photos and Apple Photos say nothing here, and their users are not
// confused; a member on a plane knows they are on a plane.
//
// The one consequence that IS real — a change lands later — is carried by the
// pending-changes chip, which appears only once something is actually pending,
// and by Home's ambient status line. Two channels, both conditional, instead of
// four permanent ones.

/**
 * What the replica knows about reaching its gateway.
 *
 * Declared here rather than in ./ReplicaProvider, which re-exports it: this is
 * the module that decides what each state MEANS to a member, and a pure module
 * owning the vocabulary keeps the meaning assertable without a renderer.
 */
export type ReplicaReachability =
  | "current"
  | "device-offline"
  | "gateway-asleep"
  | "syncing";

/**
 * Where a reachability pass LANDS once the pull it started has resolved.
 *
 * `syncing` is set optimistically the moment a gateway base resolves, before
 * the pull is attempted, so every pass must settle somewhere — a pass that
 * settles nowhere leaves "Syncing recent changes…" on screen forever, which is
 * both permanent and untrue. This function exists so that "must settle" is a
 * pinned fact rather than a branch someone can drop from ./ReplicaProvider.
 *
 * A pull we asked for and did not get means the gateway is not answering,
 * whatever the device's own radio reports — hence `gateway-asleep`, the state
 * that offers "Wake help", and never `syncing`.
 */
export function settledReachability(pullLanded: boolean): ReplicaReachability {
  return pullLanded ? "current" : "gateway-asleep";
}

export interface ReplicaStatusRow {
  /** The sentence, or `undefined` when this state earns no row at all. */
  label?: string;
  /** The one action worth offering, when pulling to refresh would not help. */
  action?: string;
  /** Whether the state needs a member to do something. Drives the dot's ink:
   *  `danger` when true, the neutral faint rung otherwise — a red dot beside
   *  "Syncing recent changes…" reads as a failure to sync. */
  actionable: boolean;
}

const SILENT: ReplicaStatusRow = { actionable: false };

/**
 * The row for one reachability state.
 *
 * Two states are deliberately silent. `current` has nothing to report — a
 * settled replica drawing a permanent "Updated 10m ago · Refresh" strip above
 * twenty screens is chrome, not status. `device-offline` has nothing to report
 * either, for the stronger reason in this module's header.
 */
export function replicaStatusRow(
  reachability: ReplicaReachability
): ReplicaStatusRow {
  switch (reachability) {
    case "gateway-asleep":
      // The only state left that a member can fix, and the only one that keeps
      // `danger`: the gateway is a machine of theirs that needs waking.
      return { action: "Wake help", actionable: true, label: "Gateway asleep" };
    case "syncing":
      // Progress, not a problem. It says so because something is arriving that
      // is not here yet — the one honest reason to occupy a row.
      return {
        action: "Sync now",
        actionable: false,
        label: "Syncing recent changes…",
      };
    case "current":
    case "device-offline":
      return SILENT;
  }
}
