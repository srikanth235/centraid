// OPENING THE MOUNT'S SEAT, BEHIND IT (#996 waves 4b and 5, ruling W5-D1).
//
// THE SEAT ARRIVES BEHIND THE MOUNT, NEVER IN FRONT OF IT. Its first bootstrap
// is the whole vault file — tens of megabytes over whatever connection the
// phone has — and a member who tapped an icon must not wait for it. Until it
// lands, `ctx.vault.page` is the online-only stub and `session.search` refuses
// ONLINE_ONLY, so every screen behaves exactly as it did before: the query
// runs whole on the gateway's paged door (W4-D2, R9).
//
// WHICH MAKES THIS A RACE WITH TEARDOWN, and that is the whole reason it is a
// module rather than four lines inside the provider's effect. The download
// outlives the mount that started it, so there are two ways to finish — the
// seat is adopted, or it is CLOSED — and a seat left holding its handles is
// the one the next mount would fight over. Both exits are stated here, once.

import { authHeader } from "../../lib/gateway";
import { nativeReplicaDigest } from "../../lib/replica/native-hash";
import type { NativeReplicaSession } from "../../lib/replica/native-session";
import type { NativeSeatPagePort } from "../../lib/replica/seat-port";

/** What the provider hands over: its identity, its scope, and its liveness. */
export interface ReplicaSeatMountOptions {
  readonly gatewayId: string;
  readonly vaultId: string;
  readonly baseUrl: string;
  /** The module's durable directory; `undefined` means this host has none. */
  readonly storageLocation: string | undefined;
  /** The session this seat belongs to, captured non-optional by the caller. */
  readonly session: NativeReplicaSession;
  /** True once the mount that asked for this seat has been torn down. */
  readonly cancelled: () => boolean;
  /** Called with the seat once it is filled, adopted and attached. */
  readonly onOpened: (seat: MountedSeat) => void;
}

/**
 * The half of `NativeSeat` a mount holds: what it PUBLISHES to screens, plus
 * the one verb teardown needs. Structural rather than `NativeSeat` itself so
 * this module does not pull expo-sqlite into the provider's import graph — the
 * lazy `import()` below is the whole point.
 */
export interface MountedSeat extends NativeSeatPagePort {
  close: () => Promise<void>;
}

/**
 * Open this scope's seat, fill it, and hand it back — or hand nothing back.
 *
 * Fire-and-forget by design: it returns immediately and the mount goes on
 * without a copy. A failure is not raised anywhere, because "this phone has no
 * seat yet" is a normal state and not an error a screen can act on.
 */
export function mountReplicaSeat(options: ReplicaSeatMountOptions): void {
  if (options.storageLocation === undefined) return;
  const storageLocation = options.storageLocation;
  // Imported lazily, like `native-hash`: a static import would drag
  // expo-sqlite and expo-file-system into every suite that mounts the
  // provider, and the seat is opened at most once per mount anyway.
  void import("../../lib/replica/native-seat")
    .then(({ openSyncedNativeSeat }) =>
      openSyncedNativeSeat({
        gatewayId: options.gatewayId,
        vaultId: options.vaultId,
        baseUrl: options.baseUrl,
        headers: authHeader(),
        storageLocation,
        digest: nativeReplicaDigest,
      })
    )
    .then((opened) => {
      if (!opened) return;
      if (options.cancelled()) {
        // Hand the handles back: the mount that wanted this file is gone, and
        // expo caches connections by name.
        void opened.close().catch(() => undefined);
        return;
      }
      // SEARCH RUNS ON THE SEAT (W5-D1), so the session has to be told the
      // copy arrived — it holds no seat until this moment.
      options.session.attachSeat(opened);
      options.onOpened(opened);
    })
    .catch(() => undefined);
}
