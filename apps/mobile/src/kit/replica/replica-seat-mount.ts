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
import type { NativeSeat } from "../../lib/replica/native-seat";

/** What the provider hands over: its identity and where the file lives. */
export interface ReplicaSeatMountOptions {
  readonly gatewayId: string;
  readonly vaultId: string;
  readonly baseUrl: string;
  /** The module's durable directory; `undefined` means this host has none. */
  readonly storageLocation: string | undefined;
}

/**
 * OPEN THE FILE. Not the copy — the FILE (#996, W5, and this is the ordering
 * the cut got wrong first).
 *
 * The bootstrap is a download and it may take minutes; the OUTBOX cannot wait
 * for it, because a member's first write can happen on the train before the
 * copy has landed and an outbox that waited would put it in memory and lose it
 * on relaunch. `SeatWorkerCore` creates `seat_outbox` when it adopts the file,
 * empty or not, so opening is enough to make the queue durable.
 *
 * The copy still arrives behind the mount: the session syncs in `start`, and
 * until that first sync lands, reads refuse ONLINE_ONLY and run on the
 * gateway's paged door (W4-D2, R9).
 *
 * `undefined` is a host with no durable directory — the seat is then online
 * only, and the caller mounts without one.
 */
export async function openMountSeat(
  options: ReplicaSeatMountOptions
): Promise<NativeSeat | undefined> {
  if (options.storageLocation === undefined) return undefined;
  try {
    // Imported lazily, like `native-hash`: a static import would drag
    // expo-sqlite and expo-file-system into every suite that mounts the
    // provider, and the seat is opened at most once per mount anyway.
    const { NativeSeat } = await import("../../lib/replica/native-seat");
    return await NativeSeat.open({
      gatewayId: options.gatewayId,
      vaultId: options.vaultId,
      baseUrl: options.baseUrl,
      headers: authHeader(),
      storageLocation: options.storageLocation,
      digest: nativeReplicaDigest,
    });
  } catch {
    // A phone whose file will not open has no seat, which the read path
    // answers online-only rather than as an error a screen can act on.
    return undefined;
  }
}
