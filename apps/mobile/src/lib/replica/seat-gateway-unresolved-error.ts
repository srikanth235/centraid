/**
 * THE MOUNT HAS NO GATEWAY ID YET (#1014, P14 / ruling R-1014-11).
 *
 * A seat file is named `(gatewayId, vaultId)`. Until #1014 a mount with no
 * gateway id took the literal `"manual"` for one, opened a file under that
 * name, and queued the member's writes into ITS outbox — and then, the moment
 * a real endpoint id arrived, `noteActiveIdentity` rewrote the link and the
 * file path moved with it. Every write in the old file was orphaned: undrained,
 * unreported, and invisible to storage accounting.
 *
 * So a mount either resolves its gateway id before it names a file, or it
 * refuses. This is that refusal, and it is a WAITING state rather than a
 * failure: the gateway has not been reached yet, nothing is wrong with the
 * device, and the next reachability wake retries.
 */
export class SeatGatewayUnresolvedError extends Error {
  override readonly name = "SeatGatewayUnresolvedError";
  readonly code = "seat_gateway_unresolved";

  constructor() {
    super(
      "Connecting to your Centraid desktop — this vault opens once the gateway names itself."
    );
  }
}
