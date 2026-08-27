// THE SCANNER'S LOCKER DESTINATION, and the one rule it must not forget.
//
// A scanned card carries a CARD NUMBER, which is a secret — so this write is
// online only: `writes.ts`'s `ONLINE_ONLY_ACTIONS` names `add-item`, and the
// native session's online-only door posts it straight to the app's handler
// rather than enqueueing it (`lib/replica/native-session.ts`). There is no
// branch here that falls back to the durable outbox, and that absence is the
// whole point: the outbox outlives the process, and a secret in it has left
// the memory-only world the app promised.
//
// It lives beside `Scan.tsx` rather than inside it for the same reason
// `scan-consent.ts` and `scan-ui.tsx` do — the screen is a flow, and each
// destination's payload is a table. The frame may not import an app
// (`scripts/check-import-boundaries.ts`), so the payload is built here from
// the fields the OCR pass produced.

import type {
  MobileReplicaSession,
  NativeWriteResult,
} from "../lib/replica/native-session";

/** What the OCR pass read off the card. Every field may be absent — the
 *  scanner reports what it found, never a guess. */
export interface ScannedCard {
  cardholder: string;
  cardNumber: string;
  expiry: string;
}

/** The memo the item carries. Stated, because a member finding this row later
 *  should know where it came from and that the photograph did not follow. */
export const SCANNED_CARD_NOTE =
  "Captured on device by OCR — the source image was never stored in Locker.";

/** The title a scan gives a card when the receipt named a merchant. */
export const SCANNED_CARD_TITLE = "Scanned card";

export function saveScannedCard(
  session: MobileReplicaSession,
  card: ScannedCard,
  title: string
): Promise<NativeWriteResult> {
  return session.write("locker", {
    action: "add-item",
    onlineOnly: true,
    input: {
      type: "card",
      title: title || SCANNED_CARD_TITLE,
      tags: ["scan"],
      cardholder: card.cardholder,
      card_number: card.cardNumber,
      expiry: card.expiry,
      notes: SCANNED_CARD_NOTE,
    },
  });
}
