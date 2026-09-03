import type {
  MobileReplicaSession,
  NativeWriteResult,
} from "../lib/replica/native-session";

export interface ScannedCard {
  cardholder: string;
  cardNumber: string;
  expiry: string;
}

export const SCANNED_CARD_NOTE =
  "Captured on device by OCR — the source image was never stored in Locker.";

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
